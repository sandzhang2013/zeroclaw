import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ChevronRight,
  Folder,
  FolderPlus,
  PanelLeftClose,
  PanelLeftOpen,
  PenSquare,
  Pencil,
  Settings,
  X,
} from 'lucide-react';
import { t } from '@/lib/i18n';
import { basePath } from '@/lib/basePath';
import { DEFAULT_FOLDER_ID, type WorkbenchFolder, type WorkbenchSession } from '@/pages/ChatWorkspace';
import { canOpenDashboard, roleI18nKey } from '@/lib/platformUser';
import { sanitizeSessionTitle, sessionDisplayTitle } from '@/lib/workbenchSession';

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
  onRename: (sessionId: string, name: string) => void;
  onNewFolder: (name: string) => void;
  onSelectFolder: (folderId: string) => void;
  /** Display name from the embedding platform or mock login. */
  userName?: string;
  userRole?: string;
  userRegion?: string;
  onSwitchUser?: () => void;
}

const WORKBENCH_VERSION = '0.6.2';

const CARD =
  'h-9 min-w-0 w-full justify-start gap-3 rounded-[10px] px-3 py-[7.5px] text-left text-sm text-pc-text-muted transition-colors hover:bg-[var(--pc-hover)] hover:text-pc-text';

function folderLabel(folder: WorkbenchFolder): string {
  return folder.id === DEFAULT_FOLDER_ID ? t('workbench.folder_default') : folder.name;
}

function sessionLabel(session: WorkbenchSession): string {
  return sessionDisplayTitle(session, t('workbench.default_session'));
}

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;

function formatRelativeTime(updatedAt: number | undefined, now: number): string {
  const diff = Math.max(0, now - (updatedAt ?? now));
  if (diff > MONTH_MS) return t('workbench.time_months').replace('{n}', String(Math.floor(diff / MONTH_MS)));
  if (diff > DAY_MS) return t('workbench.time_days').replace('{n}', String(Math.floor(diff / DAY_MS)));
  if (diff > HOUR_MS) return t('workbench.time_hours').replace('{n}', String(Math.floor(diff / HOUR_MS)));
  if (diff > MINUTE_MS) return t('workbench.time_minutes').replace('{n}', String(Math.floor(diff / MINUTE_MS)));
  return t('workbench.time_just_now');
}

function byNewest(a: WorkbenchSession, b: WorkbenchSession): number {
  return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
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
  onRename,
  onNewFolder,
  onSelectFolder,
  userName,
  userRole,
  userRegion,
  onSwitchUser,
}: WorkbenchSidebarProps) {
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [tasksOpen, setTasksOpen] = useState(true);
  const [folderOpen, setFolderOpen] = useState<Record<string, boolean>>({});
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderDraft, setFolderDraft] = useState('');
  const folderInputRef = useRef<HTMLInputElement>(null);
  const folderCommittedRef = useRef(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameCommittedRef = useRef(false);
  const sessionRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const mac = isMacPlatform();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (creatingFolder) folderInputRef.current?.focus();
  }, [creatingFolder]);

  useEffect(() => {
    if (renamingId) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }
  }, [renamingId]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const displayName = userName?.trim() || t('workbench.user_fallback');
  const roleLabel = userRole ? t(roleI18nKey(userRole)) : '';
  const userMeta = [roleLabel, userRegion?.trim()].filter(Boolean).join(' · ');
  const userTitle = onSwitchUser
    ? `${displayName}${userMeta ? ` · ${userMeta}` : ''} — ${t('workbench.switch_user')}`
    : `${displayName}${userMeta ? ` · ${userMeta}` : ''}`;
  const userInitial = displayName.slice(0, 1);
  const showDashboard = canOpenDashboard(userRole);
  const projectFolders = folders.filter((f) => f.id !== DEFAULT_FOLDER_ID);
  const inboxSessions = sessions
    .filter((s) => s.folderId === DEFAULT_FOLDER_ID || !folders.some((f) => f.id === s.folderId))
    .slice()
    .sort(byNewest);
  const orderedSessions = [
    ...projectFolders.flatMap((folder) => sessions.filter((s) => s.folderId === folder.id).slice().sort(byNewest)),
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

  function startRename(session: WorkbenchSession) {
    renameCommittedRef.current = false;
    setRenamingId(session.id);
    setRenameDraft(sessionLabel(session));
  }

  function cancelRename() {
    renameCommittedRef.current = true;
    setRenamingId(null);
    setRenameDraft('');
  }

  function submitRename() {
    if (renameCommittedRef.current || !renamingId) return;
    renameCommittedRef.current = true;
    const name = sanitizeSessionTitle(renameDraft);
    if (name) onRename(renamingId, name);
    setRenamingId(null);
    setRenameDraft('');
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
        closable
        nested={nested}
        renaming={renamingId === session.id}
        renameDraft={renameDraft}
        renameInputRef={renameInputRef}
        buttonRef={(el) => { sessionRefs.current[session.id] = el; }}
        relativeTime={formatRelativeTime(session.updatedAt, now)}
        onSelect={() => onSelect(session.id)}
        onClose={() => onClose(session.id)}
        onStartRename={() => startRename(session)}
        onRenameDraft={setRenameDraft}
        onSubmitRename={submitRename}
        onCancelRename={cancelRename}
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
                className={['size-6 object-contain', collapsed ? 'group-hover/logo:opacity-0' : ''].join(' ')}
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
                  const kids = sessions.filter((s) => s.folderId === folder.id).slice().sort(byNewest);
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

      <div
        className={[
          'mt-auto shrink-0 flex flex-col border-t border-pc-border',
          collapsed ? 'items-center gap-1 p-2' : 'gap-0.5 px-3 py-2',
        ].join(' ')}
      >
        <div className={collapsed ? 'flex flex-col items-center gap-1' : 'flex items-center justify-between gap-2'}>
          {collapsed ? (
            <button
              type="button"
              onClick={onSwitchUser}
              disabled={!onSwitchUser}
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-[10px] text-sm font-medium text-pc-text hover:bg-[var(--pc-hover)] disabled:cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]"
              aria-label={userTitle}
              title={userTitle}
            >
              {userInitial}
            </button>
          ) : onSwitchUser ? (
            <button
              type="button"
              onClick={onSwitchUser}
              className="min-w-0 flex-1 truncate rounded-[10px] px-1 py-0.5 text-left hover:bg-[var(--pc-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]"
              title={userTitle}
              aria-label={userTitle}
            >
              <span className="block truncate text-sm font-medium text-pc-text">{displayName}</span>
              {userMeta && (
                <span className="block truncate text-[11px] leading-4 text-pc-text-muted">{userMeta}</span>
              )}
            </button>
          ) : (
            <span className="min-w-0 flex-1 truncate px-1" title={userTitle}>
              <span className="block truncate text-sm font-medium text-pc-text">{displayName}</span>
              {userMeta && (
                <span className="block truncate text-[11px] leading-4 text-pc-text-muted">{userMeta}</span>
              )}
            </span>
          )}
          {showDashboard && (
            <Link
              to="/dashboard"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-[10px] text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-pc-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]"
              aria-label={t('workbench.open_dashboard')}
              title={t('workbench.open_dashboard')}
            >
              <Settings className="size-4" />
            </Link>
          )}
        </div>
        <span
          className={[
            'tabular-nums text-pc-text-faint',
            collapsed ? 'text-[9px] leading-none' : 'px-1 text-[10px] leading-4',
          ].join(' ')}
        >
          v{WORKBENCH_VERSION}
        </span>
      </div>
    </aside>
  );
}

function SessionRow({
  session,
  active,
  indicator,
  closable,
  nested,
  renaming,
  renameDraft,
  renameInputRef,
  buttonRef,
  relativeTime,
  onSelect,
  onClose,
  onStartRename,
  onRenameDraft,
  onSubmitRename,
  onCancelRename,
  onKeyDown,
}: {
  session: WorkbenchSession;
  active: boolean;
  indicator?: SessionIndicator;
  closable: boolean;
  nested: boolean;
  renaming: boolean;
  renameDraft: string;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  buttonRef: (el: HTMLButtonElement | null) => void;
  relativeTime: string;
  onSelect: () => void;
  onClose: () => void;
  onStartRename: () => void;
  onRenameDraft: (value: string) => void;
  onSubmitRename: () => void;
  onCancelRename: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
}) {
  if (renaming) {
    return (
      <div className={['px-0', nested ? 'pl-4' : ''].join(' ')}>
        <input
          ref={renameInputRef}
          value={renameDraft}
          aria-label={t('workbench.rename_session')}
          onChange={(e) => onRenameDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              onSubmitRename();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              onCancelRename();
            }
          }}
          onBlur={onSubmitRename}
          placeholder={t('workbench.session_name_placeholder')}
          className="w-full h-9 px-3 text-sm rounded-[10px] border border-pc-border bg-pc-input text-pc-text placeholder:text-pc-text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]"
        />
      </div>
    );
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onSelect}
      onDoubleClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onStartRename();
      }}
      onKeyDown={(e) => {
        if (e.key === 'F2') {
          e.preventDefault();
          onStartRename();
          return;
        }
        onKeyDown(e);
      }}
      title={sessionLabel(session)}
      className={[
        'group/task-card relative flex items-center',
        CARD,
        nested ? 'pl-6' : '',
        active ? 'bg-[var(--pc-hover)] text-pc-text' : '',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]',
      ].join(' ')}
    >
      <StatusDot streaming={indicator?.streaming} unread={indicator?.unread} active={active} />
      <span className="min-w-0 flex-1 truncate text-pc-text">{sessionLabel(session)}</span>
      <span className="relative ml-1 flex h-6 shrink-0 items-center justify-end">
        <span className="whitespace-nowrap text-[10px] tabular-nums text-pc-text-faint group-hover/task-card:opacity-0">
          {relativeTime}
        </span>
        <span className="absolute inset-y-0 right-0 inline-flex items-center justify-end gap-0.5 opacity-0 group-hover/task-card:opacity-100">
          <span
            role="button"
            tabIndex={-1}
            aria-label={t('workbench.rename_session')}
            title={t('workbench.rename_session')}
            onClick={(e) => {
              e.stopPropagation();
              onStartRename();
            }}
            className="inline-flex items-center justify-center size-6 rounded-md text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-pc-text cursor-pointer"
          >
            <Pencil className="size-3.5" />
          </span>
          <span
            role="button"
            tabIndex={-1}
            aria-label={t('workbench.delete_session')}
            title={t('workbench.delete_session')}
            aria-disabled={!closable}
            onClick={(e) => {
              e.stopPropagation();
              if (closable) onClose();
            }}
            className={[
              'inline-flex items-center justify-center size-6 rounded-md text-pc-text-muted',
              closable ? 'hover:bg-status-error/15 hover:text-status-error cursor-pointer' : 'cursor-not-allowed',
            ].join(' ')}
          >
            <X className="size-3.5" />
          </span>
        </span>
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
