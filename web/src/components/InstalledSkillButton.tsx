import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { listPersonalSkills, type PersonalSkillSummary } from '@/lib/api';
import { t } from '@/lib/i18n';

export type InstalledSkillPick = {
  id: string;
  title: string;
};

/** Pick one enabled personal skill. The parent attaches it to the next message. */
export function InstalledSkillButton({
  agent,
  disabled,
  onPick,
}: {
  agent: string;
  disabled?: boolean;
  onPick: (skill: InstalledSkillPick) => void;
}) {
  const [open, setOpen] = useState(false);
  const [skills, setSkills] = useState<PersonalSkillSummary[]>([]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(event: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStatus('loading');
    listPersonalSkills(agent)
      .then((data) => {
        if (cancelled) return;
        const enabled = (data.skills ?? [])
          .filter((skill) => skill.enabled !== false && !skill.blocked_reason)
          .sort((a, b) => (a.title || a.name).localeCompare(b.title || b.name));
        setSkills(enabled);
        setStatus('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setSkills([]);
        setStatus('error');
      });
    return () => { cancelled = true; };
  }, [open, agent]);

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-pc-text disabled:opacity-40"
        aria-label={t('workbench.attach_skill')}
        title={t('workbench.attach_skill')}
        aria-expanded={open}
      >
        <Sparkles className="size-4" />
      </button>
      {open ? (
        <div className="absolute bottom-[calc(100%+8px)] left-0 z-30 w-72 overflow-hidden rounded-xl border border-pc-border bg-pc-elevated py-1 shadow-[var(--pc-shadow-md)]">
          {status === 'loading' ? (
            <p className="px-3 py-2 text-xs text-pc-text-muted">{t('workbench.attach_skill_loading')}</p>
          ) : null}
          {status === 'error' ? (
            <p className="px-3 py-2 text-xs text-status-error">{t('workbench.attach_skill_failed')}</p>
          ) : null}
          {status === 'ready' && skills.length === 0 ? (
            <p className="px-3 py-2 text-xs text-pc-text-muted">{t('workbench.attach_skill_empty')}</p>
          ) : null}
          {status === 'ready' ? (
            <ul className="max-h-64 overflow-y-auto">
              {skills.map((skill) => (
                <li key={skill.name}>
                  <button
                    type="button"
                    onClick={() => {
                      onPick({ id: skill.name, title: skill.title || skill.name });
                      setOpen(false);
                    }}
                    className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-[var(--pc-hover)]"
                  >
                    <span className="w-full truncate text-sm text-pc-text">{skill.title || skill.name}</span>
                    {skill.description ? (
                      <span className="w-full truncate text-xs text-pc-text-muted">{skill.description}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
