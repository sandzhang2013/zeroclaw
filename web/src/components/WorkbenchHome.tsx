import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  BarChart3,
  Building2,
  ChevronDown,
  ClipboardList,
  FileText,
  Folder,
  Map,
  Search,
  ShieldAlert,
  Syringe,
  ArrowUp,
  Mic,
  Plus,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { t } from '@/lib/i18n';
import { getStatus } from '@/lib/api';
import { DEFAULT_FOLDER_ID, type WorkbenchFolder } from '@/pages/ChatWorkspace';
import { AutonomySelect } from '@/components/AutonomySelect';
import {
  DEFAULT_WORKBENCH_AUTONOMY,
  loadWorkbenchAutonomy,
  saveWorkbenchAutonomy,
  clampWorkbenchAutonomy,
  maxAutonomyForRole,
  type WorkbenchAutonomy,
} from '@/lib/workbenchAutonomy';
import {
  CHAT_UPLOAD_MAX_BYTES,
  CHAT_UPLOAD_MAX_FILES,
  uniqueUploadFileName,
} from '@/lib/chatUpload';

type TabId = 'query' | 'monitor' | 'report';

const TABS: { id: TabId; labelKey: string }[] = [
  { id: 'query', labelKey: 'workbench.home_tab_query' },
  { id: 'monitor', labelKey: 'workbench.home_tab_monitor' },
  { id: 'report', labelKey: 'workbench.home_tab_report' },
];

const CAPS: Record<TabId, { icon: LucideIcon; labelKey: string; promptKey: string }[]> = {
  query: [
    { icon: Activity, labelKey: 'workbench.home_cap_outbreak', promptKey: 'workbench.home_cap_outbreak_prompt' },
    { icon: Syringe, labelKey: 'workbench.home_cap_vaccine', promptKey: 'workbench.home_cap_vaccine_prompt' },
    { icon: Search, labelKey: 'workbench.home_cap_cases', promptKey: 'workbench.home_cap_cases_prompt' },
    { icon: Building2, labelKey: 'workbench.home_cap_orgs', promptKey: 'workbench.home_cap_orgs_prompt' },
  ],
  monitor: [
    { icon: BarChart3, labelKey: 'workbench.home_cap_trend', promptKey: 'workbench.home_cap_trend_prompt' },
    { icon: ShieldAlert, labelKey: 'workbench.home_cap_cluster', promptKey: 'workbench.home_cap_cluster_prompt' },
    { icon: Activity, labelKey: 'workbench.home_cap_alert', promptKey: 'workbench.home_cap_alert_prompt' },
    { icon: Map, labelKey: 'workbench.home_cap_region', promptKey: 'workbench.home_cap_region_prompt' },
  ],
  report: [
    { icon: FileText, labelKey: 'workbench.home_cap_brief', promptKey: 'workbench.home_cap_brief_prompt' },
    { icon: ClipboardList, labelKey: 'workbench.home_cap_weekly', promptKey: 'workbench.home_cap_weekly_prompt' },
    { icon: FileText, labelKey: 'workbench.home_cap_special', promptKey: 'workbench.home_cap_special_prompt' },
    { icon: ClipboardList, labelKey: 'workbench.home_cap_minutes', promptKey: 'workbench.home_cap_minutes_prompt' },
  ],
};

type HomeAttach = {
  id: string;
  file: File;
  filename: string;
  previewUrl?: string;
};

export function WorkbenchHome({
  onSend,
  folders,
  activeFolderId,
  onSelectFolder,
  agentAlias,
  userRole,
}: {
  onSend: (text: string, autonomy: WorkbenchAutonomy, files: File[]) => void;
  folders: WorkbenchFolder[];
  activeFolderId: string;
  onSelectFolder: (folderId: string) => void;
  agentAlias: string;
  userRole?: string;
}) {
  const [input, setInput] = useState('');
  const [tab, setTab] = useState<TabId>('query');
  const [model, setModel] = useState<string>('');
  const maxAutonomy = maxAutonomyForRole(userRole);
  const [autonomy, setAutonomy] = useState<WorkbenchAutonomy>(() =>
    clampWorkbenchAutonomy(
      loadWorkbenchAutonomy('home') || DEFAULT_WORKBENCH_AUTONOMY,
      maxAutonomy,
    ),
  );
  const [attachments, setAttachments] = useState<HomeAttach[]>([]);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const [attachHint, setAttachHint] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const canSend = input.trim().length > 0 || attachments.length > 0;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    getStatus(agentAlias)
      .then((status) => {
        if (!cancelled) setModel(status.model || agentAlias);
      })
      .catch(() => {
        if (!cancelled) setModel(agentAlias);
      });
    return () => { cancelled = true; };
  }, [agentAlias]);

  function submit() {
    const trimmed = input.trim();
    if (!trimmed && attachments.length === 0) return;
    onSend(trimmed, autonomy, attachments.map((a) => a.file));
    for (const a of attachments) {
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    }
    setAttachments([]);
    setAttachHint(null);
    setInput('');
    inputRef.current?.focus();
  }

  function addFiles(fileList: File[]) {
    if (fileList.length === 0) return;
    setAttachHint(null);
    const prev = attachmentsRef.current;
    let room = Math.max(0, CHAT_UPLOAD_MAX_FILES - prev.length);
    if (fileList.length > room) setAttachHint(t('workbench.attach_too_many'));
    const extras: HomeAttach[] = [];
    const used = prev.map((a) => a.filename);
    for (const file of fileList) {
      if (room <= 0) break;
      if (file.size > CHAT_UPLOAD_MAX_BYTES) {
        setAttachHint(t('workbench.attach_too_large').replace('{name}', file.name));
        continue;
      }
      const filename = uniqueUploadFileName(used, file.name);
      used.push(filename);
      extras.push({
        id: crypto.randomUUID(),
        file,
        filename,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
      });
      room -= 1;
    }
    if (extras.length === 0) return;
    setAttachments((cur) => [...cur, ...extras]);
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }

  function applyPrompt(text: string) {
    setInput(text);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(text.length, text.length);
    });
  }

  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col overflow-auto">
      <div className="mx-auto w-full max-w-[920px] px-8 pb-10 pt-[18vh]">
        <div className="mb-6 text-center">
          <h1 className="mb-2 text-[32px] font-semibold leading-snug tracking-tight text-pc-text">
            {t('workbench.home_title')}
          </h1>
          <p className="mb-5 text-[15px] text-pc-text-muted">
            {t('workbench.home_subtitle')}
          </p>
          <div className="flex items-center justify-center">
            <div
              className="inline-flex items-center rounded-full p-1"
              style={{ background: 'color-mix(in srgb, var(--pc-text-primary) 8%, transparent)' }}
            >
              {TABS.map((item) => {
                const active = item.id === tab;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setTab(item.id)}
                    className={[
                      'rounded-full px-[22px] py-2 text-sm font-medium transition-colors',
                      active ? 'bg-pc-text text-pc-base' : 'text-pc-text hover:bg-[var(--pc-hover)]',
                    ].join(' ')}
                  >
                    {t(item.labelKey)}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="mb-4 flex h-11 items-center gap-2 overflow-x-auto">
          {CAPS[tab].map(({ icon: Icon, labelKey, promptKey }) => (
            <button
              key={labelKey}
              type="button"
              onClick={() => applyPrompt(t(promptKey))}
              className="inline-flex shrink-0 items-center gap-2 rounded-full border border-pc-border bg-pc-surface px-[18px] py-[9px] text-sm text-pc-text-secondary transition-colors hover:bg-[var(--pc-hover)] hover:text-pc-text"
            >
              <Icon className="size-4 shrink-0" />
              {t(labelKey)}
            </button>
          ))}
        </div>

        <div
          className="relative z-20 mb-3 rounded-2xl border border-pc-border-strong bg-pc-elevated shadow-[var(--pc-shadow-sm)]"
          onDragEnter={(e) => {
            e.preventDefault();
            if (e.dataTransfer.types.includes('Files')) setDragOver(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            if (e.dataTransfer.types.includes('Files')) setDragOver(true);
          }}
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node)) return;
            setDragOver(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            addFiles([...e.dataTransfer.files]);
          }}
        >
          {dragOver && (
            <div className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-xl border-2 border-dashed border-pc-accent bg-pc-accent/10">
              <p className="text-sm font-medium text-pc-accent">{t('workbench.attach_drop')}</p>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              addFiles([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
          <div className="flex min-h-[132px] flex-col px-4 pt-4 pb-2.5">
            {attachments.length > 0 && (
              <ul className="mb-2 flex flex-wrap gap-1.5">
                {attachments.map((file) => (
                  <li
                    key={file.id}
                    className="flex max-w-full items-center gap-1.5 rounded-md border border-pc-border bg-pc-surface px-2 py-1 text-xs text-pc-text"
                  >
                    {file.previewUrl ? (
                      <img src={file.previewUrl} alt="" className="size-6 rounded object-cover" />
                    ) : null}
                    <span className="min-w-0 truncate" title={file.filename}>
                      {file.filename}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeAttachment(file.id)}
                      className="inline-flex size-5 items-center justify-center rounded text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-pc-text"
                      aria-label={t('workbench.attach_remove')}
                      title={t('workbench.attach_remove')}
                    >
                      <X className="size-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !composingRef.current) {
                  e.preventDefault();
                  submit();
                }
              }}
              onPaste={(e) => {
                const files = [...e.clipboardData.files];
                if (files.length === 0) return;
                e.preventDefault();
                addFiles(files);
              }}
              onCompositionStart={() => { composingRef.current = true; }}
              onCompositionEnd={() => { composingRef.current = false; }}
              placeholder={t('workbench.home_placeholder')}
              className="min-h-[72px] w-full flex-1 resize-none bg-transparent text-[15px] leading-[1.7] text-pc-text placeholder:text-pc-text-faint outline-none focus:outline-none focus-visible:outline-none"
            />
            <div className="flex items-center justify-between gap-2 pt-1">
              <div className="flex min-w-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-pc-text"
                  aria-label={t('workbench.attach_file')}
                  title={t('workbench.attach_file')}
                >
                  <Plus className="size-4" />
                </button>
                <FooterSelect
                  icon={Folder}
                  label={workspaceLabel(folders, activeFolderId)}
                  options={folders.map((folder) => ({
                    id: folder.id,
                    label: folder.id === DEFAULT_FOLDER_ID ? t('workbench.folder_default') : folder.name,
                  }))}
                  value={activeFolderId}
                  onChange={onSelectFolder}
                />
                <AutonomySelect
                  value={autonomy}
                  maxLevel={maxAutonomy}
                  dropUp={false}
                  onChange={(level) => {
                    const next = clampWorkbenchAutonomy(level, maxAutonomy);
                    setAutonomy(next);
                    saveWorkbenchAutonomy('home', next);
                  }}
                />
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="inline-flex min-w-0 items-center gap-1 text-sm">
                  <span className="max-w-[14rem] truncate text-pc-text-secondary">
                    {model || t('workbench.home_model_loading')}
                  </span>
                  <span className="shrink-0 text-pc-text-muted">{t('workbench.home_model_effort')}</span>
                  <ChevronDown className="size-3 shrink-0 text-pc-text-muted" />
                </span>
                <button
                  type="button"
                  disabled
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-pc-text-muted opacity-60"
                  aria-label={t('workbench.voice_input')}
                  title={t('workbench.voice_soon')}
                >
                  <Mic className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={submit}
                  disabled={!canSend}
                  className={[
                    'inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-opacity',
                    canSend ? 'hover:opacity-90' : 'opacity-50 cursor-not-allowed',
                  ].join(' ')}
                  style={{
                    background: canSend ? 'var(--pc-text-primary)' : 'color-mix(in srgb, var(--pc-text-primary) 42%, white)',
                    color: '#fff',
                  }}
                  aria-label={t('agent.send')}
                >
                  <ArrowUp className="size-4" strokeWidth={2.5} />
                </button>
              </div>
            </div>
          </div>
        </div>
        {attachHint && (
          <p className="mt-1 text-[11px] text-status-error">{attachHint}</p>
        )}
      </div>
    </div>
  );
}

function workspaceLabel(folders: WorkbenchFolder[], activeFolderId: string): string {
  if (activeFolderId === DEFAULT_FOLDER_ID) return t('workbench.home_workspace');
  const folder = folders.find((f) => f.id === activeFolderId);
  return folder?.name?.trim() || t('workbench.home_workspace');
}

function FooterSelect({
  icon: Icon,
  label,
  options,
  value,
  onChange,
}: {
  icon: LucideIcon;
  label: string;
  options: { id: string; label: string }[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 text-sm text-pc-text-muted hover:text-pc-text"
      >
        <Icon className="size-4 shrink-0" />
        <span className="max-w-[10rem] truncate">{label}</span>
        <ChevronDown className="size-3 shrink-0" />
      </button>
      {open && (
        <div className="absolute bottom-[calc(100%+8px)] left-0 z-30 min-w-[10rem] overflow-hidden rounded-xl border border-pc-border bg-pc-elevated py-1 shadow-[var(--pc-shadow-md)]">
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => {
                onChange(option.id);
                setOpen(false);
              }}
              className={[
                'block w-full truncate px-3 py-2 text-left text-sm hover:bg-[var(--pc-hover)]',
                option.id === value ? 'text-pc-text font-medium' : 'text-pc-text-secondary',
              ].join(' ')}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default WorkbenchHome;
