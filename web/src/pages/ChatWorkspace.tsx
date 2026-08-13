import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
    const target = `${basePath}/agent/${activeAlias}`;
    if (window.location.pathname !== target) {
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

  return (
    <div translate="no" className="notranslate flex flex-1 h-full min-h-0 overflow-hidden">
      <WorkbenchSidebar
        folders={folders}
        sessions={sessions}
        activeSessionId={activeSessionId}
        indicators={indicators}
        onNewSession={newSession}
        onSelect={selectSession}
        onClose={closeSession}
        onNewFolder={newFolder}
        onSelectFolder={setActiveFolderId}
      />

      <div className="flex flex-1 min-w-0 min-h-0">
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
                <div className="flex flex-1 min-w-0 min-h-0">
                  <div className="flex flex-col flex-1 min-w-0 min-h-0">
                    <AgentChatInner agentAlias={session.agentAlias} onStatus={onStatusFor(session.id)} />
                  </div>
                  <ResultsPanel />
                </div>
              </AgentProvider>
            </div>
          );
        })}
      </div>
    </div>
  );
}
