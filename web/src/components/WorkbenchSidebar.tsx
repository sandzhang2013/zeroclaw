import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FolderPlus, MessageSquare, Plus, X } from 'lucide-react';
import { t } from '@/lib/i18n';
import type { WorkbenchFolder, WorkbenchSession } from '@/pages/ChatWorkspace';

export interface SessionIndicator {
  streaming: boolean;
  unread: boolean;
}

export interface WorkbenchSidebarProps {
  folders: WorkbenchFolder[];
  sessions: WorkbenchSession[];
  activeSessionId: string;
  indicators: Record<string, SessionIndicator>;
  onNewSession: () => void;
  onSelect: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onNewFolder: (name: string) => void;
  onSelectFolder: (folderId: string) => void;
}

function folderLabel(folder: WorkbenchFolder): string {
  return folder.id === 'default' ? t('workbench.folder_default') : folder.name;
}

function sessionLabel(session: WorkbenchSession): string {
  if (session.title?.trim()) return session.title.trim();
  if (session.taskId === '__default__') return t('workbench.default_session');
  return session.taskId;
}

export function WorkbenchSidebar({
  folders,
  sessions,
  activeSessionId,
  indicators,
  onNewSession,
  onSelect,
  onClose,
  onNewFolder,
  onSelectFolder,
}: WorkbenchSidebarProps) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderDraft, setFolderDraft] = useState('');
  const folderInputRef = useRef<HTMLInputElement>(null);
  const folderCommittedRef = useRef(false);
  const sessionRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  useEffect(() => {
    if (creatingFolder) folderInputRef.current?.focus();
  }, [creatingFolder]);

  const closableLast = sessions.length <= 1;
  const orderedSessions = folders.flatMap((folder) =>
    sessions.filter((s) => s.folderId === folder.id),
  );
  const orphans = sessions.filter((s) => !folders.some((f) => f.id === s.folderId));

  function toggleFolder(folderId: string) {
    setCollapsed((prev) => ({ ...prev, [folderId]: !prev[folderId] }));
    onSelectFolder(folderId);
  }

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
    const list = [...orderedSessions, ...orphans];
    const idx = list.findIndex((s) => s.id === sessionId);
    if (idx < 0) return;
    const next = e.key === 'ArrowDown'
      ? list[(idx + 1) % list.length]
      : list[(idx - 1 + list.length) % list.length];
    if (!next) return;
    onSelect(next.id);
    sessionRefs.current[next.id]?.focus();
  }

  return (
    <aside
      className="flex flex-col w-56 shrink-0 border-r border-pc-border bg-pc-surface min-h-0"
      aria-label={t('workbench.sidebar_label')}
    >
      <div className="p-2 shrink-0">
        <button
          type="button"
          onClick={onNewSession}
          className="flex w-full items-center justify-center gap-1.5 h-8 rounded-[var(--radius-md)] text-xs font-medium bg-pc-accent text-[#0b1220] hover:bg-pc-accent-light transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          {t('workbench.new_session')}
        </button>
      </div>

      <div className="flex items-center justify-between px-3 pb-1 shrink-0">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-pc-text-muted">
          {t('workbench.folders')}
        </span>
        <button
          type="button"
          onClick={() => {
            folderCommittedRef.current = false;
            setCreatingFolder(true);
          }}
          aria-label={t('workbench.new_folder')}
          title={t('workbench.new_folder')}
          className="inline-flex items-center justify-center h-6 w-6 rounded-[var(--radius-sm)] text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-pc-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]"
        >
          <FolderPlus className="h-3.5 w-3.5" />
        </button>
      </div>

      <nav className="flex-1 min-h-0 overflow-y-auto px-1.5 pb-2" aria-label={t('workbench.session_list')}>
        {creatingFolder && (
          <div className="px-1.5 pb-2">
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
              className="w-full h-7 px-2 text-xs rounded-[var(--radius-sm)] border border-pc-border bg-pc-input text-pc-text placeholder:text-pc-text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]"
            />
          </div>
        )}

        {folders.map((folder) => {
          const kids = sessions.filter((s) => s.folderId === folder.id);
          const open = !collapsed[folder.id];
          return (
            <div key={folder.id} className="mb-1">
              <button
                type="button"
                onClick={() => toggleFolder(folder.id)}
                className="flex w-full items-center gap-1.5 h-7 px-1.5 rounded-[var(--radius-sm)] text-xs font-medium text-pc-text-secondary hover:bg-[var(--pc-hover)] hover:text-pc-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]"
              >
                {open
                  ? <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  : <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />}
                <span className="truncate">{folderLabel(folder)}</span>
                <span className="ml-auto text-[10px] text-pc-text-faint tabular-nums">{kids.length}</span>
              </button>
              {open && kids.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  active={session.id === activeSessionId}
                  indicator={indicators[session.id]}
                  closable={!closableLast}
                  buttonRef={(el) => { sessionRefs.current[session.id] = el; }}
                  onSelect={() => onSelect(session.id)}
                  onClose={() => onClose(session.id)}
                  onKeyDown={(e) => handleSessionKeyDown(e, session.id)}
                />
              ))}
            </div>
          );
        })}

        {orphans.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            active={session.id === activeSessionId}
            indicator={indicators[session.id]}
            closable={!closableLast}
            buttonRef={(el) => { sessionRefs.current[session.id] = el; }}
            onSelect={() => onSelect(session.id)}
            onClose={() => onClose(session.id)}
            onKeyDown={(e) => handleSessionKeyDown(e, session.id)}
          />
        ))}
      </nav>
    </aside>
  );
}

function SessionRow({
  session,
  active,
  indicator,
  closable,
  buttonRef,
  onSelect,
  onClose,
  onKeyDown,
}: {
  session: WorkbenchSession;
  active: boolean;
  indicator?: SessionIndicator;
  closable: boolean;
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
        'group flex w-full items-center gap-1.5 h-8 pl-6 pr-1 rounded-[var(--radius-sm)]',
        'text-xs text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]',
        active
          ? 'bg-pc-accent/10 text-pc-accent'
          : 'text-pc-text-secondary hover:bg-[var(--pc-hover)] hover:text-pc-text',
      ].join(' ')}
    >
      <StatusDot streaming={indicator?.streaming} unread={indicator?.unread} active={active} />
      <MessageSquare className="h-3 w-3 shrink-0" aria-hidden />
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
          'inline-flex items-center justify-center h-5 w-5 rounded-[var(--radius-sm)] shrink-0',
          'text-pc-text-muted transition-colors opacity-0 group-hover:opacity-100',
          closable ? 'hover:bg-status-error/15 hover:text-status-error cursor-pointer' : 'cursor-not-allowed',
        ].join(' ')}
      >
        <X className="h-3 w-3" />
      </span>
    </button>
  );
}

function StatusDot({ streaming, unread, active }: { streaming?: boolean; unread?: boolean; active: boolean }) {
  if (streaming) {
    return (
      <span className="relative inline-flex h-1.5 w-1.5 shrink-0" aria-hidden>
        <span className="absolute inline-flex h-full w-full rounded-full bg-pc-accent opacity-60 animate-ping" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-pc-accent" />
      </span>
    );
  }
  if (unread) {
    return <span className="inline-flex h-1.5 w-1.5 shrink-0 rounded-full bg-pc-accent" aria-hidden />;
  }
  return (
    <span
      className={['inline-flex h-1.5 w-1.5 shrink-0 rounded-full', active ? 'bg-pc-accent/40' : 'bg-pc-text-faint/40'].join(' ')}
      aria-hidden
    />
  );
}

export default WorkbenchSidebar;
