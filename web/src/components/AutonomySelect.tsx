import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ShieldCheck } from 'lucide-react';
import { t } from '@/lib/i18n';
import {
  autonomyLevelsUpTo,
  autonomyLabelKey,
  type WorkbenchAutonomy,
} from '@/lib/workbenchAutonomy';

export function AutonomySelect({
  value,
  onChange,
  disabled,
  dropUp = true,
  maxLevel = 'full',
}: {
  value: WorkbenchAutonomy;
  onChange: (level: WorkbenchAutonomy) => void;
  disabled?: boolean;
  dropUp?: boolean;
  maxLevel?: WorkbenchAutonomy;
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
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-pc-text disabled:opacity-40"
        aria-label={t('workbench.mode_label')}
        title={t('workbench.mode_label')}
      >
        <ShieldCheck className="size-4 shrink-0" />
        <span className="max-w-[7.5rem] truncate">{t(autonomyLabelKey(value))}</span>
        <ChevronDown className="size-3 shrink-0" />
      </button>
      {open && (
        <div
          className={[
            'absolute left-0 z-50 min-w-[10rem] overflow-hidden rounded-xl border border-pc-border bg-pc-elevated py-1 shadow-[var(--pc-shadow-md)]',
            dropUp ? 'bottom-[calc(100%+8px)]' : 'top-[calc(100%+8px)]',
          ].join(' ')}
        >
          {autonomyLevelsUpTo(maxLevel).map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => {
                onChange(level);
                setOpen(false);
              }}
              className={[
                'block w-full truncate px-3 py-2 text-left text-sm hover:bg-[var(--pc-hover)]',
                level === value ? 'font-medium text-pc-text' : 'text-pc-text-secondary',
              ].join(' ')}
            >
              {t(autonomyLabelKey(level))}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
