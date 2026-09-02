import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { GripVertical } from 'lucide-react';
import { AgentProvider } from '@/contexts/AgentContext';
import { AgentChatInner, type AgentChatStatus } from '@/pages/AgentChat';
import { WorkbenchSidebar, type SessionIndicator } from '@/components/WorkbenchSidebar';
import { ResultsPanel } from '@/components/ResultsPanel';
import { WorkbenchHome } from '@/components/WorkbenchHome';
import { ConfirmDialog } from '@/components/ui';
import { deleteAgentWorkspacePath, deleteSession, getSessions } from '@/lib/api';
import {
  adoptTaskSession,
  createTaskSessionId,
  getOrCreateSessionId,
  removeTaskSession,
  resolveTaskSessionId,
} from '@/lib/ws';
import { persistSessionId } from '@/lib/sessionId';
import { generateUUID } from '@/lib/uuid';
import { t } from '@/lib/i18n';
import {
  saveWorkbenchAutonomy,
  clampWorkbenchAutonomy,
  maxAutonomyForRole,
  type WorkbenchAutonomy,
} from '@/lib/workbenchAutonomy';
import {
  gatewaySessionsToRecover,
  readWorkspaceSnapshot,
  sanitizeSessionTitle,
  workspaceStorageKey,
  dropSessionFromList,
} from '@/lib/workbenchSession';
import { clearChatHistory } from '@/lib/chatHistoryStorage';

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
  /** Last activity, epoch milliseconds. */
  updatedAt?: number;
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

function stampNow(): number {
  return Date.now();
}

function withUpdatedAt(session: WorkbenchSession): WorkbenchSession {
  return session.updatedAt ? session : { ...session, updatedAt: stampNow() };
}

function makeDefaultSession(agentAlias: string, folderId = DEFAULT_FOLDER_ID): WorkbenchSession {
  const taskId = '__default__';
  return { id: makeSessionId(agentAlias, taskId), agentAlias, taskId, folderId, updatedAt: stampNow() };
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

function loadPersisted(userId?: string): Partial<PersistedStateV3> {
  try {
    const raw = readWorkspaceSnapshot(userId);
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
        updatedAt: stampNow(),
      }));
      return { folders: defaultFolders(), sessions, activeSessionId: v2.activeTabId };
    }

    const v3 = parsed as Partial<PersistedStateV3>;
    if (Array.isArray(v3.sessions)) {
      v3.sessions = v3.sessions.map(withUpdatedAt);
    }
    return v3;
  } catch {
    return {};
  }
}

export interface ChatWorkspaceProps {
  initialAlias: string;
  userId?: string;
  userName?: string;
  userRole?: string;
  userRegion?: string;
  onSwitchUser?: () => void;
}

/**
 * Workbench: left session sidebar, middle transcript, right results.
 * Each open session stays mounted (CSS hidden) so background turns keep streaming.
 */
export default function ChatWorkspace({
  initialAlias,
  userId,
  userName,
  userRole,
  userRegion,
  onSwitchUser,
}: ChatWorkspaceProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const persisted = useRef<Partial<PersistedStateV3>>(loadPersisted(userId));

  const [folders, setFolders] = useState<WorkbenchFolder[]>(() => {
    const stored = persisted.current.folders;
    return stored && stored.length > 0 ? stored : defaultFolders();
  });
  const [sessions, setSessions] = useState<WorkbenchSession[]>(() => {
    const stored = persisted.current.sessions ?? [];
    return dedupeSessions(stored.map(withUpdatedAt));
  });
  // Login / user switch always lands on the composer. Auto-opening a stored
  // task reconnects its gateway UUID and trips SESSION_FORBIDDEN when that
  // UUID was stamped by the previous user.
  const [activeSessionId, setActiveSessionId] = useState('');
  const [mountedSessionIds, setMountedSessionIds] = useState<Set<string>>(() => new Set());
  const [activeFolderId, setActiveFolderId] = useState<string>(DEFAULT_FOLDER_ID);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readBool(SIDEBAR_COLLAPSED_KEY, false));
  const [rightCollapsed, setRightCollapsed] = useState(() => readBool(RIGHT_COLLAPSED_KEY, false));
  const [rightPct, setRightPct] = useState(() => readPct(RIGHT_PCT_KEY, 55));
  const splitRef = useRef<HTMLDivElement>(null);
  const [pendingPrompt, setPendingPrompt] = useState<{
    sessionId: string;
    text: string;
    autonomy: WorkbenchAutonomy;
    files: File[];
  } | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const deletingRef = useRef(false);
  const showHome = !sessions.some((s) => s.id === activeSessionId);

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
      const preview = s.preview?.trim();
      if (grew || preview) {
        setSessions((list) => {
          const current = list.find((sess) => sess.id === sessionId);
          if (!current) return list;
          const stored = sanitizeSessionTitle(current.title);
          const fromPreview = sanitizeSessionTitle(preview);
          const nextTitle = fromPreview && stored && fromPreview.startsWith(stored) && fromPreview.length > stored.length
            ? fromPreview
            : (stored ?? fromPreview ?? current.title);
          if (!grew && nextTitle === current.title) return list;
          return list.map((sess) => (
            sess.id === sessionId
              ? { ...sess, title: nextTitle, updatedAt: grew ? stampNow() : sess.updatedAt }
              : sess
          ));
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
    if (!activeSessionId) return;
    setMountedSessionIds((prev) => {
      if (prev.has(activeSessionId)) return prev;
      const next = new Set(prev);
      next.add(activeSessionId);
      return next;
    });
  }, [activeSessionId]);

  useEffect(() => {
    const snapshot: PersistedStateV3 = { folders, sessions, activeSessionId };
    try { localStorage.setItem(workspaceStorageKey(userId), JSON.stringify(snapshot)); } catch { /* noop */ }
  }, [folders, sessions, activeSessionId, userId]);

  useEffect(() => {
    let cancelled = false;
    const defaultId = getOrCreateSessionId(initialAlias, userId);
    getSessions()
      .then((rows) => {
        if (cancelled) return;
        const recovered = gatewaySessionsToRecover(rows, defaultId, userId);
        if (!recovered.length) return;
        setSessions((prev) => {
          const known = new Set<string>();
          for (const session of prev) {
            const gid = session.taskId === '__default__'
              ? defaultId
              : resolveTaskSessionId(session.agentAlias, session.taskId);
            if (gid) known.add(gid);
          }
          const added: WorkbenchSession[] = [];
          for (const row of recovered) {
            if (known.has(row.sessionId)) continue;
            known.add(row.sessionId);
            const taskId = adoptTaskSession(row.agentAlias, row.sessionId);
            added.push({
              id: makeSessionId(row.agentAlias, taskId),
              agentAlias: row.agentAlias,
              taskId,
              folderId: DEFAULT_FOLDER_ID,
              updatedAt: row.lastActivity || stampNow(),
              title: row.title,
            });
          }
          return added.length ? dedupeSessions([...prev, ...added]) : prev;
        });
      })
      .catch(() => { /* keep the local snapshot */ });
    return () => { cancelled = true; };
  }, [initialAlias, userId]);

  useEffect(() => {
    const target = `/workbench/${encodeURIComponent(activeAlias)}`;
    if (location.pathname !== target) {
      navigate(target, { replace: true });
    }
  }, [activeAlias, location.pathname, navigate]);

  const selectSession = useCallback((sessionId: string) => {
    setActiveSessionId(sessionId);
    const session = sessions.find((s) => s.id === sessionId);
    if (session) setActiveFolderId(session.folderId);
  }, [sessions]);

  const newSession = useCallback(() => {
    setActiveSessionId('');
  }, []);

  const startSessionFromHome = useCallback((text: string, autonomy: WorkbenchAutonomy, files: File[] = []) => {
    const folderId = folders.some((f) => f.id === activeFolderId) ? activeFolderId : DEFAULT_FOLDER_ID;
    const taskId = createTaskSessionId(activeAlias);
    const titleSource = text.trim().split('\n')[0] || files[0]?.name || '';
    const session: WorkbenchSession = {
      id: makeSessionId(activeAlias, taskId),
      agentAlias: activeAlias,
      taskId,
      folderId,
      updatedAt: stampNow(),
      title: sanitizeSessionTitle(titleSource) ?? undefined,
    };
    const capped = clampWorkbenchAutonomy(autonomy, maxAutonomyForRole(userRole));
    saveWorkbenchAutonomy(session.id, capped);
    setPendingPrompt({ sessionId: session.id, text, autonomy: capped, files });
    setSessions((prev) => [...prev, session]);
    setActiveSessionId(session.id);
  }, [activeAlias, activeFolderId, folders, userRole]);

  const renameSession = useCallback((sessionId: string, name: string) => {
    const title = sanitizeSessionTitle(name);
    if (!title) return;
    setSessions((list) => list.map((sess) => (
      sess.id === sessionId ? { ...sess, title } : sess
    )));
  }, []);

  const requestDeleteSession = useCallback((sessionId: string) => {
    setPendingDeleteId(sessionId);
  }, []);

  const confirmDeleteSession = useCallback(() => {
    const sessionId = pendingDeleteId;
    if (!sessionId || deletingRef.current) return;
    const closed = sessions.find((s) => s.id === sessionId);
    setPendingDeleteId(null);
    if (!closed) return;
    deletingRef.current = true;
    const defaultId = getOrCreateSessionId(closed.agentAlias, userId);
    const gid = closed.taskId === '__default__'
      ? defaultId
      : resolveTaskSessionId(closed.agentAlias, closed.taskId);

    void (async () => {
      if (gid) {
        try { await deleteSession(gid); } catch { /* already gone or persistence off */ }
        try { await deleteAgentWorkspacePath(closed.agentAlias, `sessions/${gid}`); } catch { /* no files */ }
        clearChatHistory(gid);
      }
      if (closed.taskId !== '__default__') {
        removeTaskSession(closed.agentAlias, closed.taskId);
      } else {
        persistSessionId(closed.agentAlias, generateUUID(), userId);
      }
      setSessions((prev) => {
        const dropped = dropSessionFromList(prev, sessionId, activeSessionId);
        setActiveSessionId(dropped.activeSessionId);
        return dropped.sessions;
      });
      delete statusRef.current[sessionId];
      delete onStatusCacheRef.current[sessionId];
      syncIndicators();
      deletingRef.current = false;
    })();
  }, [pendingDeleteId, sessions, userId, activeSessionId, syncIndicators]);

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
        onClose={requestDeleteSession}
        onRename={renameSession}
        onNewFolder={newFolder}
        onSelectFolder={setActiveFolderId}
        userName={userName}
        userRole={userRole}
        userRegion={userRegion}
        onSwitchUser={onSwitchUser}
      />

      <div ref={splitRef} className="flex flex-1 min-w-0 min-h-0 bg-pc-surface">
        {showHome && (
          <WorkbenchHome
            onSend={startSessionFromHome}
            folders={folders}
            activeFolderId={activeFolderId}
            onSelectFolder={setActiveFolderId}
            agentAlias={activeAlias}
            userRole={userRole}
          />
        )}
        {sessions.filter((session) => mountedSessionIds.has(session.id)).map((session) => {
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
                userId={userId}
                userRole={userRole}
                taskId={session.taskId === '__default__' ? undefined : session.taskId}
              >
                <div
                  className="flex flex-col min-h-0 min-w-0 overflow-hidden bg-pc-surface"
                  style={{ flex: rightCollapsed ? '1 1 100%' : `${100 - rightPct} 1 0` }}
                >
                  <AgentChatInner
                    agentAlias={session.agentAlias}
                    sessionTitle={session.title}
                    onRenameSession={(name) => renameSession(session.id, name)}
                    onStatus={onStatusFor(session.id)}
                    rightPanelCollapsed={rightCollapsed}
                    onToggleRightPanel={toggleRight}
                    initialPrompt={pendingPrompt?.sessionId === session.id ? pendingPrompt.text : undefined}
                    initialAutonomy={pendingPrompt?.sessionId === session.id ? pendingPrompt.autonomy : undefined}
                    initialFiles={pendingPrompt?.sessionId === session.id ? pendingPrompt.files : undefined}
                    autonomyScope={session.id}
                    userRole={userRole}
                    onInitialPromptConsumed={() => {
                      setPendingPrompt((p) => (p?.sessionId === session.id ? null : p));
                    }}
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
      <ConfirmDialog
        open={pendingDeleteId !== null}
        danger
        title={t('workbench.confirm_delete_session_title')}
        message={t('workbench.confirm_delete_session')}
        confirmLabel={t('common.confirm')}
        onConfirm={confirmDeleteSession}
        onClose={() => setPendingDeleteId(null)}
      />
    </div>
  );
}
