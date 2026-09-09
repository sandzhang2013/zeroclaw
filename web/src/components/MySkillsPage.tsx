import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BookOpen, ChevronDown, Plus, Search, Store, Trash2, Wrench } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui';
import {
  ApiError,
  deletePersonalSkill,
  listPersonalSkills,
  readPersonalSkill,
  savePersonalSkill,
  setPersonalSkillEnabled,
  updatePersonalSkill,
  type PersonalSkillDetail,
  type PersonalSkillSummary,
} from '@/lib/api';
import { getLocale, t } from '@/lib/i18n';
import { filterPersonalSkills, isPersonalSkillEnabled, skillSlug } from '@/lib/personalSkill';
import {
  filterPlazaSkills,
  installedSkillNames,
  isPlazaInstalled,
  resolvePlazaSkills,
  type PlazaSkillView,
} from '@/lib/skillPlaza';

type Pane = 'mine' | 'plaza';
type View =
  | { kind: 'browse' }
  | { kind: 'create'; draft: PersonalSkillDetail }
  | { kind: 'edit'; draft: PersonalSkillDetail }
  | { kind: 'plaza-detail'; skill: PlazaSkillView };

function emptyDraft(): PersonalSkillDetail {
  return { name: '', title: '', description: '', body: '', enabled: true };
}

export function MySkillsPage({
  agent,
}: {
  agent: string;
  onClose?: () => void;
}) {
  const [skills, setSkills] = useState<PersonalSkillSummary[]>([]);
  const [query, setQuery] = useState('');
  const [pane, setPane] = useState<Pane>('mine');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: 'browse' });
  const [saving, setSaving] = useState(false);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const addRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listPersonalSkills(agent)
      .then(({ skills: next }) => {
        if (!cancelled) setSkills(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : t('workbench.my_skills_failed'));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agent]);

  useEffect(() => {
    if (!addOpen) return;
    const onDoc = (event: MouseEvent) => {
      if (!addRef.current?.contains(event.target as Node)) setAddOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [addOpen]);

  const installed = useMemo(() => installedSkillNames(skills), [skills]);
  const mine = useMemo(() => filterPersonalSkills(skills, query), [skills, query]);
  const plaza = useMemo(
    () => filterPlazaSkills(resolvePlazaSkills(getLocale(), 'recommended'), query),
    [query],
  );

  function showPane(next: Pane) {
    setPane(next);
    setView({ kind: 'browse' });
    setAddOpen(false);
  }

  async function openSkill(name: string) {
    setError(null);
    try {
      const detail = await readPersonalSkill(agent, name);
      setView({ kind: 'edit', draft: detail });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('workbench.my_skills_failed'));
    }
  }

  async function installPlaza(skill: PlazaSkillView) {
    if (isPlazaInstalled(skill.id, installed) || installingId) return;
    setInstallingId(skill.id);
    setError(null);
    try {
      await savePersonalSkill({
        agent,
        name: skill.id,
        title: skill.title,
        description: skill.description,
        body: skill.body,
      });
      setSkills((prev) =>
        [...prev, { name: skill.id, title: skill.title, description: skill.description, enabled: true }].sort(
          (a, b) => a.name.localeCompare(b.name),
        ),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('workbench.save_skill_failed'));
    } finally {
      setInstallingId(null);
    }
  }

  async function saveDraft() {
    if (view.kind !== 'create' && view.kind !== 'edit') return;
    const draft = view.draft;
    const name = view.kind === 'create' ? skillSlug(draft.name || draft.title) : draft.name;
    if (!name || !draft.body.trim()) return;
    setSaving(true);
    setError(null);
    try {
      if (view.kind === 'create') {
        await savePersonalSkill({
          agent,
          name,
          title: draft.title || name,
          description: draft.description,
          body: draft.body,
        });
        setSkills((prev) =>
          [...prev, { name, title: draft.title || name, description: draft.description, enabled: true }].sort(
            (a, b) => a.name.localeCompare(b.name),
          ),
        );
      } else {
        await updatePersonalSkill({
          agent,
          name,
          title: draft.title || name,
          description: draft.description,
          body: draft.body,
        });
        setSkills((prev) =>
          prev.map((row) =>
            row.name === name
              ? { ...row, title: draft.title || name, description: draft.description }
              : row,
          ),
        );
      }
      setView({ kind: 'browse' });
      setPane('mine');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('workbench.save_skill_failed'));
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const name = pendingDelete;
    setPendingDelete(null);
    setError(null);
    try {
      await deletePersonalSkill(agent, name);
      setSkills((prev) => prev.filter((row) => row.name !== name));
      if ((view.kind === 'create' || view.kind === 'edit') && view.draft.name === name) {
        setView({ kind: 'browse' });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('workbench.my_skills_delete_failed'));
    }
  }

  async function toggleEnabled(name: string, enabled: boolean) {
    if (toggling) return;
    setToggling(name);
    setError(null);
    setSkills((prev) => prev.map((row) => (row.name === name ? { ...row, enabled } : row)));
    try {
      await setPersonalSkillEnabled({ agent, name, enabled });
    } catch (err) {
      setSkills((prev) => prev.map((row) => (row.name === name ? { ...row, enabled: !enabled } : row)));
      setError(err instanceof ApiError ? err.message : t('workbench.my_skills_enable_failed'));
    } finally {
      setToggling(null);
    }
  }

  const editing = view.kind === 'create' || view.kind === 'edit';
  const plazaDetail = view.kind === 'plaza-detail' ? view.skill : null;
  const draft = editing ? view.draft : null;
  const canSave =
    Boolean(draft && (view.kind === 'edit' || skillSlug(draft.name || draft.title)) && draft.body.trim()) && !saving;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-pc-surface">
      <div className="flex shrink-0 items-center gap-2 border-b border-pc-border px-4 py-3">
        <div className="flex items-center gap-1">
          <TabButton
            active={pane === 'plaza' && !editing}
            icon={<Wrench className="size-3.5" />}
            label={t('workbench.skill_plaza')}
            onClick={() => showPane('plaza')}
          />
          <TabButton
            active={pane === 'mine' && !editing && !plazaDetail}
            icon={<BookOpen className="size-3.5" />}
            label={t('workbench.my_skills')}
            onClick={() => showPane('mine')}
          />
        </div>
        <label className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-pc-text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('workbench.my_skills_search')}
            className="h-8 w-full rounded-[8px] border border-pc-border bg-pc-input pl-9 pr-3 text-sm text-pc-text placeholder:text-pc-text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]"
          />
        </label>
        <div ref={addRef} className="relative">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={addOpen}
            onClick={() => setAddOpen((open) => !open)}
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-pc-border px-3 text-sm text-pc-text hover:bg-[var(--pc-hover)]"
          >
            <Plus className="size-4" />
            {t('workbench.my_skills_add')}
            <ChevronDown className="size-3.5 text-pc-text-muted" />
          </button>
          {addOpen ? (
            <div
              role="menu"
              className="absolute right-0 z-20 mt-1 min-w-[10rem] overflow-hidden rounded-[10px] border border-pc-border bg-pc-elevated py-1 shadow-lg"
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setAddOpen(false);
                  showPane('plaza');
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-pc-text hover:bg-[var(--pc-hover)]"
              >
                <Store className="size-3.5 text-pc-text-muted" />
                {t('workbench.skill_plaza_find')}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setAddOpen(false);
                  setView({ kind: 'create', draft: emptyDraft() });
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-pc-text hover:bg-[var(--pc-hover)]"
              >
                <Plus className="size-3.5 text-pc-text-muted" />
                {t('workbench.skill_plaza_create')}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {editing || plazaDetail ? null : pane === 'plaza' ? (
          <div className="mb-4 flex items-center gap-4 text-sm">
            <span className="font-medium text-pc-text">{t('workbench.skill_plaza_recommended')}</span>
          </div>
        ) : (
          <p className="mb-4 text-xs leading-relaxed text-pc-text-muted">{t('workbench.my_skills_hint')}</p>
        )}
        {error ? <p className="mb-3 text-xs text-status-error">{error}</p> : null}

        {editing && draft ? (
          <div className="mx-auto flex max-w-2xl flex-col gap-3">
            {view.kind === 'create' ? (
              <label className="block text-xs font-medium text-pc-text-secondary">
                {t('workbench.save_skill_name')}
                <input
                  value={draft.name}
                  onChange={(e) =>
                    setView({ kind: 'create', draft: { ...draft, name: e.target.value, title: e.target.value } })
                  }
                  className="mt-1 h-9 w-full rounded-[10px] border border-pc-border bg-pc-input px-3 text-sm text-pc-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]"
                />
              </label>
            ) : (
              <h2 className="text-sm font-semibold text-pc-text">{draft.title || draft.name}</h2>
            )}
            <label className="block text-xs font-medium text-pc-text-secondary">
              {t('workbench.save_skill_description')}
              <input
                value={draft.description}
                onChange={(e) => setView({ ...view, draft: { ...draft, description: e.target.value } })}
                className="mt-1 h-9 w-full rounded-[10px] border border-pc-border bg-pc-input px-3 text-sm text-pc-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]"
              />
            </label>
            <label className="flex min-h-0 flex-col text-xs font-medium text-pc-text-secondary">
              {t('workbench.save_skill_body')}
              <textarea
                value={draft.body}
                onChange={(e) => setView({ ...view, draft: { ...draft, body: e.target.value } })}
                className="mt-1 min-h-[16rem] resize-y rounded-[10px] border border-pc-border bg-pc-input px-3 py-2 text-sm leading-relaxed text-pc-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]"
                spellCheck={false}
              />
            </label>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setView({ kind: 'browse' })}
                className="h-9 rounded-[8px] px-3 text-sm text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-pc-text"
              >
                {t('workbench.my_skills_back')}
              </button>
              <button
                type="button"
                disabled={!canSave}
                onClick={() => {
                  void saveDraft();
                }}
                className="h-9 rounded-[8px] bg-pc-text px-3 text-sm font-medium text-pc-base disabled:cursor-default disabled:opacity-40"
              >
                {saving ? t('workbench.save_skill_saving') : t('workbench.save_skill_confirm')}
              </button>
            </div>
          </div>
        ) : plazaDetail ? (
          <div className="mx-auto flex max-w-2xl flex-col gap-3">
            <h2 className="text-sm font-semibold text-pc-text">{plazaDetail.title}</h2>
            <p className="text-sm leading-relaxed text-pc-text-muted">{plazaDetail.description}</p>
            <pre className="max-h-[24rem] overflow-auto whitespace-pre-wrap rounded-[10px] border border-pc-border bg-pc-input px-3 py-2 text-sm leading-relaxed text-pc-text">
              {plazaDetail.body}
            </pre>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setView({ kind: 'browse' })}
                className="h-9 rounded-[8px] px-3 text-sm text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-pc-text"
              >
                {t('workbench.my_skills_back')}
              </button>
              <button
                type="button"
                disabled={isPlazaInstalled(plazaDetail.id, installed) || installingId === plazaDetail.id}
                onClick={() => {
                  void installPlaza(plazaDetail);
                }}
                className="inline-flex h-9 items-center gap-1.5 rounded-[8px] bg-pc-text px-3 text-sm font-medium text-pc-base disabled:cursor-default disabled:opacity-40"
              >
                {isPlazaInstalled(plazaDetail.id, installed) ? (
                  t('workbench.skill_plaza_added')
                ) : installingId === plazaDetail.id ? (
                  t('workbench.skill_plaza_adding')
                ) : (
                  <>
                    <Plus className="size-3.5" />
                    {t('workbench.skill_plaza_add')}
                  </>
                )}
              </button>
            </div>
          </div>
        ) : loading ? (
          <p className="py-16 text-center text-sm text-pc-text-muted">{t('workbench.my_skills_loading')}</p>
        ) : pane === 'plaza' ? (
          plaza.length === 0 ? (
            <p className="py-20 text-center text-sm text-pc-text-muted">
              {query.trim() ? t('workbench.my_skills_search_empty') : t('workbench.skill_plaza_empty')}
            </p>
          ) : (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
              {plaza.map((skill) => {
                const added = isPlazaInstalled(skill.id, installed);
                const busy = installingId === skill.id;
                return (
                  <li key={skill.id}>
                    <article className="flex h-full flex-col rounded-[12px] border border-pc-border bg-pc-elevated p-4">
                      <button
                        type="button"
                        onClick={() => setView({ kind: 'plaza-detail', skill })}
                        className="min-w-0 flex-1 text-left"
                      >
                        <h3 className="truncate text-sm font-semibold text-pc-text">{skill.title}</h3>
                        <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-pc-text-muted">
                          {skill.description}
                        </p>
                      </button>
                      <div className="mt-3 flex justify-end">
                        <button
                          type="button"
                          disabled={added || busy}
                          onClick={(event) => {
                            event.stopPropagation();
                            void installPlaza(skill);
                          }}
                          className="inline-flex h-8 items-center gap-1 rounded-full border border-pc-border px-3 text-xs text-pc-text hover:bg-[var(--pc-hover)] disabled:cursor-default disabled:opacity-50"
                        >
                          {added ? (
                            t('workbench.skill_plaza_added')
                          ) : busy ? (
                            t('workbench.skill_plaza_adding')
                          ) : (
                            <>
                              <Plus className="size-3.5" />
                              {t('workbench.skill_plaza_add')}
                            </>
                          )}
                        </button>
                      </div>
                    </article>
                  </li>
                );
              })}
            </ul>
          )
        ) : mine.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
            <p className="text-sm text-pc-text-muted">
              {skills.length === 0 ? t('workbench.my_skills_empty') : t('workbench.my_skills_search_empty')}
            </p>
            {skills.length === 0 ? (
              <div className="flex flex-wrap justify-center gap-2">
                <button
                  type="button"
                  onClick={() => showPane('plaza')}
                  className="inline-flex h-9 items-center gap-1.5 rounded-full border border-pc-border px-3 text-sm text-pc-text hover:bg-[var(--pc-hover)]"
                >
                  <Store className="size-4" />
                  {t('workbench.skill_plaza_find')}
                </button>
                <button
                  type="button"
                  onClick={() => setView({ kind: 'create', draft: emptyDraft() })}
                  className="inline-flex h-9 items-center gap-1.5 rounded-full border border-pc-border px-3 text-sm text-pc-text hover:bg-[var(--pc-hover)]"
                >
                  <Plus className="size-4" />
                  {t('workbench.skill_plaza_create')}
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
            {mine.map((skill) => {
              const on = isPersonalSkillEnabled(skill);
              return (
              <li key={skill.name}>
                <article
                  className={[
                    'flex h-full flex-col rounded-[12px] border border-pc-border bg-pc-elevated p-4',
                    on ? '' : 'opacity-60',
                  ].join(' ')}
                >
                  <button
                    type="button"
                    onClick={() => {
                      void openSkill(skill.name);
                    }}
                    className="min-w-0 flex-1 text-left"
                  >
                    <h3 className="truncate text-sm font-semibold text-pc-text">{skill.title || skill.name}</h3>
                    <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-pc-text-muted">
                      {skill.description || t('workbench.my_skills_no_description')}
                    </p>
                  </button>
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <SkillEnableSwitch
                      enabled={on}
                      busy={toggling === skill.name}
                      onToggle={() => {
                        void toggleEnabled(skill.name, !on);
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => setPendingDelete(skill.name)}
                      className="inline-flex size-8 items-center justify-center rounded-[8px] text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-status-error"
                      aria-label={t('workbench.my_skills_delete')}
                      title={t('workbench.my_skills_delete')}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </article>
              </li>
              );
            })}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete != null}
        title={t('workbench.my_skills_delete_title')}
        message={t('workbench.my_skills_delete_hint')}
        confirmLabel={t('workbench.my_skills_delete')}
        danger
        onConfirm={() => {
          void confirmDelete();
        }}
        onClose={() => setPendingDelete(null)}
      />
    </div>
  );
}

function SkillEnableSwitch({
  enabled,
  busy,
  onToggle,
}: {
  enabled: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      disabled={busy}
      onClick={onToggle}
      aria-label={enabled ? t('workbench.my_skills_disable') : t('workbench.my_skills_enable')}
      title={enabled ? t('workbench.my_skills_disable') : t('workbench.my_skills_enable')}
      className={[
        'relative inline-flex h-[22px] w-[38px] flex-shrink-0 items-center rounded-full border transition-colors',
        enabled ? 'border-pc-text bg-pc-text' : 'border-pc-border bg-pc-input',
        busy ? 'cursor-default opacity-50' : 'cursor-pointer',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]',
      ].join(' ')}
    >
      <span
        className={[
          'inline-block size-4 transform rounded-full transition-transform',
          enabled ? 'translate-x-[18px] bg-pc-base' : 'translate-x-0.5 bg-pc-text-muted',
        ].join(' ')}
      />
    </button>
  );
}

function TabButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'inline-flex h-8 items-center gap-1.5 rounded-[8px] px-2.5 text-sm font-medium',
        active ? 'bg-pc-text text-pc-base' : 'text-pc-text hover:bg-[var(--pc-hover)]',
      ].join(' ')}
    >
      {icon}
      {label}
    </button>
  );
}
