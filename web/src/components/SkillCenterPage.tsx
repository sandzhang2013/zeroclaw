import { useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import { SkillFileBrowser } from '@/components/MySkillsPage';
import {
  allocateSkillId,
  ApiError,
  createSkillCenter,
  listSkillCenter,
  listSkillCenterFiles,
  publishSkillCenter,
  readSkillCenter,
  readSkillCenterFile,
  reviewSkillCenter,
  submitSkillCenter,
  unpublishSkillCenter,
  updateSkillCenter,
  type SkillCenterSkill,
} from '@/lib/api';
import { t } from '@/lib/i18n';
import { isIssuedSkillId, skillIdTakenKey } from '@/lib/personalSkill';

type View =
  | { kind: 'list' }
  | { kind: 'create'; name: string; title: string; description: string; body: string }
  | { kind: 'detail'; skill: SkillCenterSkill };

const STATUSES = ['', 'draft', 'pending', 'approved', 'rejected', 'published', 'offline'] as const;

function statusLabel(status: string): string {
  switch (status) {
    case 'draft':
      return t('workbench.skill_center_status_draft');
    case 'pending':
      return t('workbench.skill_center_status_pending');
    case 'approved':
      return t('workbench.skill_center_status_approved');
    case 'rejected':
      return t('workbench.skill_center_status_rejected');
    case 'published':
      return t('workbench.skill_center_status_published');
    case 'offline':
      return t('workbench.skill_center_status_offline');
    default:
      return t('workbench.skill_center_status_all');
  }
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'pending':
      return 'border-status-warning/40 bg-status-warning/20 text-status-warning';
    case 'approved':
      return 'border-status-info/40 bg-status-info/20 text-status-info';
    case 'published':
      return 'border-status-success/40 bg-status-success/20 text-status-success';
    case 'rejected':
      return 'border-status-error/40 bg-status-error/20 text-status-error';
    case 'offline':
      return 'border-pc-border bg-pc-input text-pc-text-secondary';
    default:
      return 'border-pc-accent/40 bg-pc-accent/15 text-pc-accent';
  }
}

function canEditContent(status: string): boolean {
  return status === 'draft' || status === 'rejected' || status === 'offline';
}

function editLockHint(status: string): string | null {
  if (status === 'pending') return t('workbench.skill_center_locked_pending');
  if (status === 'approved') return t('workbench.skill_center_locked_approved');
  if (status === 'published') return t('workbench.skill_center_locked_published');
  return null;
}

function creatorLabel(skill: { creator_id?: string; creator_name?: string }): string {
  const name = skill.creator_name?.trim() ?? '';
  const id = skill.creator_id?.trim() ?? '';
  if (name && id && name !== id) return `${name} (${id})`;
  return name || id;
}

function skillWriteError(err: unknown, fallbackKey: string): string {
  const message = err instanceof Error ? err.message : '';
  return t(skillIdTakenKey(message) ?? fallbackKey);
}

export function SkillCenterPage({
  userName,
  onClose,
}: {
  userName?: string;
  onClose?: () => void;
}) {
  const [skills, setSkills] = useState<SkillCenterSkill[]>([]);
  const [filter, setFilter] = useState('');
  const [view, setView] = useState<View>({ kind: 'list' });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');

  async function reload() {
    const { skills: next } = await listSkillCenter();
    setSkills(next);
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listSkillCenter()
      .then(({ skills: next }) => {
        if (!cancelled) setSkills(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : t('workbench.skill_center_failed'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visible = useMemo(
    () => skills.filter((skill) => !filter || skill.status === filter),
    [skills, filter],
  );

  async function openSkill(id: string) {
    setError(null);
    setNote('');
    try {
      setView({ kind: 'detail', skill: await readSkillCenter(id) });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('workbench.skill_center_failed'));
    }
  }

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      await reload();
    } catch (err) {
      setError(skillWriteError(err, 'workbench.skill_center_failed'));
    } finally {
      setBusy(false);
    }
  }

  const detail = view.kind === 'detail' ? view.skill : null;
  const editable = detail ? canEditContent(detail.status) : false;
  const lockHint = detail ? editLockHint(detail.status) : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-pc-surface">
      <div className="flex shrink-0 items-center gap-2 border-b border-pc-border px-4 py-3">
        <h1 className="text-sm font-semibold text-pc-text">{t('workbench.skill_center')}</h1>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setError(null);
              void (async () => {
                try {
                  const { id } = await allocateSkillId();
                  setView({ kind: 'create', name: id, title: '', description: '', body: '' });
                } catch (err) {
                  setError(skillWriteError(err, 'workbench.skill_center_failed'));
                }
              })();
            }}
            className="inline-flex h-8 items-center gap-1 rounded-[8px] border border-pc-border px-2.5 text-sm text-pc-text hover:bg-[var(--pc-hover)]"
          >
            <Plus className="size-3.5" />
            {t('workbench.skill_center_create')}
          </button>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="h-8 rounded-[8px] px-2.5 text-sm text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-pc-text"
            >
              {t('workbench.my_skills_back')}
            </button>
          ) : null}
        </div>
      </div>
      <div className={['min-h-0 flex-1 px-4 py-4', detail ? 'flex flex-col overflow-hidden' : 'overflow-y-auto'].join(' ')}>
        {error ? <p className="mb-3 text-xs text-status-error">{error}</p> : null}
        {view.kind === 'create' ? (
          <form
            className="mx-auto flex max-w-2xl flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const name = view.name.trim();
              if (!isIssuedSkillId(name) || !view.description.trim() || !view.body.trim()) return;
              void run(async () => {
                const created = await createSkillCenter({
                  name,
                  title: view.title.trim() || name,
                  description: view.description,
                  body: view.body,
                  displayName: userName,
                });
                setView({ kind: 'list' });
                await openSkill(created.id);
              });
            }}
          >
            <label className="block text-xs font-medium text-pc-text-secondary">
              {t('workbench.home_edit_skill_id')}
              <input
                value={view.name}
                readOnly
                className="mt-1 h-9 w-full rounded-[10px] border border-pc-border bg-pc-input px-3 font-mono text-sm text-pc-text read-only:opacity-70"
              />
              <p className="mt-1 font-normal text-pc-text-muted">{t('workbench.skill_id_rule')}</p>
            </label>
            <label className="block text-xs font-medium text-pc-text-secondary">
              {t('workbench.save_skill_name')}
              <input
                value={view.title}
                onChange={(event) => setView({ ...view, title: event.target.value })}
                className="mt-1 h-9 w-full rounded-[10px] border border-pc-border bg-pc-input px-3 text-sm text-pc-text"
              />
            </label>
            <label className="block text-xs font-medium text-pc-text-secondary">
              {t('workbench.save_skill_description')}
              <input
                value={view.description}
                onChange={(event) => setView({ ...view, description: event.target.value })}
                className="mt-1 h-9 w-full rounded-[10px] border border-pc-border bg-pc-input px-3 text-sm text-pc-text"
              />
            </label>
            <label className="block text-xs font-medium text-pc-text-secondary">
              {t('workbench.save_skill_body')}
              <textarea
                value={view.body}
                onChange={(event) => setView({ ...view, body: event.target.value })}
                className="mt-1 min-h-[16rem] w-full rounded-[10px] border border-pc-border bg-pc-input px-3 py-2 text-sm text-pc-text"
                spellCheck={false}
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setView({ kind: 'list' })}
                className="h-9 rounded-[8px] px-3 text-sm text-pc-text-muted hover:bg-[var(--pc-hover)]"
              >
                {t('workbench.my_skills_back')}
              </button>
              <button
                type="submit"
                disabled={busy || !view.name.trim() || !view.description.trim() || !view.body.trim()}
                className="h-9 rounded-[8px] bg-pc-text px-3 text-sm font-medium text-pc-base disabled:opacity-40"
              >
                {t('workbench.skill_center_create')}
              </button>
            </div>
          </form>
        ) : detail ? (
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-2 md:[grid-template-rows:minmax(0,1fr)]">
            <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
              <div>
                <h2 className="text-sm font-semibold text-pc-text">{detail.title || detail.id}</h2>
                <p className="mt-1 font-mono text-xs text-pc-text-muted">
                  {t('workbench.home_edit_skill_id')} {detail.id}
                </p>
              </div>
              <dl className="grid grid-cols-[5rem_1fr] gap-y-1 text-xs">
                <dt className="text-pc-text-muted">{t('workbench.skill_center_creator')}</dt>
                <dd className="text-pc-text">{creatorLabel(detail)}</dd>
                <dt className="text-pc-text-muted">{t('workbench.skill_center_status')}</dt>
                <dd className="text-pc-text">{statusLabel(detail.status)}</dd>
                <dt className="text-pc-text-muted">{t('workbench.skill_center_version')}</dt>
                <dd className="text-pc-text">{detail.version ? String(detail.version) : ''}</dd>
                <dt className="text-pc-text-muted">{t('workbench.skill_center_published_at')}</dt>
                <dd className="text-pc-text">{detail.published_at ?? ''}</dd>
              </dl>
              {detail.reject_reason ? (
                <p className="text-xs text-status-error">
                  {t('workbench.skill_center_reject_reason')} {detail.reject_reason}
                </p>
              ) : null}
              {lockHint ? <p className="text-xs text-pc-text-secondary">{lockHint}</p> : null}
              <label className="block text-xs font-medium text-pc-text-secondary">
                {t('workbench.save_skill_name')}
                <input
                  value={detail.title}
                  readOnly={!editable}
                  onChange={(event) => setView({ kind: 'detail', skill: { ...detail, title: event.target.value } })}
                  className="mt-1 h-9 w-full rounded-[10px] border border-pc-border bg-pc-input px-3 text-sm text-pc-text read-only:opacity-70"
                />
              </label>
              <label className="block text-xs font-medium text-pc-text-secondary">
                {t('workbench.save_skill_description')}
                <input
                  value={detail.description}
                  readOnly={!editable}
                  onChange={(event) => setView({ kind: 'detail', skill: { ...detail, description: event.target.value } })}
                  className="mt-1 h-9 w-full rounded-[10px] border border-pc-border bg-pc-input px-3 text-sm text-pc-text read-only:opacity-70"
                />
              </label>
              <label className="flex min-h-0 flex-col text-xs font-medium text-pc-text-secondary">
                {t('workbench.save_skill_body')}
                <textarea
                  value={detail.body ?? ''}
                  readOnly={!editable}
                  onChange={(event) => setView({ kind: 'detail', skill: { ...detail, body: event.target.value } })}
                  className="mt-1 min-h-[12rem] rounded-[10px] border border-pc-border bg-pc-input px-3 py-2 text-sm text-pc-text read-only:opacity-70"
                  spellCheck={false}
                />
              </label>
              {(detail.releases ?? []).length > 0 ? (
                <div>
                  <p className="text-xs font-medium text-pc-text-secondary">{t('workbench.skill_center_releases')}</p>
                  <ul className="mt-1 space-y-1 text-xs text-pc-text-muted">
                    {detail.releases?.map((release) => (
                      <li key={`${release.version}-${release.published_at}`}>
                        {release.version} · {release.published_at}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {detail.status === 'pending' || detail.status === 'approved' ? (
                <label className="block text-xs font-medium text-pc-text-secondary">
                  {t('workbench.skill_center_reject_reason')}
                  <input
                    value={note}
                    onChange={(event) => setNote(event.target.value)}
                    className="mt-1 h-9 w-full rounded-[10px] border border-pc-border bg-pc-input px-3 text-sm text-pc-text"
                  />
                </label>
              ) : null}
              <div className="flex flex-wrap justify-end gap-2">
                <button type="button" onClick={() => setView({ kind: 'list' })} className="h-9 rounded-[8px] px-3 text-sm text-pc-text-muted hover:bg-[var(--pc-hover)]">
                  {t('workbench.my_skills_back')}
                </button>
                {editable ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      void run(async () => {
                        const saved = await updateSkillCenter({
                          id: detail.id,
                          title: detail.title,
                          description: detail.description,
                          body: detail.body,
                        });
                        setView({ kind: 'detail', skill: { ...detail, status: saved.status } });
                      });
                    }}
                    className="h-9 rounded-[8px] border border-pc-border px-3 text-sm text-pc-text"
                  >
                    {t('workbench.skill_center_save')}
                  </button>
                ) : null}
                {detail.status === 'draft' || detail.status === 'rejected' || detail.status === 'offline' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      void run(async () => {
                        await submitSkillCenter(detail.id, userName);
                        await openSkill(detail.id);
                      });
                    }}
                    className="h-9 rounded-[8px] border border-pc-border px-3 text-sm text-pc-text"
                  >
                    {t('workbench.skill_center_submit')}
                  </button>
                ) : null}
                {detail.status === 'pending' || detail.status === 'approved' ? (
                  <button
                    type="button"
                    disabled={busy || !note.trim()}
                    onClick={() => {
                      void run(async () => {
                        await reviewSkillCenter(detail.id, 'reject', note.trim());
                        await openSkill(detail.id);
                      });
                    }}
                    className="h-9 rounded-[8px] border border-pc-border px-3 text-sm text-pc-text disabled:opacity-40"
                  >
                    {t('workbench.skill_center_reject')}
                  </button>
                ) : null}
                {detail.status === 'pending' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      void run(async () => {
                        await reviewSkillCenter(detail.id, 'approve');
                        await openSkill(detail.id);
                      });
                    }}
                    className="h-9 rounded-[8px] border border-pc-border px-3 text-sm text-pc-text"
                  >
                    {t('workbench.skill_center_approve')}
                  </button>
                ) : null}
                {detail.status === 'approved' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      void run(async () => {
                        await publishSkillCenter(detail.id);
                        await openSkill(detail.id);
                      });
                    }}
                    className="h-9 rounded-[8px] bg-pc-text px-3 text-sm font-medium text-pc-base"
                  >
                    {t('workbench.skill_center_publish')}
                  </button>
                ) : null}
                {detail.on_plaza || detail.status === 'published' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      void run(async () => {
                        await unpublishSkillCenter(detail.id);
                        await openSkill(detail.id);
                      });
                    }}
                    className="h-9 rounded-[8px] border border-pc-border px-3 text-sm text-status-error"
                  >
                    {t('workbench.skill_center_unpublish')}
                  </button>
                ) : null}
              </div>
            </div>
            <SkillFileBrowser
              filesKey={`center:${detail.id}:${detail.status}`}
              loadList={() => listSkillCenterFiles(detail.id).then((res) => res.files)}
              loadFile={(path) => readSkillCenterFile(detail.id, path)}
            />
          </div>
        ) : (
          <>
            <p className="mb-3 text-xs text-pc-text-muted">{t('workbench.skill_center_hint')}</p>
            <div className="mb-4 flex flex-wrap gap-1">
              {STATUSES.map((status) => (
                <button
                  key={status || 'all'}
                  type="button"
                  onClick={() => setFilter(status)}
                  className={[
                    'h-7 rounded-full px-2.5 text-xs',
                    filter === status ? 'bg-pc-text text-pc-base' : 'text-pc-text hover:bg-[var(--pc-hover)]',
                  ].join(' ')}
                >
                  {statusLabel(status)}
                </button>
              ))}
            </div>
            {loading ? (
              <p className="py-16 text-center text-sm text-pc-text-muted">{t('workbench.my_skills_loading')}</p>
            ) : visible.length === 0 ? (
              <p className="py-16 text-center text-sm text-pc-text-muted">{t('workbench.skill_center_empty')}</p>
            ) : (
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
                {visible.map((skill) => (
                  <li key={skill.id}>
                    <button
                      type="button"
                      onClick={() => {
                        void openSkill(skill.id);
                      }}
                      className="relative flex h-full w-full flex-col rounded-[12px] border border-pc-border bg-pc-elevated p-4 text-left"
                    >
                      <span
                        className={[
                          'absolute right-3 top-3 rounded-full border px-2 py-0.5 text-[11px] font-semibold',
                          statusBadgeClass(skill.status),
                        ].join(' ')}
                      >
                        {statusLabel(skill.status)}
                      </span>
                      <span className="truncate pr-16 text-sm font-semibold text-pc-text">{skill.title || skill.id}</span>
                      <span className="mt-1 truncate font-mono text-xs text-pc-text-muted">{skill.id}</span>
                      <span className="mt-2 line-clamp-3 text-xs leading-relaxed text-pc-text-muted">
                        {skill.description}
                      </span>
                      {creatorLabel(skill) ? (
                        <span className="mt-2 truncate text-xs text-pc-text-muted">{creatorLabel(skill)}</span>
                      ) : null}
                      {skill.version || skill.published_at ? (
                        <span className="mt-1 text-xs text-pc-text-muted">
                          {skill.version ? `${t('workbench.skill_center_version')} ${skill.version}` : ''}
                          {skill.version && skill.published_at ? ' · ' : ''}
                          {skill.published_at ?? ''}
                        </span>
                      ) : null}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  );
}
