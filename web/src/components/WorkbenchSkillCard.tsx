import type { ReactNode } from 'react';
import { t } from '@/lib/i18n';

/** Display name for a skill creator. Empty when the catalog never recorded one. */
export function skillCreatorLabel(skill: { creator_id?: string; creator_name?: string }): string {
  const name = skill.creator_name?.trim() ?? '';
  const id = skill.creator_id?.trim() ?? '';
  if (name && id && name !== id) return `${name} (${id})`;
  return name || id;
}

/** `版本 N · 日期`, omitting either side when it is missing. */
export function skillVersionLine(version?: string | number | null, publishedAt?: string | null): string {
  const raw = version == null ? '' : String(version).trim();
  const versionText = raw && raw !== '0' ? `${t('workbench.skill_center_version')} ${raw}` : '';
  const date = (publishedAt ?? '').trim();
  return [versionText, date].filter(Boolean).join(' · ');
}

/** Shared skill-card body. The corner badge, status notes, and footer stay with the caller. */
export function WorkbenchSkillCard({
  title,
  id,
  description,
  versionLine,
  creator,
  statusText,
  badge,
  notes,
  footer,
  onOpen,
  dimmed,
}: {
  title: string;
  id: string;
  description: string;
  versionLine?: string;
  creator?: string;
  statusText?: string;
  badge?: ReactNode;
  notes?: ReactNode;
  footer?: ReactNode;
  onOpen?: () => void;
  dimmed?: boolean;
}) {
  const meta = [versionLine, creator, statusText].filter(Boolean).join(' · ');
  const body = (
    <>
      <h3 className={['truncate text-sm font-semibold leading-5 text-pc-text', badge ? 'pr-16' : ''].join(' ')}>
        {title.trim() || id}
      </h3>
      <p className="mt-0.5 truncate text-[11px] leading-4 text-pc-text-muted">
        <span className="font-mono">{id}</span>
        {meta ? ` · ${meta}` : ''}
      </p>
      <p className="mt-1 line-clamp-2 text-xs leading-5 text-pc-text-muted">
        {description.trim() || t('workbench.my_skills_no_description')}
      </p>
      {notes}
    </>
  );

  return (
    <article
      className={[
        'relative flex flex-col self-start rounded-[10px] border border-pc-border bg-pc-elevated p-3',
        dimmed ? 'opacity-60' : '',
      ].join(' ')}
    >
      {badge ? <div className="absolute right-2 top-2">{badge}</div> : null}
      {onOpen ? (
        <button type="button" onClick={onOpen} className="min-w-0 text-left">
          {body}
        </button>
      ) : (
        <div className="min-w-0 text-left">{body}</div>
      )}
      {footer ? <div className="mt-2">{footer}</div> : null}
    </article>
  );
}
