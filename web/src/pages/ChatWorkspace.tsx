import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GripVertical } from 'lucide-react';
import { AgentProvider } from '@/contexts/AgentContext';
import { AgentChatInner, type AgentChatStatus } from '@/pages/AgentChat';
import { WorkbenchSidebar, type SessionIndicator } from '@/components/WorkbenchSidebar';
import { ResultsPanel } from '@/components/ResultsPanel';
import {
  createTaskSessionId,
  removeTaskSession,
} from '@/lib/ws';
import { generateUUID } from '@/lib/uuid';
import { basePath } from '@/lib/basePath';
import { t } from '@/lib/i18n';

const SIDEBAR_COLLAPSED_KEY = 'zeroclaw-workbench-sidebar-collapsed';
const RIGHT_COLLAPSED_KEY = 'zeroclaw-workbench-right-collapsed';
const RIGHT_PCT_KEY = 'zeroclaw-workbench-right-pct';

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === '1') return true;
    if (raw === '0') return false;
  } catch { /* noop */ }
  return fallback;
}

function readPct(key: string, fallback: number): number {
  try {
    const n = Number(localStorage.getItem(key));
    if (Number.isFinite(n) && n >= 30 && n <= 70) return n;
  } catch { /* noop */ }
  return fallback;
}

const STORAGE_KEY = 'zeroclaw-chat-workspace-v3';
export const DEFAULT_FOLDER_ID = 'default';

export interface WorkbenchFolder {
  id: string;
  name: string;
}

/** One conversation = one agent + one independent session, filed under a folder. */
export interface WorkbenchSession {
  id: string;
  agentAlias: string;
  taskId: string;
  folderId: string;
  title?: string;
}

interface PersistedStateV1 {
  openChats?: string[];
  activeAlias?: string;
}

interface PersistedStateV2 {
  tasks: Array<{ id: string; agentAlias: string; taskId: string }>;
  activeTabId: string;
}

interface PersistedStateV3 {
  folders: WorkbenchFolder[];
  sessions: WorkbenchSession[];
  activeSessionId: string;
}

interface PaneStatus {
  lastSeenCount: number;
  liveCount: number;
  streaming: boolean;
  unread: boolean;
}

function makeSessionId(agentAlias: string, taskId: string): string {
  return `${agentAlias}::${taskId}`;
}

function makeDefaultSession(agentAlias: string, folderId = DEFAULT_FOLDER_ID): WorkbenchSession {
  const taskId = '__default__';
  return { id: makeSessionId(agentAlias, taskId), agentAlias, taskId, folderId };
}

function defaultFolders(): WorkbenchFolder[] {
  return [{ id: DEFAULT_FOLDER_ID, name: '' }];
}

function dedupeSessions(sessions: WorkbenchSession[]): WorkbenchSession[] {
  const seen = new Set<string>();
  return sessions.filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
}

function findSessionByAgent(sessions: WorkbenchSession[], agentAlias: string): WorkbenchSession | undefined {
  const def = sessions.find((s) => s.agentAlias === agentAlias && s.taskId === '__default__');
  if (def) return def;
  return sessions.find((s) => s.agentAlias === agentAlias);
}

function loadPersisted(): Partial<PersistedStateV3> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem('zeroclaw-chat-workspace-v2');
    if (!raw) return {};
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed.openChats) && !Array.isArray(parsed.tasks) && !Array.isArray(parsed.sessions)) {
      const v1 = parsed as PersistedStateV1;
      const aliases = (v1.openChats ?? []).filter(Boolean);
      const sessions = Array.from(new Set(aliases)).map((a) => makeDefaultSession(a));
      const activeAlias = v1.activeAlias ?? aliases[0];
      const activeSessionId = activeAlias ? makeSessionId(activeAlias, '__default__') : sessions[0]?.id ?? '';
      return { folders: defaultFolders(), sessions, activeSessionId };
    }

    if (Array.isArray(parsed.tasks) && !Array.isArray(parsed.sessions)) {
      const v2 = parsed as PersistedStateV2;
      const sessions = v2.tasks.map((t) => ({
        id: t.id,
        agentAlias: t.agentAlias,
        taskId: t.taskId,
        folderId: DEFAULT_FOLDER_ID,
      }));
      return { folders: defaultFolders(), sessions, activeSessionId: v2.activeTabId };
    }

    return parsed as Partial<PersistedStateV3>;
  } catch {
    return {};
  }
}

export interface ChatWorkspaceProps {
  initialAlias: string;
}

/**
 * Workbench: left session sidebar, middle transcript, right results.
 * Each open session stays mounted (CSS hidden) so background turns keep streaming.
 */
export default function ChatWorkspace({ initialAlias }: ChatWorkspaceProps) {
  const persisted = useRef<Partial<PersistedStateV3>>(loadPersisted());

  const [folders, setFolders] = useState<WorkbenchFolder[]>(() => {
    const stored = persisted.current.folders;
    return stored && stored.length > 0 ? stored : defaultFolders();
  });
  const [sessions, setSessions] = useState<WorkbenchSession[]>(() => {
    const stored = persisted.current.sessions ?? [];
    const existing = findSessionByAgent(stored, initialAlias);
    const seed: WorkbenchSession[] = existing ? stored : [...stored, makeDefaultSession(initialAlias)];
    return dedupeSessions(seed);
  });
  const [activeSessionId, setActiveSessionId] = useState<string>(() => {
    const stored = persisted.current.activeSessionId;
    if (stored) return stored;
    return findSessionByAgent(sessions, initialAlias)?.id ?? makeSessionId(initialAlias, '__default__');
  });
  const [activeFolderId, setActiveFolderId] = useState<string>(DEFAULT_FOLDER_ID);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readBool(SIDEBAR_COLLAPSED_KEY, false));
  const [rightCollapsed, setRightCollapsed] = useState(() => readBool(RIGHT_COLLAPSED_KEY, false));
  const [rightPct, setRightPct] = useState(() => readPct(RIGHT_PCT_KEY, 55));
  const splitRef = useRef<HTMLDivElement>(null);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId),
    [sessions, activeSessionId],
  );
  const activeAlias = activeSession?.agentAlias ?? initialAlias;

  const statusRef = useRef<Record<string, PaneStatus>>({});
  const [indicators, setIndicators] = useState<Record<string, SessionIndicator>>({});

  const visibleSessionIds = useMemo(() => new Set([activeSessionId]), [activeSessionId]);

  const syncIndicators = useCallback(() => {
    const next: Record<string, SessionIndicator> = {};
    for (const [id, s] of Object.entries(statusRef.current)) {
      next[id] = {
        streaming: s.streaming,
        unread: s.unread && !visibleSessionIds.has(id),
      };
    }
    setIndicators(next);
  }, [visibleSessionIds]);

  const syncIndicatorsRef = useRef(syncIndicators);
  useEffect(() => { syncIndicatorsRef.current = syncIndicators; }, [syncIndicators]);

  const onStatusCacheRef = useRef<Record<string, (s: AgentChatStatus) => void>>({});
  const onStatusFor = useCallback((sessionId: string) => {
    const cached = onStatusCacheRef.current[sessionId];
    if (cached) return cached;
    const fn = (s: AgentChatStatus) => {
      const prev = statusRef.current[sessionId] ?? {
        lastSeenCount: s.messageCount, liveCount: s.messageCount, streaming: false, unread: false,
      };
      const visible = visibleSessionIdsRef.current.has(sessionId);
      const grew = s.messageCount > prev.lastSeenCount;
      statusRef.current[sessionId] = {
        lastSeenCount: visible ? s.messageCount : prev.lastSeenCount,
        liveCount: s.messageCount,
        streaming: s.typing,
        unread: visible ? false : prev.unread || grew,
      };
      if (s.preview?.trim()) {
        const preview = s.preview.trim();
        setSessions((list) => {
          const current = list.find((sess) => sess.id === sessionId);
          if (!current || current.title) return list;
          return list.map((sess) => (sess.id === sessionId ? { ...sess, title: preview } : sess));
        });
      }
      syncIndicatorsRef.current();
    };
    onStatusCacheRef.current[sessionId] = fn;
    return fn;
  }, []);

  const visibleSessionIdsRef = useRef(visibleSessionIds);
  useEffect(() => {
    visibleSessionIdsRef.current = visibleSessionIds;
    for (const id of visibleSessionIds) {
      const s = statusRef.current[id];
      if (s) { s.unread = false; s.lastSeenCount = s.liveCount; }
    }
    syncIndicators();
  }, [visibleSessionIds, syncIndicators]);

  useEffect(() => {
    setSessions((prev) => {
      if (findSessionByAgent(prev, initialAlias)) return prev;
      return [...prev, makeDefaultSession(initialAlias, activeFolderId)];
    });
    const session = findSessionByAgent(sessions, initialAlias);
    if (session) setActiveSessionId(session.id);
  }, [initialAlias]);

  useEffect(() => {
    const snapshot: PersistedStateV3 = { folders, sessions, activeSessionId };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot)); } catch { /* noop */ }
  }, [folders, sessions, activeSessionId]);

  useEffect(() => {
    const path = window.location.pathname;
    const workbenchRoot = `${basePath}/workbench`;
    const onWorkbench = path === workbenchRoot || path.startsWith(`${workbenchRoot}/`);
    const target = onWorkbench
      ? `${workbenchRoot}/${encodeURIComponent(activeAlias)}`
      : `${basePath}/agent/${encodeURIComponent(activeAlias)}`;
    if (path !== target) {
      try { window.history.replaceState(window.history.state, '', target); } catch { /* noop */ }
    }
  }, [activeAlias]);

  const selectSession = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
    const session = sessions.find((s) => s.id === sessionId);
    if (session) setActiveFolderId(session.folderId);
  }, [sessions]);

  const newSession = useCallback(() => {
    const folderId = folders.some((f) => f.id === activeFolderId) ? activeFolderId : DEFAULT_FOLDER_ID;
    const taskId = createTaskSessionId(activeAlias);
    const session: WorkbenchSession = {
      id: makeSessionId(activeAlias, taskId),
      agentAlias: activeAlias,
      taskId,
      folderId,
    };
    setSessions((prev) => [...prev, session]);
    setActiveSessionId(session.id);
  }, [activeAlias, activeFolderId, folders]);

  const closeSession = useCallback((sessionId: string) => {
    setSessions((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.filter((s) => s.id !== sessionId);
      setActiveSessionId((cur) => {
        if (cur !== sessionId) return cur;
        const idx = prev.findIndex((s) => s.id === sessionId);
        return next[Math.min(idx, next.length - 1)]?.id ?? next[0]?.id ?? cur;
      });
      return next;
    });
    const closed = sessions.find((s) => s.id === sessionId);
    if (closed && closed.taskId !== '__default__') {
      removeTaskSession(closed.agentAlias, closed.taskId);
    }
    delete statusRef.current[sessionId];
    delete onStatusCacheRef.current[sessionId];
    syncIndicators();
  }, [sessions, syncIndicators]);

  const newFolder = useCallback((name: string) => {
    const folder: WorkbenchFolder = { id: generateUUID().slice(0, 8), name };
    setFolders((prev) => [...prev, folder]);
    setActiveFolderId(folder.id);
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((v) => {
      const next = !v;
      try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0'); } catch { /* noop */ }
      return next;
    });
  }, []);

  const toggleRight = useCallback(() => {
    setRightCollapsed((v) => {
      const next = !v;
      try { localStorage.setItem(RIGHT_COLLAPSED_KEY, next ? '1' : '0'); } catch { /* noop */ }
      return next;
    });
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.shiftKey && (e.metaKey || e.ctrlKey) && (e.key === 'o' || e.key === 'O'))) return;
      e.preventDefault();
      newSession();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [newSession]);

  function onSplitPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const root = splitRef.current;
    if (!root) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      const rect = root.getBoundingClientRect();
      if (rect.width <= 0) return;
      const pct = ((rect.right - ev.clientX) / rect.width) * 100;
      const next = Math.min(70, Math.max(30, pct));
      setRightPct(next);
    };
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      try { (ev.target as HTMLElement).releasePointerCapture?.(ev.pointerId); } catch { /* noop */ }
      try { localStorage.setItem(RIGHT_PCT_KEY, String(rightPctRef.current)); } catch { /* noop */ }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  const rightPctRef = useRef(rightPct);
  useEffect(() => { rightPctRef.current = rightPct; }, [rightPct]);

  return (
    <div translate="no" className="notranslate flex flex-1 h-full min-h-0 overflow-hidden bg-pc-base">
      <WorkbenchSidebar
        folders={folders}
        sessions={sessions}
        activeSessionId={activeSessionId}
        indicators={indicators}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={toggleSidebar}
        onNewSession={newSession}
        onSelect={selectSession}
        onClose={closeSession}
        onNewFolder={newFolder}
        onSelectFolder={setActiveFolderId}
      />

      <div ref={splitRef} className="flex flex-1 min-w-0 min-h-0 bg-pc-surface">
        {sessions.map((session) => {
          const visible = session.id === activeSessionId;
          return (
            <div
              key={session.id}
              role="tabpanel"
              id={`chat-panel-${session.id}`}
              aria-hidden={!visible}
              className={visible ? 'flex flex-1 min-w-0 min-h-0' : 'hidden'}
            >
              <AgentProvider
                key={session.id}
                agentAlias={session.agentAlias}
                taskId={session.taskId === '__default__' ? undefined : session.taskId}
              >
                <div
                  className="flex flex-col min-h-0 min-w-0 overflow-hidden bg-pc-surface"
                  style={{ flex: rightCollapsed ? '1 1 100%' : `${100 - rightPct} 1 0` }}
                >
                  <AgentChatInner
                    agentAlias={session.agentAlias}
                    sessionTitle={session.title}
                    onStatus={onStatusFor(session.id)}
                    rightPanelCollapsed={rightCollapsed}
                    onToggleRightPanel={toggleRight}
                  />
                </div>
                {!rightCollapsed && (
                  <>
                    <div
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={t('workbench.resize_panels')}
                      onPointerDown={onSplitPointerDown}
                      className="group relative z-20 flex w-px shrink-0 cursor-col-resize items-center justify-center bg-pc-border hover:bg-pc-accent/40 after:absolute after:inset-y-0 after:left-1/2 after:w-3 after:-translate-x-1/2"
                    >
                      <div className="z-10 flex h-4 w-3 items-center justify-center rounded-sm border border-pc-border bg-pc-elevated opacity-0 group-hover:opacity-100">
                        <GripVertical className="size-2.5 text-pc-text-muted" />
                      </div>
                    </div>
                    <div
                      className="flex min-h-0 min-w-[16rem] overflow-hidden"
                      style={{ flex: `${rightPct} 1 0` }}
                    >
                      <ResultsPanel />
                    </div>
                  </>
                )}
              </AgentProvider>
            </div>
          );
        })}
      </div>
    </div>
  );
}
