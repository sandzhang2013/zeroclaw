import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Eye, Globe, Link2, Pencil, Plus, Sparkles, TextQuote, Trash2 } from 'lucide-react';
import { t } from '@/lib/i18n';
import {
  estimatePromptTokens,
  quickPromptExpansion,
  removeQuickPrompt,
  upsertQuickPrompt,
  type QuickPrompt,
} from '@/lib/quickPrompts';
import { persistQuickPrompts, useQuickPrompts } from '@/lib/useQuickPrompts';

export function QuickPromptButton({
  userId,
  disabled,
  dropUp = true,
  onInsert,
}: {
  userId?: string;
  disabled?: boolean;
  /** Session composer opens upward. The home composer opens downward. */
  dropUp?: boolean;
  onInsert: (body: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [maintain, setMaintain] = useState(false);
  const prompts = useQuickPrompts(userId);
  const [sharedOnly, setSharedOnly] = useState(false);
  const [active, setActive] = useState(0);
  const [draftId, setDraftId] = useState<string | undefined>();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [shared, setShared] = useState(false);
  const [preview, setPreview] = useState(false);
  const [box, setBox] = useState<{
    left: number;
    width: number;
    maxHeight: number;
    top?: number;
    bottom?: number;
  } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const shown = useMemo(
    () => (sharedOnly ? prompts.filter((prompt) => prompt.shared) : prompts),
    [prompts, sharedOnly],
  );
  const activeIndex = shown.length === 0 ? 0 : Math.min(active, shown.length - 1);
  const current = shown[activeIndex];

  useEffect(() => {
    function onDoc(event: MouseEvent) {
      const target = event.target as Node;
      if (wrapRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
      setMaintain(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  useEffect(() => {
    if (!open) return;
    function place() {
      const anchor = wrapRef.current;
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(360, window.innerWidth - 16);
      let left = rect.left;
      if (left + width > window.innerWidth - 8) left = window.innerWidth - 8 - width;
      if (left < 8) left = 8;
      if (dropUp) {
        const bottom = window.innerHeight - rect.top + 6;
        setBox({
          left,
          width,
          bottom,
          maxHeight: Math.max(120, Math.min(rect.top - 16, window.innerHeight * 0.5)),
        });
        return;
      }
      const top = rect.bottom + 6;
      setBox({
        left,
        width,
        top,
        maxHeight: Math.max(120, Math.min(window.innerHeight - top - 8, window.innerHeight * 0.5)),
      });
    }
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, maintain, dropUp]);

  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  function write(next: QuickPrompt[]) {
    void persistQuickPrompts(userId, next);
  }

  function insert(prompt: QuickPrompt) {
    onInsert(prompt.body);
    setOpen(false);
    setMaintain(false);
  }

  function clearDraft() {
    setDraftId(undefined);
    setTitle('');
    setBody('');
    setShared(false);
    setPreview(false);
  }

  function beginEdit(prompt?: QuickPrompt) {
    setMaintain(true);
    setPreview(false);
    setDraftId(prompt?.id);
    setTitle(prompt?.title ?? '');
    setBody(prompt?.body ?? '');
    setShared(Boolean(prompt?.shared));
  }

  function saveDraft() {
    const next = upsertQuickPrompt(prompts, { id: draftId, title, body, shared });
    if (!next) return;
    write(next);
    clearDraft();
    setMaintain(false);
  }

  const panel = open && box ? createPortal(
    <div
      ref={panelRef}
      className="fixed z-50 flex flex-col overflow-hidden rounded-xl border border-pc-border bg-pc-surface shadow-[var(--pc-shadow-sm)]"
      style={{ left: box.left, width: box.width, top: box.top, bottom: box.bottom, maxHeight: box.maxHeight }}
    >
      {maintain ? (
        <Editor
          maxHeight={box.maxHeight}
          title={title}
          body={body}
          shared={shared}
          preview={preview}
          prompts={prompts}
          onTitle={setTitle}
          onBody={setBody}
          onShared={setShared}
          onPreview={setPreview}
          onBack={() => {
            setMaintain(false);
            clearDraft();
          }}
          onSave={saveDraft}
          onEdit={beginEdit}
          onDelete={(id) => write(removeQuickPrompt(prompts, id))}
        />
      ) : (
        <>
          <ul className="max-h-[min(16rem,50vh)] min-h-0 overflow-y-auto px-2 pt-1">
            {shown.length === 0 ? (
              <li className="px-2 py-1 text-sm text-pc-text-muted">{t('workbench.quick_prompts_empty')}</li>
            ) : shown.map((prompt, index) => (
              <li key={prompt.id}>
                <button
                  type="button"
                  data-active={index === activeIndex ? 'true' : 'false'}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => insert(prompt)}
                  className={[
                    'flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm',
                    index === activeIndex ? 'bg-[var(--pc-bg-code)]' : 'hover:bg-[var(--pc-hover)]',
                  ].join(' ')}
                >
                  <Sparkles className="size-4 shrink-0 text-pc-text" />
                  <span className="min-w-0 flex-1 truncate text-pc-text">{prompt.title}</span>
                  <span className="ml-auto min-w-0 max-w-[58%] truncate text-pc-text-muted">{prompt.body}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-0.5 px-3 pt-1.5 pb-2 text-sm text-pc-text-muted">
            <span className="px-1.5">{t('workbench.quick_prompts')}</span>
            <IconButton label={t('workbench.quick_prompts_add')} onClick={() => beginEdit()}>
              <Plus className="size-3.5" />
            </IconButton>
            <IconButton
              label={t('workbench.quick_prompts_edit')}
              disabled={!current}
              onClick={() => current && beginEdit(current)}
            >
              <Link2 className="size-3.5" />
            </IconButton>
            <IconButton
              label={sharedOnly ? t('workbench.quick_prompts_show_all') : t('workbench.quick_prompts_only_shared')}
              pressed={sharedOnly}
              onClick={() => {
                setSharedOnly((value) => !value);
                setActive(0);
              }}
            >
              <Globe className="size-3.5" />
            </IconButton>
          </div>
        </>
      )}
    </div>,
    document.body,
  ) : null;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setOpen((value) => {
            const next = !value;
            if (next) setActive(0);
            else setMaintain(false);
            return next;
          });
        }}
        className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-pc-text disabled:opacity-40"
        aria-label={t('workbench.quick_prompts')}
        aria-expanded={open}
        title={t('workbench.quick_prompts')}
      >
        <TextQuote className="size-4 shrink-0" />
        <span className="max-w-[6rem] truncate">{t('workbench.quick_prompts')}</span>
        <ChevronDown className="size-3 shrink-0" />
      </button>
      {panel}
    </div>
  );
}

export function QuickPromptSendHint({
  text,
  prompts,
}: {
  text: string;
  prompts: QuickPrompt[];
}) {
  const match = quickPromptExpansion(text, prompts);
  if (!match) return null;
  return (
    <p className="px-1 pb-1 text-xs text-pc-text-muted">
      {t('workbench.quick_prompts_send_hint').replace('{title}', match.title)}
    </p>
  );
}

function IconButton({
  label,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={[
        'inline-flex size-6 items-center justify-center rounded-md hover:bg-[var(--pc-hover)] hover:text-pc-text disabled:opacity-40',
        pressed ? 'bg-[var(--pc-hover)] text-pc-text' : '',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

function Editor({
  maxHeight,
  title,
  body,
  shared,
  preview,
  prompts,
  onTitle,
  onBody,
  onShared,
  onPreview,
  onBack,
  onSave,
  onEdit,
  onDelete,
}: {
  maxHeight: number;
  title: string;
  body: string;
  shared: boolean;
  preview: boolean;
  prompts: QuickPrompt[];
  onTitle: (value: string) => void;
  onBody: (value: string) => void;
  onShared: (value: boolean) => void;
  onPreview: (value: boolean) => void;
  onBack: () => void;
  onSave: () => void;
  onEdit: (prompt: QuickPrompt) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="overflow-y-auto" style={{ maxHeight }}>
      <div className="flex items-center justify-between gap-2 border-b border-pc-border px-3 py-2">
        <span className="text-xs font-medium text-pc-text">{t('workbench.quick_prompts')}</span>
        <button type="button" onClick={onBack} className="text-xs text-pc-text-secondary hover:text-pc-text">
          {t('workbench.quick_prompts_done')}
        </button>
      </div>
      <div className="flex flex-col gap-3 p-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold text-pc-text">{t('workbench.quick_prompts_title')}</span>
          <input
            value={title}
            onChange={(event) => onTitle(event.target.value)}
            placeholder={t('workbench.quick_prompts_title_input')}
            className="h-10 rounded-lg border border-pc-border bg-pc-elevated px-3 text-sm text-pc-text outline-none focus:border-[var(--pc-accent)] focus:shadow-[0_0_0_3px_var(--pc-accent-glow)]"
          />
        </label>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-semibold text-pc-text">{t('workbench.quick_prompts_body')}</span>
            <button
              type="button"
              onClick={() => onPreview(!preview)}
              aria-pressed={preview}
              className={[
                'inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs',
                preview
                  ? 'border-[var(--pc-accent)] text-pc-text'
                  : 'border-pc-border text-pc-text-muted hover:text-pc-text',
              ].join(' ')}
            >
              <Eye className="size-3.5" />
              {t('workbench.quick_prompts_preview')}
            </button>
          </div>
          {preview ? (
            <div
              onDoubleClick={() => onPreview(false)}
              className="min-h-36 whitespace-pre-wrap rounded-lg border border-pc-border bg-pc-elevated px-3 py-2 text-sm leading-relaxed text-pc-text"
            >
              {body || <span className="text-pc-text-muted">{t('workbench.quick_prompts_body_input')}</span>}
            </div>
          ) : (
            <textarea
              value={body}
              onChange={(event) => onBody(event.target.value)}
              placeholder={t('workbench.quick_prompts_body_input')}
              rows={6}
              className="min-h-36 resize-y rounded-lg border border-pc-border bg-pc-elevated px-3 py-2 text-sm leading-relaxed text-pc-text outline-none focus:border-[var(--pc-accent)] focus:shadow-[0_0_0_3px_var(--pc-accent-glow)]"
            />
          )}
          <div className="flex items-center justify-between gap-2 text-xs text-pc-text-muted">
            <span>{t('workbench.quick_prompts_preview_hint')}</span>
            <span>{t('workbench.quick_prompts_tokens').replace('{n}', String(estimatePromptTokens(body)))}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-pc-text">{t('workbench.quick_prompts_shared')}</span>
          <button
            type="button"
            role="switch"
            aria-checked={shared}
            aria-label={t('workbench.quick_prompts_shared')}
            onClick={() => onShared(!shared)}
            className={[
              'relative h-5 w-9 rounded-full transition-colors',
              shared ? 'bg-[var(--pc-accent)]' : 'bg-pc-border',
            ].join(' ')}
          >
            <span
              className="absolute top-0.5 size-4 rounded-full bg-white shadow-sm transition-all"
              style={{ left: shared ? '18px' : '2px' }}
            />
          </button>
        </div>
        <button
          type="button"
          onClick={onSave}
          disabled={!title.trim() || !body.trim()}
          className="h-8 rounded-md bg-pc-text text-sm text-pc-base disabled:opacity-40"
        >
          {t('workbench.quick_prompts_save')}
        </button>
      </div>
      <ul className="border-t border-pc-border py-1">
        {prompts.length === 0 ? (
          <li className="px-3 py-2 text-xs text-pc-text-muted">{t('workbench.quick_prompts_empty')}</li>
        ) : prompts.map((prompt) => (
          <li key={prompt.id} className="flex items-center gap-1 px-1">
            <button
              type="button"
              onClick={() => onEdit(prompt)}
              className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm text-pc-text hover:bg-[var(--pc-hover)]"
            >
              <span className="min-w-0 flex-1 truncate">{prompt.title}</span>
              {prompt.shared ? (
                <span className="shrink-0 text-xs text-pc-text-muted">{t('workbench.quick_prompts_shared_badge')}</span>
              ) : null}
            </button>
            <button
              type="button"
              onClick={() => onEdit(prompt)}
              className="inline-flex size-7 items-center justify-center rounded text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-pc-text"
              aria-label={t('workbench.quick_prompts_edit')}
            >
              <Pencil className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onDelete(prompt.id)}
              className="inline-flex size-7 items-center justify-center rounded text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-pc-text"
              aria-label={t('workbench.quick_prompts_delete')}
            >
              <Trash2 className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
