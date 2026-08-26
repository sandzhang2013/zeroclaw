import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import { useFocusTrap, FOCUSABLE_SELECTOR_FORM } from '@/hooks/useFocusTrap';
import { t } from '@/lib/i18n';

export function OutlineEditModal({
  open,
  value,
  onChange,
  onClose,
  onContinue,
  busy,
}: {
  open: boolean;
  value: string;
  onChange: (text: string) => void;
  onClose: () => void;
  onContinue: () => void;
  busy?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const hintId = useId();
  const canContinue = Boolean(value.trim()) && !busy;

  useFocusTrap(panelRef, {
    onClose,
    enabled: open,
    focusableSelector: FOCUSABLE_SELECTOR_FORM,
    preventDefaultOnEscape: true,
  });

  useEffect(() => {
    if (!open) return;
    textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(0, 0);
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
            {t('workbench.outline_title')}
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
          {t('workbench.outline_hint')}
        </p>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t('workbench.outline_placeholder')}
          className="mx-5 mt-3 min-h-[16rem] flex-1 resize-y rounded-[10px] border border-pc-border bg-pc-input px-3 py-2 text-sm leading-relaxed text-pc-text placeholder:text-pc-text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]"
          spellCheck={false}
        />
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
            disabled={!canContinue}
            onClick={onContinue}
            className="h-9 rounded-[8px] bg-pc-text px-3 text-sm font-medium text-pc-base disabled:cursor-default disabled:opacity-40"
          >
            {t('workbench.outline_continue')}
          </button>
        </div>
      </div>
    </div>
  );
}
