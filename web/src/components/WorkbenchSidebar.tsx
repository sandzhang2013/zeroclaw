import { useEffect, useRef, useState } from 'react';
import {
  ChevronRight,
  Folder,
  FolderPlus,
  PanelLeftClose,
  PanelLeftOpen,
  PenSquare,
  X,
} from 'lucide-react';
import { t } from '@/lib/i18n';
import { basePath } from '@/lib/basePath';
import { DEFAULT_FOLDER_ID, type WorkbenchFolder, type WorkbenchSession } from '@/pages/ChatWorkspace';

export interface SessionIndicator {
  streaming: boolean;
  unread: boolean;
}

export interface WorkbenchSidebarProps {
  folders: WorkbenchFolder[];
  sessions: WorkbenchSession[];
  activeSessionId: string;
  indicators: Record<string, SessionIndicator>;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onNewSession: () => void;
  onSelect: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onNewFolder: (name: string) => void;
  onSelectFolder: (folderId: string) => void;
}

const CARD =
  'h-9 min-w-0 w-full justify-start gap-3 rounded-[10px] px-3 py-[7.5px] text-left text-sm text-pc-text-muted transition-colors hover:bg-[var(--pc-hover)] hover:text-pc-text';

function folderLabel(folder: WorkbenchFolder): string {
  return folder.id === DEFAULT_FOLDER_ID ? t('workbench.folder_default') : folder.name;
}

function sessionLabel(session: WorkbenchSession): string {
  if (session.title?.trim()) return session.title.trim();
  if (session.taskId === '__default__') return t('workbench.default_session');
  return session.taskId;
}

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

export function WorkbenchSidebar({
  folders,
  sessions,
  activeSessionId,
  indicators,
  collapsed,
  onToggleCollapsed,
  onNewSession,
  onSelect,
  onClose,
  onNewFolder,
  onSelectFolder,
}: WorkbenchSidebarProps) {
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [tasksOpen, setTasksOpen] = useState(true);
  const [folderOpen, setFolderOpen] = useState<Record<string, boolean>>({});
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderDraft, setFolderDraft] = useState('');
  const folderInputRef = useRef<HTMLInputElement>(null);
  const folderCommittedRef = useRef(false);
  const sessionRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const mac = isMacPlatform();

  useEffect(() => {
    if (creatingFolder) folderInputRef.current?.focus();
  }, [creatingFolder]);

  const closableLast = sessions.length <= 1;
  const projectFolders = folders.filter((f) => f.id !== DEFAULT_FOLDER_ID);
  const inboxSessions = sessions.filter(
    (s) => s.folderId === DEFAULT_FOLDER_ID || !folders.some((f) => f.id === s.folderId),
  );
  const orderedSessions = [
    ...projectFolders.flatMap((folder) => sessions.filter((s) => s.folderId === folder.id)),
    ...inboxSessions,
  ];

  function submitFolder() {
    if (folderCommittedRef.current) return;
    folderCommittedRef.current = true;
    const name = folderDraft.trim();
    if (name) onNewFolder(name);
    setFolderDraft('');
    setCreatingFolder(false);
  }

  function handleSessionKeyDown(e: React.KeyboardEvent, sessionId: string) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const idx = orderedSessions.findIndex((s) => s.id === sessionId);
    if (idx < 0) return;
    const next = e.key === 'ArrowDown'
      ? orderedSessions[(idx + 1) % orderedSessions.length]
      : orderedSessions[(idx - 1 + orderedSessions.length) % orderedSessions.length];
    if (!next) return;
    onSelect(next.id);
    sessionRefs.current[next.id]?.focus();
  }

  function renderSession(session: WorkbenchSession, nested: boolean) {
    return (
      <SessionRow
        key={session.id}
        session={session}
        active={session.id === activeSessionId}
        indicator={indicators[session.id]}
        closable={!closableLast}
        nested={nested}
        buttonRef={(el) => { sessionRefs.current[session.id] = el; }}
        onSelect={() => onSelect(session.id)}
        onClose={() => onClose(session.id)}
        onKeyDown={(e) => handleSessionKeyDown(e, session.id)}
      />
    );
  }

  return (
    <aside
      className={[
        'flex flex-col shrink-0 min-h-0 overflow-hidden bg-pc-base transition-[width] duration-200 ease-linear',
        collapsed ? 'w-12' : 'w-[min(16.6667vw,17.5rem)] min-w-[13rem]',
      ].join(' ')}
      aria-label={t('workbench.sidebar_label')}
    >
      <div className="px-2 gap-2 pb-2 flex flex-col">
        <div className="mb-1 flex items-center pt-2 -mx-2">
          <div className="flex w-12 shrink-0 items-center justify-center">
            <button
              type="button"
              onClick={onToggleCollapsed}
              className="group/logo relative flex size-7 shrink-0 items-center justify-center overflow-hidden transition-all active:scale-95"
              aria-label={collapsed ? t('workbench.expand_sidebar') : t('workbench.collapse_sidebar')}
              title={collapsed ? t('workbench.expand_sidebar') : t('workbench.collapse_sidebar')}
            >
              <img
                src={`${basePath}/_app/logo.png`}
                alt=""
                className={['size-6 object-cover', collapsed ? 'group-hover/logo:opacity-0' : ''].join(' ')}
              />
              {collapsed && (
                <PanelLeftOpen className="absolute hidden size-4 group-hover/logo:block text-pc-text" />
              )}
            </button>
          </div>
          {!collapsed && (
            <div className="flex min-w-0 flex-1 items-center justify-between gap-1 pr-2">
              <span className="text-xl font-bold tracking-tight text-pc-text truncate">
                {t('workbench.brand')}
              </span>
              <button
                type="button"
                onClick={onToggleCollapsed}
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-[10px] text-pc-text hover:bg-[var(--pc-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]"
                aria-label={t('workbench.collapse_sidebar')}
              >
                <PanelLeftClose className="size-4" />
              </button>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onNewSession}
          title={`${t('workbench.new_task')} (${mac ? '⇧⌘O' : 'Shift+Ctrl+O'})`}
          className={[
            'group/new-task flex items-center',
            CARD,
            collapsed ? 'w-9 px-0 justify-center mx-auto' : '',
          ].join(' ')}
        >
          <PenSquare className="size-4 shrink-0 transition-transform duration-200 group-hover/new-task:rotate-12 group-hover/new-task:scale-110" />
          {!collapsed && (
            <>
              <span className="truncate">{t('workbench.new_task')}</span>
              <span className="ml-auto text-xs text-pc-text-faint opacity-0 transition-opacity group-hover/new-task:opacity-70">
                {mac ? '⇧⌘O' : '⇧Ctrl+O'}
              </span>
            </>
          )}
        </button>
      </div>

      {!collapsed && (
        <nav className="flex-1 min-h-0 overflow-y-auto border-t border-transparent" aria-label={t('workbench.session_list')}>
          <section className="flex flex-col">
            <div className="group/projects-header relative flex items-center justify-between p-2 shrink-0">
              <button
                type="button"
                onClick={() => setProjectsOpen((v) => !v)}
                className="flex flex-1 items-center gap-2 text-xs font-medium text-pc-text-muted hover:text-pc-text"
              >
                {t('workbench.folders')}
                <ChevronRight className={['size-4 transition-transform duration-200', projectsOpen ? 'rotate-90' : ''].join(' ')} />
              </button>
              <button
                type="button"
                onClick={() => {
                  folderCommittedRef.current = false;
                  setCreatingFolder(true);
                  setProjectsOpen(true);
                }}
                aria-label={t('workbench.new_folder')}
                title={t('workbench.new_folder')}
                className="inline-flex size-6 items-center justify-center rounded-md text-pc-text-muted hover:text-pc-text hover:bg-[var(--pc-hover)] opacity-0 group-hover/projects-header:opacity-100 transition-opacity"
              >
                <FolderPlus className="size-4" />
              </button>
            </div>
            {projectsOpen && (
              <div className="px-2 pb-2 space-y-0.5">
                {creatingFolder && (
                  <input
                    ref={folderInputRef}
                    value={folderDraft}
                    onChange={(e) => setFolderDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submitFolder();
                      if (e.key === 'Escape') { setCreatingFolder(false); setFolderDraft(''); }
                    }}
                    onBlur={submitFolder}
                    placeholder={t('workbench.folder_name_placeholder')}
                    className="w-full h-9 px-3 text-sm rounded-[10px] border border-pc-border bg-pc-input text-pc-text placeholder:text-pc-text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]"
                  />
                )}
                {projectFolders.map((folder) => {
                  const kids = sessions.filter((s) => s.folderId === folder.id);
                  const open = folderOpen[folder.id] !== false;
                  return (
                    <div key={folder.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setFolderOpen((prev) => ({ ...prev, [folder.id]: !open }));
                          onSelectFolder(folder.id);
                        }}
                        className={['flex items-center', CARD].join(' ')}
                      >
                        <ChevronRight className={['size-4 shrink-0 transition-transform', open ? 'rotate-90' : ''].join(' ')} />
                        <Folder className="size-4 shrink-0" />
                        <span className="flex-1 min-w-0 truncate">{folderLabel(folder)}</span>
                        <span className="text-[10px] tabular-nums text-pc-text-faint">{kids.length}</span>
                      </button>
                      {open && kids.map((session) => renderSession(session, true))}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section className="flex flex-col">
            <div className="flex items-center justify-between p-2 shrink-0">
              <button
                type="button"
                onClick={() => {
                  setTasksOpen((v) => !v);
                  onSelectFolder(DEFAULT_FOLDER_ID);
                }}
                className="flex flex-1 items-center gap-2 text-xs font-medium text-pc-text-muted hover:text-pc-text"
              >
                {t('workbench.all_tasks')}
                <ChevronRight className={['size-4 transition-transform duration-200', tasksOpen ? 'rotate-90' : ''].join(' ')} />
              </button>
            </div>
            {tasksOpen && (
              <div className="px-2 pb-2 space-y-0.5">
                {inboxSessions.map((session) => renderSession(session, false))}
              </div>
            )}
          </section>
        </nav>
      )}
    </aside>
  );
}

function SessionRow({
  session,
  active,
  indicator,
  closable,
  nested,
  buttonRef,
  onSelect,
  onClose,
  onKeyDown,
}: {
  session: WorkbenchSession;
  active: boolean;
  indicator?: SessionIndicator;
  closable: boolean;
  nested: boolean;
  buttonRef: (el: HTMLButtonElement | null) => void;
  onSelect: () => void;
  onClose: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onSelect}
      onKeyDown={onKeyDown}
      title={sessionLabel(session)}
      className={[
        'group/task-card relative flex items-center',
        CARD,
        'pr-8',
        nested ? 'pl-6' : '',
        active ? 'bg-[var(--pc-hover)] text-pc-text' : '',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]',
      ].join(' ')}
    >
      <StatusDot streaming={indicator?.streaming} unread={indicator?.unread} active={active} />
      <span className="flex-1 min-w-0 truncate">{sessionLabel(session)}</span>
      <span
        role="button"
        tabIndex={-1}
        aria-label={t('workbench.close_session')}
        title={t('workbench.close_session')}
        aria-disabled={!closable}
        onClick={(e) => {
          e.stopPropagation();
          if (closable) onClose();
        }}
        className={[
          'absolute right-1.5 inline-flex items-center justify-center size-6 rounded-md shrink-0',
          'text-pc-text-muted transition-opacity opacity-0 group-hover/task-card:opacity-100',
          closable ? 'hover:bg-status-error/15 hover:text-status-error cursor-pointer' : 'cursor-not-allowed',
        ].join(' ')}
      >
        <X className="size-3.5" />
      </span>
    </button>
  );
}

function StatusDot({ streaming, unread, active }: { streaming?: boolean; unread?: boolean; active: boolean }) {
  if (streaming) {
    return (
      <span className="relative inline-flex size-2 shrink-0" aria-hidden>
        <span className="absolute inline-flex size-full rounded-full bg-pc-accent opacity-60 animate-ping" />
        <span className="relative inline-flex size-2 rounded-full bg-pc-accent" />
      </span>
    );
  }
  if (unread) {
    return <span className="inline-flex size-2 shrink-0 rounded-full bg-pc-accent" aria-hidden />;
  }
  return (
    <span
      className={['inline-flex size-2 shrink-0 rounded-full', active ? 'bg-pc-accent/40' : 'bg-pc-text-faint/40'].join(' ')}
      aria-hidden
    />
  );
}

export default WorkbenchSidebar;
