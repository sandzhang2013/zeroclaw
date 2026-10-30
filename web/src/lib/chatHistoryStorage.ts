import { writeLocalStorage } from './localStorageWrite.ts';
import type { SessionMessageRow } from '../types/api.ts';
import { generateUUID } from './uuid.ts';
import type { ToolArtifactInfo } from './artifactKind.ts';
import { splitChatHtmlBlocks } from './chatHtmlPreview.ts';
import { normalizeTurnContent } from './turnFeedback.ts';

const MAX_MESSAGES = 100;
const PREFIX = 'zeroclaw_chat_history_v1:';
/** All `zeroclaw_chat_history_v1:` values together. The origin quota is about 5MB. */
export const CHAT_HISTORY_BUDGET_CHARS = 1_000_000;
const TOOL_OUTPUT_CAP = 4_096;

export type ChatHistoryCacheMode = 'transcript' | 'thinking';

export interface PersistedChatBubble {
  id: string;
  role: 'user' | 'agent';
  content: string;
  /** Set on a thinking sidecar. The body stays on the server. */
  contentHash?: string;
  /** First 400 collapsed characters of the original reply, for like/dislike keys. */
  contentPreview?: string;
  thinking?: string;
  /** Whole seconds the thinking stream ran, measured in the browser. */
  thinkingSeconds?: number;
  markdown?: boolean;
  /** Verbatim locally-composed user input — never gateway-prefixed, so the
   *  bubble skips stripServerTimestamp for it. (Server rows omit this.) */
  local?: boolean;
  toolCall?: { name: string; args?: unknown; output?: string; artifact?: ToolArtifactInfo };
  timestamp: string;
}

function storageKey(sessionId: string): string {
  return `${PREFIX}${sessionId}`;
}

export function loadChatHistory(sessionId: string): PersistedChatBubble[] {
  try {
    const raw = localStorage.getItem(storageKey(sessionId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { messages?: PersistedChatBubble[] };
    if (!parsed.messages?.length) return [];
    return parsed.messages;
  } catch {
    return [];
  }
}

/** Rows that can paint a conversation. Thinking sidecars carry no body. */
export function loadCachedTranscript(sessionId: string): PersistedChatBubble[] {
  return loadChatHistory(sessionId).filter((row) => !row.contentHash && Boolean(row.content.trim() || row.toolCall));
}

/**
 * Mirror a conversation into localStorage.
 *
 * `thinking` keeps the reasoning stream the server does not store, a short
 * reply preview for ratings, and locally composed prompts the server has not
 * committed yet. Reply bodies stay on the gateway. `transcript` is the offline copy: HTML report
 * fences and bulky tool payloads are left out. Either way the keys stay inside
 * `CHAT_HISTORY_BUDGET_CHARS`, oldest conversation first.
 */
export function saveChatHistory(
  sessionId: string,
  messages: PersistedChatBubble[],
  mode: ChatHistoryCacheMode = 'transcript',
): void {
  const prepared = fitToBudget(cacheRows(messages, mode));
  const key = storageKey(sessionId);
  const raw = JSON.stringify({ messages: prepared });
  evictUntilFit(key, raw);
  writeLocalStorage(key, raw);
}

/**
 * Drop a conversation's cached transcript.
 *
 * Deleting a conversation has to take the local copy with it: the cache is
 * readable in the browser long after the gateway row is gone, which is not what
 * "delete" promises, and one key per conversation would otherwise accumulate
 * for as long as the origin's storage lives.
 */
export function removeChatHistory(sessionId: string): void {
  try {
    localStorage.removeItem(storageKey(sessionId));
  } catch {
    // Private mode — nothing was cached to begin with.
  }
}

/** Workbench alias for `removeChatHistory`. */
export function clearChatHistory(sessionId: string): void {
  removeChatHistory(sessionId);
}

/** Map server-persisted rows into UI messages (timestamps are synthetic for ordering). */
export function mapServerMessagesToPersisted(rows: SessionMessageRow[]): PersistedChatBubble[] {
  const base = Date.now() - rows.length * 1000;
  const out: PersistedChatBubble[] = [];
  let idx = 0;
  for (const row of rows) {
    if (row.role === 'system') continue;
    const ts = new Date(base + idx * 1000).toISOString();
    idx += 1;
    if (row.role === 'user') {
      out.push({
        id: generateUUID(),
        role: 'user',
        content: row.content,
        timestamp: ts,
      });
    } else if (row.role === 'assistant') {
      out.push({
        id: generateUUID(),
        role: 'agent',
        content: row.content,
        markdown: true,
        timestamp: ts,
      });
    } else {
      out.push({
        id: generateUUID(),
        role: 'agent',
        content: row.content,
        markdown: false,
        timestamp: ts,
      });
    }
  }
  return out;
}

/** Fingerprint a reply so the thinking sidecar can find it without storing the body. */
export function contentFingerprint(text: string): string {
  let a = 2166136261;
  let b = 2166136261 ^ 0x9e3779b9;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 16777619);
    b = Math.imul(b ^ code, 2246822519);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** Copy thinking back onto the server row with the same reply. The gateway does not store it. */
export function mergePersistedThinking(
  server: PersistedChatBubble[],
  local: PersistedChatBubble[],
): PersistedChatBubble[] {
  const pool = local.filter((row) => row.role === 'agent' && row.thinking);
  return server.map((row) => {
    if (row.role !== 'agent' || row.thinking) return row;
    const fingerprint = contentFingerprint(row.content);
    const index = pool.findIndex((cached) =>
      (cached.contentHash !== undefined && cached.contentHash === fingerprint)
      || (cached.content.length > 0 && cached.content === row.content));
    const match = index < 0 ? undefined : pool.splice(index, 1)[0];
    if (!match?.thinking) return row;
    return {
      ...row,
      thinking: match.thinking,
      thinkingSeconds: match.thinkingSeconds,
    };
  });
}

function cacheRows(messages: PersistedChatBubble[], mode: ChatHistoryCacheMode): PersistedChatBubble[] {
  const slice = messages.slice(-MAX_MESSAGES);
  if (mode === 'thinking') return thinkingSidecar(slice);
  return slice.flatMap((row) => {
    const slim = slimTranscriptRow(row);
    return slim ? [slim] : [];
  });
}

function thinkingSidecar(messages: PersistedChatBubble[]): PersistedChatBubble[] {
  const out: PersistedChatBubble[] = [];
  for (const row of messages) {
    // A prompt the browser composed is not on the server until the turn ends.
    // Keep it so a reload during that turn can put it back. Other user rows
    // are already in the gateway transcript and are not copied here.
    if (row.role === 'user' && row.local === true && row.content.trim()) {
      out.push({
        id: row.id,
        role: 'user',
        content: row.content,
        local: true,
        timestamp: row.timestamp,
      });
      continue;
    }
    if (row.role !== 'agent') continue;
    const thinking = row.thinking?.trim();
    const preview = row.toolCall ? '' : normalizeTurnContent(row.content);
    if (!thinking && !preview) continue;
    out.push({
      id: row.id,
      role: 'agent',
      content: '',
      contentHash: contentFingerprint(row.content),
      ...(preview ? { contentPreview: preview } : {}),
      ...(thinking ? { thinking: row.thinking } : {}),
      ...(thinking && row.thinkingSeconds != null ? { thinkingSeconds: row.thinkingSeconds } : {}),
      ...(row.toolCall ? { toolCall: { name: row.toolCall.name } } : {}),
      timestamp: row.timestamp,
    });
  }
  return out;
}

function slimTranscriptRow(row: PersistedChatBubble): PersistedChatBubble | null {
  const content = splitChatHtmlBlocks(row.content).markdown;
  const preview = normalizeTurnContent(row.content);
  const thinking = row.thinking?.trim() ? row.thinking : undefined;
  const toolCall = row.toolCall ? slimToolCall(row.toolCall) : undefined;
  if (!content && !thinking && !toolCall) return null;
  return {
    id: row.id,
    role: row.role,
    content,
    ...(preview ? { contentPreview: preview } : {}),
    ...(thinking ? { thinking: row.thinking } : {}),
    ...(thinking && row.thinkingSeconds != null ? { thinkingSeconds: row.thinkingSeconds } : {}),
    ...(row.markdown != null ? { markdown: row.markdown } : {}),
    ...(row.local ? { local: true } : {}),
    ...(toolCall ? { toolCall } : {}),
    timestamp: row.timestamp,
  };
}

function slimToolCall(
  toolCall: NonNullable<PersistedChatBubble['toolCall']>,
): NonNullable<PersistedChatBubble['toolCall']> {
  const output = toolCall.output ? toolCall.output.slice(0, TOOL_OUTPUT_CAP) : undefined;
  return {
    name: toolCall.name,
    ...(output ? { output } : {}),
    ...(toolCall.artifact ? { artifact: toolCall.artifact } : {}),
  };
}

function envelope(messages: PersistedChatBubble[]): string {
  return JSON.stringify({ messages });
}

function fitToBudget(messages: PersistedChatBubble[]): PersistedChatBubble[] {
  let rows = messages;
  while (rows.length > 1 && envelope(rows).length > CHAT_HISTORY_BUDGET_CHARS) {
    rows = rows.slice(1);
  }
  const only = rows[0];
  if (!only || envelope(rows).length <= CHAT_HISTORY_BUDGET_CHARS) return rows;
  const capped: PersistedChatBubble = {
    ...only,
    content: only.content.slice(0, 32_000),
    ...(only.thinking ? { thinking: only.thinking.slice(0, 32_000) } : {}),
    toolCall: only.toolCall
      ? {
          name: only.toolCall.name,
          ...(only.toolCall.artifact ? { artifact: only.toolCall.artifact } : {}),
          ...(only.toolCall.output ? { output: only.toolCall.output.slice(0, TOOL_OUTPUT_CAP) } : {}),
        }
      : undefined,
  };
  return [capped];
}

function historySavedAt(raw: string | null): string {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as { messages?: PersistedChatBubble[] };
    const last = parsed.messages?.at(-1)?.timestamp;
    return typeof last === 'string' ? last : '';
  } catch {
    return '';
  }
}

function historyKeyList(): string[] {
  try {
    if (typeof localStorage.key !== 'function' || typeof localStorage.length !== 'number') return [];
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    return keys;
  } catch {
    return [];
  }
}

function evictUntilFit(nextKey: string, nextRaw: string): void {
  const others = historyKeyList()
    .filter((key) => key !== nextKey)
    .map((key) => {
      let raw: string | null = null;
      try {
        raw = localStorage.getItem(key);
      } catch {
        raw = null;
      }
      return { key, size: raw?.length ?? 0, savedAt: historySavedAt(raw) };
    })
    .sort((a, b) => a.savedAt.localeCompare(b.savedAt) || a.key.localeCompare(b.key));
  let total = nextRaw.length + others.reduce((sum, item) => sum + item.size, 0);
  for (const item of others) {
    if (total <= CHAT_HISTORY_BUDGET_CHARS) return;
    try {
      localStorage.removeItem(item.key);
    } catch {
      // A locked key stays. The write below still has to succeed or be ignored.
    }
    total -= item.size;
  }
}

export function persistedToUiMessages(
  rows: PersistedChatBubble[],
): Array<{
  id: string;
  role: 'user' | 'agent';
  content: string;
  thinking?: string;
  thinkingSeconds?: number;
  markdown?: boolean;
  local?: boolean;
  toolCall?: { name: string; args?: unknown; output?: string; artifact?: ToolArtifactInfo };
  timestamp: Date;
}> {
  return rows.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    thinking: m.thinking,
    thinkingSeconds: m.thinkingSeconds,
    markdown: m.markdown,
    local: m.local,
    toolCall: m.toolCall,
    timestamp: new Date(m.timestamp),
  }));
}

export function uiMessagesToPersisted(
  messages: Array<{
    id: string;
    role: 'user' | 'agent';
    content: string;
    thinking?: string;
    thinkingSeconds?: number;
    markdown?: boolean;
    local?: boolean;
    ephemeral?: boolean;
    toolCall?: { name: string; args?: unknown; output?: string; artifact?: ToolArtifactInfo };
    timestamp: Date;
  }>,
): PersistedChatBubble[] {
  return messages
    // Skip messages flagged `ephemeral: true` (web slash-command output like
    // /help, /model banners, unknown-command notices). They are throwaway UI
    // feedback and must not be re-hydrated as fake assistant replies on reload. #7137
    .filter((m) => !m.ephemeral)
    .map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      thinking: m.thinking,
      thinkingSeconds: m.thinkingSeconds,
      markdown: m.markdown,
      // Preserve the verbatim-user-input flag so reloaded bubbles still skip
      // server-timestamp stripping.
      local: m.local,
      toolCall: m.toolCall,
      timestamp: m.timestamp.toISOString(),
    }));
}
