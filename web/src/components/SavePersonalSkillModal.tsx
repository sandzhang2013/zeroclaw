import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import { useFocusTrap, FOCUSABLE_SELECTOR_FORM } from '@/hooks/useFocusTrap';
import { t } from '@/lib/i18n';
import type { PersonalSkillDraft } from '@/lib/personalSkill';

export function SavePersonalSkillModal({
  open,
  draft,
  onChange,
  onClose,
  onSave,
  busy,
  error,
}: {
  open: boolean;
  draft: PersonalSkillDraft;
  onChange: (next: PersonalSkillDraft) => void;
  onClose: () => void;
  onSave: () => void;
  busy?: boolean;
  error?: string | null;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const hintId = useId();
  const canSave = Boolean(draft.name.trim() && draft.body.trim()) && !busy;

  useFocusTrap(panelRef, {
    onClose,
    enabled: open,
    focusableSelector: FOCUSABLE_SELECTOR_FORM,
    preventDefaultOnEscape: true,
  });

  useEffect(() => {
    if (!open) return;
    nameRef.current?.focus();
    nameRef.current?.select();
  }, [open]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={hintId}
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-pc-base/70 backdrop-blur-sm" />
      <div
        ref={panelRef}
        className="relative flex max-h-[85vh] w-full max-w-2xl flex-col rounded-[var(--radius-xl)] border border-pc-border bg-pc-base shadow-[var(--pc-shadow-md)] animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-pc-border px-5 py-3">
          <h2 id={titleId} className="text-sm font-semibold text-pc-text">
            {t('workbench.save_skill_title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="inline-flex size-8 items-center justify-center rounded-[var(--radius-md)] text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-pc-text"
          >
            <X className="size-4" />
          </button>
        </div>
        <p id={hintId} className="shrink-0 px-5 pt-3 text-xs leading-relaxed text-pc-text-muted">
          {t('workbench.save_skill_hint')}
        </p>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 py-3">
          <label className="block text-xs font-medium text-pc-text-secondary">
            {t('workbench.save_skill_name')}
            <input
              ref={nameRef}
              value={draft.name}
              onChange={(e) => onChange({ ...draft, name: e.target.value })}
              className="mt-1 h-9 w-full rounded-[10px] border border-pc-border bg-pc-input px-3 text-sm text-pc-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]"
            />
          </label>
          <label className="block text-xs font-medium text-pc-text-secondary">
            {t('workbench.save_skill_description')}
            <input
              value={draft.description}
              onChange={(e) => onChange({ ...draft, description: e.target.value })}
              className="mt-1 h-9 w-full rounded-[10px] border border-pc-border bg-pc-input px-3 text-sm text-pc-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]"
            />
          </label>
          <label className="flex min-h-0 flex-1 flex-col text-xs font-medium text-pc-text-secondary">
            {t('workbench.save_skill_body')}
            <textarea
              value={draft.body}
              onChange={(e) => onChange({ ...draft, body: e.target.value })}
              className="mt-1 min-h-[12rem] flex-1 resize-y rounded-[10px] border border-pc-border bg-pc-input px-3 py-2 text-sm leading-relaxed text-pc-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]"
              spellCheck={false}
            />
          </label>
          {error ? <p className="text-xs text-status-error">{error}</p> : null}
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-pc-border px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-[8px] px-3 text-sm text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-pc-text"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={!canSave}
            onClick={onSave}
            className="h-9 rounded-[8px] bg-pc-text px-3 text-sm font-medium text-pc-base disabled:cursor-default disabled:opacity-40"
          >
            {busy ? t('workbench.save_skill_saving') : t('workbench.save_skill_confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
