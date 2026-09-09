import { X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { t } from '@/lib/i18n';

/** Skill tag carried from the home catalog into the session composer and bubbles. */
export function HomeSkillChip({
  label,
  icon: Icon,
  onClear,
}: {
  label: string;
  icon?: LucideIcon | null;
  onClear?: () => void;
}) {
  return (
    <span className="inline-flex h-[1.7em] max-w-full shrink-0 items-center gap-1 rounded-full border border-pc-border bg-pc-surface py-0 pl-2 pr-1 text-xs text-pc-text">
      {Icon ? <Icon className="size-3.5 shrink-0 text-pc-text-secondary" /> : null}
      <span className="truncate">{label}</span>
      {onClear ? (
        <button
          type="button"
          onClick={onClear}
          className="inline-flex size-5 items-center justify-center rounded-full text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-pc-text"
          aria-label={t('workbench.home_clear_skill')}
          title={t('workbench.home_clear_skill')}
        >
          <X className="size-3" />
        </button>
      ) : null}
    </span>
  );
}
