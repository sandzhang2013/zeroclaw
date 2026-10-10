import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { t } from '@/lib/i18n';
import {
  DISLIKE_REASONS,
  type DislikeReason,
  type TurnVerdict,
} from '@/lib/turnFeedback';

const REASON_KEY: Record<DislikeReason, string> = {
  wrong_data: 'workbench.feedback_reason_wrong_data',
  unhelpful: 'workbench.feedback_reason_unhelpful',
  unsafe: 'workbench.feedback_reason_unsafe',
  other: 'workbench.feedback_reason_other',
};

export function TurnFeedbackButtons({
  verdict,
  disabled,
  onLike,
  onDislike,
}: {
  verdict?: TurnVerdict;
  disabled?: boolean;
  onLike: () => void;
  onDislike: () => void;
}) {
  return (
    <div className="mt-1 flex items-center gap-0.5">
      <button
        type="button"
        disabled={disabled}
        aria-pressed={verdict === 'like'}
        aria-label={t('workbench.feedback_like')}
        onClick={onLike}
        className={[
          'inline-flex size-7 items-center justify-center rounded-md text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-pc-text disabled:opacity-40',
          verdict === 'like' ? 'text-pc-accent' : '',
        ].join(' ')}
      >
        <ThumbsUp className={['size-3.5', verdict === 'like' ? 'fill-current' : ''].join(' ')} />
      </button>
      <button
        type="button"
        disabled={disabled}
        aria-pressed={verdict === 'dislike'}
        aria-label={t('workbench.feedback_dislike')}
        onClick={onDislike}
        className={[
          'inline-flex size-7 items-center justify-center rounded-md text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-pc-text disabled:opacity-40',
          verdict === 'dislike' ? 'text-pc-accent' : '',
        ].join(' ')}
      >
        <ThumbsDown className={['size-3.5', verdict === 'dislike' ? 'fill-current' : ''].join(' ')} />
      </button>
    </div>
  );
}

export function DislikeFeedbackDialog({
  reason,
  comment,
  saving,
  error,
  onClose,
  onSubmit,
}: {
  reason?: DislikeReason;
  comment: string;
  saving?: boolean;
  error?: string | null;
  onClose: () => void;
  onSubmit: (reason: DislikeReason | null, comment: string) => void;
}) {
  const [picked, setPicked] = useState<DislikeReason | null>(reason ?? null);
  const [text, setText] = useState(comment);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label={t('common.cancel')}
        className="absolute inset-0 bg-black/30"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="turn-feedback-title"
        className="relative w-full max-w-md rounded-2xl border border-pc-border bg-pc-elevated p-5 shadow-[var(--pc-shadow-md)]"
      >
        <h2 id="turn-feedback-title" className="text-base font-semibold text-pc-text">
          {t('workbench.feedback_title')}
        </h2>
        <div className="mt-4 flex flex-wrap gap-2">
          {DISLIKE_REASONS.map((item) => {
            const selected = picked === item;
            return (
              <button
                key={item}
                type="button"
                aria-pressed={selected}
                onClick={() => setPicked(selected ? null : item)}
                className={[
                  'rounded-full border px-3 py-1.5 text-sm',
                  selected
                    ? 'border-pc-accent bg-pc-accent/10 text-pc-text'
                    : 'border-pc-border text-pc-text-secondary hover:bg-[var(--pc-hover)]',
                ].join(' ')}
              >
                {t(REASON_KEY[item])}
              </button>
            );
          })}
        </div>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value.slice(0, 1000))}
          placeholder={t('workbench.feedback_placeholder')}
          rows={5}
          className="mt-4 w-full resize-none rounded-2xl border border-pc-accent/70 bg-pc-input px-3 py-2 text-sm text-pc-text placeholder:text-pc-text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]"
        />
        {error ? <p className="mt-2 text-xs text-status-error">{error}</p> : null}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-pc-border px-4 py-1.5 text-sm text-pc-text hover:bg-[var(--pc-hover)]"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => onSubmit(picked, text.trim())}
            className="rounded-full bg-pc-accent px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40"
          >
            {t('workbench.feedback_submit')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
