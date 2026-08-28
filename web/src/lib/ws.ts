import type { ApprovalDecision, WsMessage } from '../types/api';
import { getToken } from './auth';
import { apiOrigin, basePath } from './basePath';
import { isTauri } from './tauri';
import { generateUUID } from './uuid';
import { SESSION_ID_KEY_PREFIX, getOrCreateSessionId } from './sessionId';
import { releaseWebSocket } from './ws.release';

export { getOrCreateSessionId, releaseWebSocket };

export type WsMessageHandler = (msg: WsMessage) => void;
export type WsOpenHandler = () => void;
export type WsCloseHandler = (ev: CloseEvent) => void;
export type WsErrorHandler = (ev: Event) => void;

export interface WebSocketClientOptions {
  /** Agent alias to bind this socket to (required by the gateway). */
  agentAlias: string;
  /** Explicit session ID. When omitted the default per-agent session is used. */
  sessionId?: string;
  /** Base URL override. Defaults to current host with ws(s) protocol. */
  baseUrl?: string;
  /** Delay in ms before attempting reconnect. Doubles on each failure up to maxReconnectDelay. */
  reconnectDelay?: number;
  /** Maximum reconnect delay in ms. */
  maxReconnectDelay?: number;
  /** Set to false to disable auto-reconnect. Default true. */
  autoReconnect?: boolean;
}

const DEFAULT_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30000;

// ── Multi-task session management ──────────────────────────────────────

const TASK_SESSION_PREFIX = `${SESSION_ID_KEY_PREFIX}.task`;
const TASK_INDEX_PREFIX = `${SESSION_ID_KEY_PREFIX}.tasks`;

interface TaskSessionEntry {
  taskId: string;
  sessionId: string;
  agentAlias: string;
  createdAt: string;
}

/** Create a new independent task session for the given agent. Returns the
 * short taskId (first 8 chars of a UUID) usable as a UI label. The
 * underlying session_id is a full UUID stored in localStorage. */
export function createTaskSessionId(agentAlias: string): string {
  const taskId = generateUUID().slice(0, 8);
  const sessionId = generateUUID();
  const key = `${TASK_SESSION_PREFIX}.${agentAlias}.${taskId}`;
  localStorage.setItem(key, sessionId);

  // Register in the per-agent task index.
  const index = listTaskSessions(agentAlias);
  const entry: TaskSessionEntry = {
    taskId,
    sessionId,
    agentAlias,
    createdAt: new Date().toISOString(),
  };
  index.push(entry);
  localStorage.setItem(`${TASK_INDEX_PREFIX}.${agentAlias}`, JSON.stringify(index));

  return taskId;
}

/** Bind an existing gateway session UUID to a workbench task tab so a
 * conversation that lives in SQLite but is missing from the sidebar can
 * reopen. Returns the short taskId. Idempotent for the same UUID. */
export function adoptTaskSession(agentAlias: string, sessionId: string): string {
  const existing = listTaskSessions(agentAlias).find((e) => e.sessionId === sessionId);
  if (existing) return existing.taskId;
  const taskId = generateUUID().slice(0, 8);
  localStorage.setItem(`${TASK_SESSION_PREFIX}.${agentAlias}.${taskId}`, sessionId);
  const index = listTaskSessions(agentAlias);
  index.push({
    taskId,
    sessionId,
    agentAlias,
    createdAt: new Date().toISOString(),
  });
  localStorage.setItem(`${TASK_INDEX_PREFIX}.${agentAlias}`, JSON.stringify(index));
  return taskId;
}

/** Resolve the session_id for a given task, or null if the task doesn't
 * exist. */
export function resolveTaskSessionId(agentAlias: string, taskId: string): string | null {
  const key = `${TASK_SESSION_PREFIX}.${agentAlias}.${taskId}`;
  return localStorage.getItem(key);
}

/** List all task sessions for an agent. Returns entries sorted oldest-first. */
export function listTaskSessions(agentAlias: string): TaskSessionEntry[] {
  const raw = localStorage.getItem(`${TASK_INDEX_PREFIX}.${agentAlias}`);
  if (!raw) return [];
  try {
    const entries = JSON.parse(raw) as TaskSessionEntry[];
    // Filter out entries whose session key no longer exists (cleaned up).
    return entries.filter((e) => {
      const key = `${TASK_SESSION_PREFIX}.${agentAlias}.${e.taskId}`;
      return localStorage.getItem(key) !== null;
    });
  } catch {
    return [];
  }
}

/** Remove a task session and its associated chat history from localStorage. */
export function removeTaskSession(agentAlias: string, taskId: string): void {
  const sessionKey = `${TASK_SESSION_PREFIX}.${agentAlias}.${taskId}`;
  const sessionId = localStorage.getItem(sessionKey);
  localStorage.removeItem(sessionKey);

  // Clean up chat history for this session.
  if (sessionId) {
    localStorage.removeItem(`zeroclaw_chat_history_v1:${sessionId}`);
  }

  // Remove from the index.
  const index = listTaskSessions(agentAlias).filter((e) => e.taskId !== taskId);
  if (index.length > 0) {
    localStorage.setItem(`${TASK_INDEX_PREFIX}.${agentAlias}`, JSON.stringify(index));
  } else {
    localStorage.removeItem(`${TASK_INDEX_PREFIX}.${agentAlias}`);
  }
}

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private currentDelay: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosed = false;

  public onMessage: WsMessageHandler | null = null;
  public onOpen: WsOpenHandler | null = null;
  public onClose: WsCloseHandler | null = null;
  public onError: WsErrorHandler | null = null;

  private readonly agentAlias: string;
  private readonly sessionId: string;
  private readonly baseUrl: string;
  private readonly reconnectDelay: number;
  private readonly maxReconnectDelay: number;
  private readonly autoReconnect: boolean;

  constructor(options: WebSocketClientOptions) {
    this.agentAlias = options.agentAlias;
    this.sessionId = options.sessionId ?? getOrCreateSessionId(this.agentAlias);
    let defaultBase: string;
    if (isTauri() && apiOrigin) {
      // In Tauri, derive ws URL from the gateway origin.
      defaultBase = apiOrigin.replace(/^http/, 'ws');
    } else {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      defaultBase = `${protocol}//${window.location.host}`;
    }
    this.baseUrl = options.baseUrl ?? defaultBase;
    this.reconnectDelay = options.reconnectDelay ?? DEFAULT_RECONNECT_DELAY;
    this.maxReconnectDelay = options.maxReconnectDelay ?? MAX_RECONNECT_DELAY;
    this.autoReconnect = options.autoReconnect ?? true;
    this.currentDelay = this.reconnectDelay;
  }

  /** Open the WebSocket connection. */
  connect(): void {
    this.intentionallyClosed = false;
    this.clearReconnectTimer();

    const token = getToken();
    const params = new URLSearchParams();
    if (token) params.set('token', token);
    params.set('session_id', this.sessionId);
    params.set('agent', this.agentAlias);
    const url = `${this.baseUrl}${basePath}/ws/chat?${params.toString()}`;

    const protocols: string[] = ['zeroclaw.v1'];
    if (token) protocols.push(`bearer.${token}`);
    this.ws = new WebSocket(url, protocols);

    this.ws.onopen = () => {
      this.currentDelay = this.reconnectDelay;
      this.onOpen?.();
    };

    this.ws.onmessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(ev.data) as WsMessage;
        this.onMessage?.(msg);
      } catch {
        // Ignore non-JSON frames
      }
    };

    this.ws.onclose = (ev: CloseEvent) => {
      this.onClose?.(ev);
      this.scheduleReconnect();
    };

    this.ws.onerror = (ev: Event) => {
      this.onError?.(ev);
    };
  }

  /** Send a chat message to the agent. */
  sendMessage(content: string, autonomy?: 'readonly' | 'supervised' | 'full'): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }
    const payload: { type: 'message'; content: string; autonomy?: string } = {
      type: 'message',
      content,
    };
    if (autonomy) payload.autonomy = autonomy;
    this.ws.send(JSON.stringify(payload));
  }

  /**
   * Reply to a supervised-mode tool `approval_request`. The backend matches
   * the response by `request_id` and resolves the parked approval oneshot.
   * If the socket is closed the request will auto-deny on the server side
   * after the timeout, so we silently no-op rather than throwing.
   */
  sendApprovalResponse(requestId: string, decision: ApprovalDecision): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({ type: 'approval_response', request_id: requestId, decision }),
    );
  }

  /** Close the connection without auto-reconnecting. */
  disconnect(): void {
    this.intentionallyClosed = true;
    this.clearReconnectTimer();
    if (this.ws) {
      releaseWebSocket(this.ws);
      this.ws = null;
    }
  }

  /** Returns true if the socket is open. */
  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ---------------------------------------------------------------------------
  // Reconnection logic
  // ---------------------------------------------------------------------------

  private scheduleReconnect(): void {
    if (this.intentionallyClosed || !this.autoReconnect) return;

    this.reconnectTimer = setTimeout(() => {
      this.currentDelay = Math.min(this.currentDelay * 2, this.maxReconnectDelay);
      this.connect();
    }, this.currentDelay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
