import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BookOpen, ChevronDown, ChevronRight, File, FileArchive, Folder, FolderInput, Plus, Search, Store, Trash2, Wrench } from 'lucide-react';
import { ConfirmDialog } from '@/components/ui';
import { skillCreatorLabel, skillVersionLine, WorkbenchSkillCard } from '@/components/WorkbenchSkillCard';
import {
  allocateSkillId,
  ApiError,
  deletePersonalSkill,
  forkPersonalSkill,
  installPlazaSkill,
  listPersonalSkillFiles,
  listPersonalSkills,
  listPlazaSkillFiles,
  listSkillPlaza,
  readPersonalSkill,
  readPersonalSkillFile,
  readPlazaSkillFile,
  savePersonalSkill,
  setPersonalSkillEnabled,
  submitPersonalSkill,
  updatePersonalSkill,
  type PersonalSkillDetail,
  type PersonalSkillSummary,
} from '@/lib/api';
import { t } from '@/lib/i18n';
import { filterPersonalSkills, isIssuedSkillId, isPersonalSkillEnabled, skillIdTakenKey } from '@/lib/personalSkill';
import { skillDirPaths, skillFileTree, type SkillDirNode } from '@/lib/skillFileTree';
import { bytesToBase64, readSkillFromFiles, readSkillFromZip, skillImportErrorKey, type PackageFile } from '@/lib/skillPackage';
import {
  canRollBack,
  filterPlazaSkills,
  installedSkillNames,
  installedSkillStamp,
  isPlazaInstalled,
  mineSkillUpdateAvailable,
  plazaCardAction,
  releaseNoteText,
  type PlazaSkillView,
} from '@/lib/skillPlaza';

type Pane = 'mine' | 'plaza';
type View =
  | { kind: 'browse' }
  | { kind: 'create'; draft: PersonalSkillDetail }
  | { kind: 'edit'; draft: PersonalSkillDetail }
  | { kind: 'plaza-detail'; skill: PlazaSkillView };

function skillWriteError(err: unknown, fallbackKey: string): string {
  const message = err instanceof Error ? err.message : '';
  return t(skillIdTakenKey(message) ?? fallbackKey);
}

function emptyDraft(): PersonalSkillDetail {
  return { name: '', title: '', description: '', body: '', enabled: true };
}

function reviewStatusLabel(status: string): string {
  switch (status) {
    case 'draft':
      return t('workbench.skill_review_draft');
    case 'pending':
      return t('workbench.skill_review_pending');
    case 'approved':
      return t('workbench.skill_review_approved');
    case 'rejected':
      return t('workbench.skill_review_rejected');
    case 'published':
      return t('workbench.skill_review_published');
    case 'offline':
      return t('workbench.skill_review_offline');
    default:
      return '';
  }
}

function SkillSourceBadge({ fromPlaza }: { fromPlaza: boolean }) {
  const badge = fromPlaza
    ? {
        label: t('workbench.skill_source_plaza'),
        className: 'border-status-warning/40 bg-status-warning/20 text-status-warning',
      }
    : {
        label: t('workbench.skill_source_own'),
        className: 'border-status-success/40 bg-status-success/20 text-status-success',
      };
  return (
    <span
      className={[
        'inline-flex h-5 items-center rounded-full border px-1.5 text-[11px] font-semibold leading-none',
        badge.className,
      ].join(' ')}
    >
      {badge.label}
    </span>
  );
}

export function MySkillsPage({
  agent,
  userName,
}: {
  agent: string;
  userName?: string;
  onClose?: () => void;
}) {
  const [skills, setSkills] = useState<PersonalSkillSummary[]>([]);
  const [plazaSkills, setPlazaSkills] = useState<PlazaSkillView[]>([]);
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
  const [importing, setImporting] = useState(false);
  const addRef = useRef<HTMLDivElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const zipRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([listPersonalSkills(agent), listSkillPlaza()])
      .then(([{ skills: next }, { skills: shared }]) => {
        if (!cancelled) {
          setSkills(next);
          setPlazaSkills(
            shared.map((skill) => ({
              id: skill.name,
              title: skill.title,
              description: skill.description,
              body: skill.body,
              version: skill.version,
              publishedAt: skill.published_at,
              changeNote: skill.change_note,
              previousVersion: skill.previous_version ?? undefined,
              creatorId: skill.creator_id,
              creatorName: skill.creator_name,
            })),
          );
        }
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
  const plaza = useMemo(() => filterPlazaSkills(plazaSkills, query), [plazaSkills, query]);

  function plazaAction(skill: PlazaSkillView): 'add' | 'added' {
    return plazaCardAction(isPlazaInstalled(skill.id, installed));
  }

  function skillStampText(name: string, installedVersion?: string): string {
    const shared = plazaSkills.find((row) => row.id === name);
    const stamp = installedSkillStamp({
      installedVersion,
      plazaVersion: shared?.version,
      publishedAt: shared?.publishedAt,
    });
    return [
      stamp.version ? `${t('workbench.skill_center_version')} ${stamp.version}` : '',
      stamp.publishedAt,
    ].filter(Boolean).join(' · ');
  }

  function plazaCopyUpdate(name: string, fromPlaza: boolean, installedVersion?: string): PlazaSkillView | null {
    if (!fromPlaza) return null;
    const shared = plazaSkills.find((row) => row.id === name);
    if (!shared || !mineSkillUpdateAvailable({
      fromPlaza: true,
      plazaVersion: shared.version,
      installedVersion,
    })) {
      return null;
    }
    return shared;
  }

  function plazaNote(skill: PlazaSkillView | null): string {
    if (!skill) return '';
    return releaseNoteText(skill.changeNote);
  }

  function plazaPrevious(name: string, fromPlaza: boolean, installedVersion?: string): { skill: PlazaSkillView; version: number } | null {
    const shared = plazaSkills.find((row) => row.id === name);
    if (!shared || !canRollBack({
      fromPlaza,
      installedVersion,
      plazaVersion: shared.version,
      previousVersion: shared.previousVersion,
    }) || shared.previousVersion == null) {
      return null;
    }
    return { skill: shared, version: shared.previousVersion };
  }

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

  async function installPlaza(skill: PlazaSkillView, update = false, version?: number) {
    const already = isPlazaInstalled(skill.id, installed);
    if ((already && !update) || installingId) return;
    setInstallingId(skill.id);
    setError(null);
    try {
      const saved = await installPlazaSkill({ agent, name: skill.id, update, version });
      const viewing = view.kind === 'edit' && view.draft.name === skill.id;
      const fresh = update ? await readPersonalSkill(agent, skill.id) : null;
      if (viewing && fresh) {
        setView({ kind: 'edit', draft: fresh });
      }
      setSkills((prev) => {
        const kept = prev.find((row) => row.name === skill.id);
        const row: PersonalSkillSummary = {
          name: skill.id,
          title: fresh?.title || skill.title,
          description: fresh?.description || skill.description,
          enabled: kept?.enabled ?? true,
          version: fresh?.version ?? saved.version ?? skill.version,
          blocked_reason: kept?.blocked_reason,
          from_plaza: true,
          review_status: kept?.review_status,
        };
        return [...prev.filter((item) => item.name !== skill.id), row].sort((a, b) =>
          a.name.localeCompare(b.name),
        );
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setSkills((prev) =>
          prev.some((row) => row.name === skill.id)
            ? prev
            : [...prev, { name: skill.id, title: skill.title, description: skill.description, enabled: true, from_plaza: true }].sort(
                (a, b) => a.name.localeCompare(b.name),
              ),
        );
      } else {
        setError(skillWriteError(err, 'workbench.save_skill_failed'));
      }
    } finally {
      setInstallingId(null);
    }
  }

  async function beginCreate() {
    setAddOpen(false);
    setError(null);
    try {
      const { id } = await allocateSkillId();
      setView({ kind: 'create', draft: { ...emptyDraft(), name: id } });
    } catch (err) {
      setError(skillWriteError(err, 'workbench.save_skill_failed'));
    }
  }

  async function saveDraft() {
    if (view.kind !== 'create' && view.kind !== 'edit') return;
    const draft = view.draft;
    const name = draft.name.trim();
    if (!name || !draft.body.trim()) return;
    if (view.kind === 'create' && !isIssuedSkillId(name)) return;
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
      setError(skillWriteError(err, 'workbench.save_skill_failed'));
    } finally {
      setSaving(false);
    }
  }

  async function submitMine() {
    if (view.kind !== 'edit' || view.draft.from_plaza || saving) return;
    const draft = view.draft;
    setSaving(true);
    setError(null);
    try {
      const saved = await submitPersonalSkill({
        agent,
        name: draft.name,
        displayName: userName,
      });
      setSkills((prev) =>
        prev.map((row) => (row.name === draft.name ? { ...row, review_status: saved.status } : row)),
      );
      setView({ kind: 'edit', draft: { ...draft, review_status: saved.status } });
    } catch (err) {
      setError(skillWriteError(err, 'workbench.save_skill_failed'));
    } finally {
      setSaving(false);
    }
  }

  async function forkMine() {
    if (view.kind !== 'edit' || saving) return;
    const draft = view.draft;
    setSaving(true);
    setError(null);
    try {
      const { id } = await allocateSkillId();
      const saved = await forkPersonalSkill({ agent, name: draft.name, newName: id });
      const detail = await readPersonalSkill(agent, saved.name);
      setSkills((prev) =>
        [...prev, { name: saved.name, title: detail.title || saved.name, description: detail.description, enabled: true }].sort(
          (a, b) => a.name.localeCompare(b.name),
        ),
      );
      setView({ kind: 'edit', draft: detail });
    } catch (err) {
      setError(skillWriteError(err, 'workbench.save_skill_failed'));
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

  useEffect(() => {
    if (folderRef.current) folderRef.current.webkitdirectory = true;
  }, []);

  async function importPackage(kind: 'folder' | 'zip', files: File[]) {
    if (files.length === 0 || importing) return;
    setImporting(true);
    setError(null);
    setAddOpen(false);
    try {
      const zipFile = kind === 'zip' ? files[0] : undefined;
      if (kind === 'zip' && !zipFile) return;
      const parsed = zipFile
        ? await readSkillFromZip(await zipFile.arrayBuffer())
        : await readSkillFromFiles(packageFiles(files));
      if (!parsed.ok) {
        setError(t(skillImportErrorKey(parsed.error)));
        return;
      }
      const skill = parsed.skill;
      const owned = skills.filter((row) => !row.from_plaza && row.title === skill.title);
      const name = owned.length === 1 && owned[0] ? owned[0].name : (await allocateSkillId()).id;
      await savePersonalSkill({
        agent,
        name,
        title: skill.title,
        description: skill.description,
        body: skill.body,
        files: skill.files.map((file) => ({
          path: file.path,
          data_base64: bytesToBase64(file.bytes),
        })),
      });
      setSkills((prev) => {
        const kept = prev.find((row) => row.name === name);
        const row = {
          name,
          title: skill.title,
          description: skill.description,
          enabled: kept?.enabled ?? true,
        };
        return [...prev.filter((item) => item.name !== name), row].sort((a, b) => a.name.localeCompare(b.name));
      });
      setView({ kind: 'browse' });
      setPane('mine');
    } catch (err) {
      setError(skillWriteError(err, 'workbench.skill_import_failed'));
    } finally {
      setImporting(false);
    }
  }

  const editing = view.kind === 'create' || view.kind === 'edit';
  const plazaDetail = view.kind === 'plaza-detail' ? view.skill : null;
  const draft = editing ? view.draft : null;
  const fromPlaza = view.kind === 'edit' && draft?.from_plaza === true;
  const canSave =
    Boolean(
      draft
      && (view.kind === 'edit' || draft.name.trim())
      && draft.description.trim()
      && draft.body.trim(),
    ) && !saving;

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
                  void beginCreate();
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-pc-text hover:bg-[var(--pc-hover)]"
              >
                <Plus className="size-3.5 text-pc-text-muted" />
                {t('workbench.skill_plaza_create')}
              </button>
              <button
                type="button"
                role="menuitem"
                title={t('workbench.skill_import_rule')}
                disabled={importing}
                onClick={() => folderRef.current?.click()}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-pc-text hover:bg-[var(--pc-hover)] disabled:opacity-40"
              >
                <FolderInput className="size-3.5 text-pc-text-muted" />
                {t('workbench.skill_import_folder')}
              </button>
              <button
                type="button"
                role="menuitem"
                title={t('workbench.skill_import_rule')}
                disabled={importing}
                onClick={() => zipRef.current?.click()}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-pc-text hover:bg-[var(--pc-hover)] disabled:opacity-40"
              >
                <FileArchive className="size-3.5 text-pc-text-muted" />
                {t('workbench.skill_import_zip')}
              </button>
            </div>
          ) : null}
          <input
            ref={folderRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = '';
              void importPackage('folder', files);
            }}
          />
          <input
            ref={zipRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              event.target.value = '';
              void importPackage('zip', files);
            }}
          />
        </div>
      </div>

      <div
        className={[
          'min-h-0 flex-1 px-4 py-4',
          view.kind === 'edit' || plazaDetail ? 'flex flex-col overflow-hidden' : 'overflow-y-auto',
        ].join(' ')}
      >
        {editing || plazaDetail ? null : pane === 'plaza' ? (
          <div className="mb-4 flex items-center gap-4 text-sm">
            <span className="font-medium text-pc-text">{t('workbench.skill_plaza_recommended')}</span>
          </div>
        ) : (
          <p className="mb-4 text-xs leading-relaxed text-pc-text-muted">{t('workbench.my_skills_hint')}</p>
        )}
        {error ? <p className="mb-3 text-xs text-status-error">{error}</p> : null}

        {editing && draft ? (
          <div
            className={
              view.kind === 'edit'
                ? 'grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-2 md:[grid-template-rows:minmax(0,1fr)]'
                : 'mx-auto flex max-w-2xl flex-col gap-3'
            }
          >
            <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
            {view.kind === 'create' ? (
              <>
                <label className="block text-xs font-medium text-pc-text-secondary">
                  {t('workbench.home_edit_skill_id')}
                  <input
                    value={draft.name}
                    readOnly
                    className="mt-1 h-9 w-full rounded-[10px] border border-pc-border bg-pc-input px-3 font-mono text-sm text-pc-text read-only:opacity-70"
                  />
                  <p className="mt-1 font-normal text-pc-text-muted">{t('workbench.skill_id_rule')}</p>
                </label>
                <label className="block text-xs font-medium text-pc-text-secondary">
                  {t('workbench.save_skill_name')}
                  <input
                    value={draft.title}
                    onChange={(e) => setView({ kind: 'create', draft: { ...draft, title: e.target.value } })}
                    className="mt-1 h-9 w-full rounded-[10px] border border-pc-border bg-pc-input px-3 text-sm text-pc-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)]"
                  />
                </label>
              </>
            ) : (
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-semibold text-pc-text">{draft.title || draft.name}</h2>
                  <p className="mt-1 truncate font-mono text-xs text-pc-text-muted">
                    {t('workbench.home_edit_skill_id')} {draft.name}
                  </p>
                  {skillStampText(draft.name, skills.find((row) => row.name === draft.name)?.version) ? (
                    <p className="mt-1 text-xs text-pc-text-muted">
                      {skillStampText(draft.name, skills.find((row) => row.name === draft.name)?.version)}
                    </p>
                  ) : null}
                </div>
                <SkillSourceBadge fromPlaza={fromPlaza} />
              </div>
            )}
            {fromPlaza ? (
              <p className="text-xs leading-relaxed text-pc-text-muted">{t('workbench.skill_plaza_readonly')}</p>
            ) : null}
            {view.kind === 'edit' && draft.review_status ? (
              <p className="text-xs text-pc-text-secondary">{reviewStatusLabel(draft.review_status)}</p>
            ) : null}
            {view.kind === 'edit' && draft.review_status && draft.review_status !== 'rejected' && !fromPlaza ? (
              <p className="text-xs leading-relaxed text-pc-text-muted">{t('workbench.skill_submit_locked')}</p>
            ) : null}
            <label className="block text-xs font-medium text-pc-text-secondary">
              {t('workbench.save_skill_description')}
              <input
                value={draft.description}
                readOnly={fromPlaza}
                onChange={(e) => setView({ ...view, draft: { ...draft, description: e.target.value } })}
                className="mt-1 h-9 w-full rounded-[10px] border border-pc-border bg-pc-input px-3 text-sm text-pc-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)] read-only:opacity-70"
              />
            </label>
            <label className="flex min-h-0 flex-col text-xs font-medium text-pc-text-secondary">
              {t('workbench.save_skill_body')}
              <textarea
                value={draft.body}
                readOnly={fromPlaza}
                onChange={(e) => setView({ ...view, draft: { ...draft, body: e.target.value } })}
                className="mt-1 min-h-[16rem] resize-y rounded-[10px] border border-pc-border bg-pc-input px-3 py-2 text-sm leading-relaxed text-pc-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--pc-focus)] read-only:opacity-70"
                spellCheck={false}
              />
            </label>
            {fromPlaza ? (
              <p className="text-xs leading-relaxed text-pc-text-muted">{t('workbench.skill_fork_id')}</p>
            ) : null}
            {view.kind === 'edit' && plazaCopyUpdate(draft.name, fromPlaza, skills.find((row) => row.name === draft.name)?.version) ? (
              <p className="text-xs leading-relaxed text-status-warning">
                {t('workbench.skill_update_hint')}
                {plazaNote(plazaSkills.find((row) => row.id === draft.name) ?? null) ? ` ${plazaNote(plazaSkills.find((row) => row.id === draft.name) ?? null)}` : ''}
              </p>
            ) : null}
            <div className="flex items-center gap-2">
              {view.kind === 'edit' && !fromPlaza && (!draft.review_status || draft.review_status === 'rejected') ? (
                <button
                  type="button"
                  disabled={saving}
                  title={t('workbench.skill_submit_hint')}
                  onClick={() => {
                    void submitMine();
                  }}
                  className="h-9 rounded-[8px] border border-pc-border px-3 text-sm text-pc-text disabled:opacity-40"
                >
                  {t('workbench.skill_submit')}
                </button>
              ) : null}
              <div className="ml-auto flex gap-2">
                <button
                  type="button"
                  onClick={() => setView({ kind: 'browse' })}
                  className="h-9 rounded-[8px] px-3 text-sm text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-pc-text"
                >
                  {t('workbench.my_skills_back')}
                </button>
                {view.kind === 'edit' && plazaCopyUpdate(draft.name, fromPlaza, skills.find((row) => row.name === draft.name)?.version) ? (
                  <button
                    type="button"
                    disabled={saving || installingId === draft.name}
                    onClick={() => {
                      const shared = plazaCopyUpdate(draft.name, true, skills.find((row) => row.name === draft.name)?.version);
                      if (shared) void installPlaza(shared, true);
                    }}
                    className="h-9 rounded-[8px] border border-status-warning/40 px-3 text-sm text-status-warning disabled:opacity-40"
                  >
                    {installingId === draft.name ? t('workbench.skill_plaza_adding') : t('workbench.skill_plaza_update')}
                  </button>
                ) : null}
                {view.kind === 'edit' && plazaPrevious(draft.name, fromPlaza, skills.find((row) => row.name === draft.name)?.version) ? (
                  <button
                    type="button"
                    disabled={saving || installingId === draft.name}
                    onClick={() => {
                      const previous = plazaPrevious(draft.name, true, skills.find((row) => row.name === draft.name)?.version);
                      if (previous) void installPlaza(previous.skill, true, previous.version);
                    }}
                    className="h-9 rounded-[8px] border border-pc-border px-3 text-sm text-pc-text disabled:opacity-40"
                  >
                    {t('workbench.skill_rollback')}
                  </button>
                ) : null}
                {fromPlaza ? (
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => {
                      void forkMine();
                    }}
                    className="h-9 rounded-[8px] bg-pc-text px-3 text-sm font-medium text-pc-base disabled:cursor-default disabled:opacity-40"
                  >
                    {t('workbench.skill_fork')}
                  </button>
                ) : (
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
                )}
              </div>
            </div>
            </div>
            {view.kind === 'edit' ? (
              <SkillFileBrowser
                filesKey={`mine:${draft.name}`}
                loadList={() => listPersonalSkillFiles(agent, draft.name).then((res) => res.files)}
                loadFile={(path) => readPersonalSkillFile(agent, draft.name, path)}
              />
            ) : null}
          </div>
        ) : plazaDetail ? (
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-2 md:[grid-template-rows:minmax(0,1fr)]">
            <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
            <div>
              <h2 className="text-sm font-semibold text-pc-text">{plazaDetail.title}</h2>
              <p className="mt-1 font-mono text-xs text-pc-text-muted">
                {t('workbench.home_edit_skill_id')} {plazaDetail.id}
              </p>
              <p className="mt-1 text-xs text-pc-text-muted">
                {t('workbench.skill_center_creator')}{' '}
                {plazaDetail.creatorName || plazaDetail.creatorId || ''}
              </p>
            </div>
            <p className="text-sm leading-relaxed text-pc-text-muted">{plazaDetail.description}</p>
            <pre className="overflow-auto whitespace-pre-wrap rounded-[10px] border border-pc-border bg-pc-input px-3 py-2 text-sm leading-relaxed text-pc-text">
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
                disabled={plazaAction(plazaDetail) === 'added' || installingId === plazaDetail.id}
                onClick={() => {
                  void installPlaza(plazaDetail);
                }}
                className="inline-flex h-9 items-center gap-1.5 rounded-[8px] bg-pc-text px-3 text-sm font-medium text-pc-base disabled:cursor-default disabled:opacity-40"
              >
                {installingId === plazaDetail.id ? (
                  t('workbench.skill_plaza_adding')
                ) : plazaAction(plazaDetail) === 'added' ? (
                  t('workbench.skill_plaza_added')
                ) : (
                  <>
                    <Plus className="size-3.5" />
                    {t('workbench.skill_plaza_add')}
                  </>
                )}
              </button>
            </div>
            </div>
            <SkillFileBrowser
              filesKey={`plaza:${plazaDetail.id}`}
              loadList={() => listPlazaSkillFiles(plazaDetail.id).then((res) => res.files)}
              loadFile={(path) => readPlazaSkillFile(plazaDetail.id, path)}
            />
          </div>
        ) : loading ? (
          <p className="py-16 text-center text-sm text-pc-text-muted">{t('workbench.my_skills_loading')}</p>
        ) : pane === 'plaza' ? (
          plaza.length === 0 ? (
            <p className="py-20 text-center text-sm text-pc-text-muted">
              {query.trim() ? t('workbench.my_skills_search_empty') : t('workbench.skill_plaza_empty')}
            </p>
          ) : (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-2">
              {plaza.map((skill) => {
                const action = plazaAction(skill);
                const busy = installingId === skill.id;
                return (
                  <li key={skill.id}>
                    <WorkbenchSkillCard
                      title={skill.title}
                      id={skill.id}
                      description={skill.description}
                      versionLine={skillVersionLine(skill.version, skill.publishedAt)}
                      creator={skillCreatorLabel({ creator_id: skill.creatorId, creator_name: skill.creatorName })}
                      onOpen={() => setView({ kind: 'plaza-detail', skill })}
                      badge={(
                        <button
                          type="button"
                          disabled={action === 'added' || busy}
                          onClick={(event) => {
                            event.stopPropagation();
                            void installPlaza(skill);
                          }}
                          className="inline-flex h-5 items-center gap-0.5 rounded-full border border-pc-border px-1.5 text-[11px] leading-none text-pc-text hover:bg-[var(--pc-hover)] disabled:cursor-default disabled:opacity-50"
                        >
                          {busy ? (
                            t('workbench.skill_plaza_adding')
                          ) : action === 'added' ? (
                            t('workbench.skill_plaza_added')
                          ) : (
                            <>
                              <Plus className="size-3" />
                              {t('workbench.skill_plaza_add')}
                            </>
                          )}
                        </button>
                      )}
                    />
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
                  onClick={() => { void beginCreate(); }}
                  className="inline-flex h-9 items-center gap-1.5 rounded-full border border-pc-border px-3 text-sm text-pc-text hover:bg-[var(--pc-hover)]"
                >
                  <Plus className="size-4" />
                  {t('workbench.skill_plaza_create')}
                </button>
                <button
                  type="button"
                  title={t('workbench.skill_import_rule')}
                  onClick={() => folderRef.current?.click()}
                  className="inline-flex h-9 items-center gap-1.5 rounded-full border border-pc-border px-3 text-sm text-pc-text hover:bg-[var(--pc-hover)]"
                >
                  <FolderInput className="size-4" />
                  {t('workbench.skill_import_folder')}
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-2">
            {mine.map((skill) => {
              const on = isPersonalSkillEnabled(skill);
              const updateTarget = plazaCopyUpdate(skill.name, skill.from_plaza === true, skill.version);
              const previous = plazaPrevious(skill.name, skill.from_plaza === true, skill.version);
              const stampText = skillStampText(skill.name, skill.version);
              const shared = plazaSkills.find((row) => row.id === skill.name);
              return (
              <li key={skill.name}>
                <WorkbenchSkillCard
                  title={skill.title}
                  id={skill.name}
                  description={skill.description}
                  versionLine={stampText}
                  creator={skill.from_plaza && shared ? skillCreatorLabel({
                    creator_id: shared.creatorId,
                    creator_name: shared.creatorName,
                  }) : ''}
                  statusText={skill.review_status ? reviewStatusLabel(skill.review_status) : ''}
                  dimmed={!on}
                  badge={<SkillSourceBadge fromPlaza={skill.from_plaza === true} />}
                  onOpen={() => {
                    void openSkill(skill.name);
                  }}
                  notes={updateTarget || skill.blocked_reason ? (
                    <>
                      {updateTarget ? (
                        <p className="mt-1 truncate text-[11px] font-medium leading-4 text-status-warning">
                          {t('workbench.skill_update_available')}
                          {plazaNote(updateTarget) ? ` · ${plazaNote(updateTarget)}` : ''}
                        </p>
                      ) : null}
                      {skill.blocked_reason ? (
                        <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-status-error">
                          {t('workbench.skill_blocked')} {skill.blocked_reason}
                        </p>
                      ) : null}
                    </>
                  ) : null}
                  footer={(
                  <div className="flex items-center justify-between gap-2">
                    <SkillEnableSwitch
                      enabled={on}
                      busy={toggling === skill.name}
                      onToggle={() => {
                        void toggleEnabled(skill.name, !on);
                      }}
                    />
                    <div className="flex items-center gap-2">
                      {updateTarget ? (
                        <button
                          type="button"
                          disabled={installingId === skill.name}
                          onClick={() => {
                            void installPlaza(updateTarget, true);
                          }}
                          className="h-6 rounded-full border border-status-warning/40 px-2 text-[11px] font-medium text-status-warning disabled:opacity-40"
                        >
                          {installingId === skill.name ? t('workbench.skill_plaza_adding') : t('workbench.skill_plaza_update')}
                        </button>
                      ) : null}
                      {previous ? (
                        <button
                          type="button"
                          disabled={installingId === skill.name}
                          onClick={() => {
                            void installPlaza(previous.skill, true, previous.version);
                          }}
                          className="h-6 rounded-full border border-pc-border px-2 text-[11px] font-medium text-pc-text disabled:opacity-40"
                        >
                          {t('workbench.skill_rollback')}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => setPendingDelete(skill.name)}
                        className="inline-flex size-6 items-center justify-center rounded-[6px] text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-status-error"
                        aria-label={t('workbench.my_skills_delete')}
                        title={t('workbench.my_skills_delete')}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </div>
                  )}
                />
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

export function SkillFileBrowser({
  filesKey,
  loadList,
  loadFile,
}: {
  filesKey: string;
  loadList: () => Promise<string[]>;
  loadFile: (path: string) => Promise<{ content?: string; binary?: boolean }>;
}) {
  const [files, setFiles] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [binary, setBinary] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const loadListRef = useRef(loadList);
  const loadFileRef = useRef(loadFile);
  loadListRef.current = loadList;
  loadFileRef.current = loadFile;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setSelected(null);
    setContent(null);
    setBinary(false);
    setError(null);
    loadListRef.current()
      .then((next) => {
        if (cancelled) return;
        setFiles(next);
        setCollapsed(new Set(skillDirPaths(skillFileTree(next))));
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : t('workbench.skill_files_failed'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filesKey]);

  async function openFile(path: string) {
    setSelected(path);
    setReading(true);
    setContent(null);
    setBinary(false);
    setError(null);
    try {
      const file = await loadFileRef.current(path);
      setBinary(file.binary === true);
      setContent(file.binary === true ? null : (file.content ?? ''));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('workbench.skill_files_failed'));
    } finally {
      setReading(false);
    }
  }

  const tree = skillFileTree(files);

  return (
    <section className="flex h-full min-h-0 flex-col gap-2">
      <h3 className="text-xs font-medium text-pc-text-secondary">{t('workbench.skill_files')}</h3>
      {loading ? (
        <p className="text-xs text-pc-text-muted">{t('workbench.skill_files_loading')}</p>
      ) : files.length === 0 ? (
        <p className="text-xs text-pc-text-muted">{t('workbench.skill_files_empty')}</p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-pc-border">
          <div className="max-h-36 shrink-0 overflow-auto border-b border-pc-border py-1">
            <SkillFileTreeRows
              node={tree}
              depth={0}
              collapsed={collapsed}
              selected={selected}
              onToggle={(path) => {
                setCollapsed((prev) => {
                  const next = new Set(prev);
                  if (next.has(path)) next.delete(path);
                  else next.add(path);
                  return next;
                });
              }}
              onOpen={(path) => {
                void openFile(path);
              }}
            />
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto bg-pc-input">
            {error ? <p className="px-3 py-2 text-xs text-status-error">{error}</p> : null}
            {reading ? (
              <p className="px-3 py-2 text-xs text-pc-text-muted">{t('workbench.skill_files_loading')}</p>
            ) : null}
            {!reading && selected && binary ? (
              <p className="px-3 py-2 text-xs text-pc-text-muted">{t('workbench.skill_files_binary')}</p>
            ) : null}
            {!reading && selected && !binary && content != null ? (
              <>
                <p className="sticky top-0 border-b border-pc-border bg-pc-elevated px-3 py-1.5 font-mono text-xs text-pc-text-muted">
                  {selected}
                </p>
                <pre className="whitespace-pre-wrap px-3 py-2 font-mono text-xs leading-relaxed text-pc-text">{content}</pre>
              </>
            ) : null}
            {!reading && !selected && !error ? (
              <p className="px-3 py-2 text-xs text-pc-text-muted">{t('workbench.skill_files_pick')}</p>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}

function SkillFileTreeRows({
  node,
  depth,
  collapsed,
  selected,
  onToggle,
  onOpen,
}: {
  node: SkillDirNode;
  depth: number;
  collapsed: ReadonlySet<string>;
  selected: string | null;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  return (
    <>
      {node.dirs.map((dir) => {
        const open = !collapsed.has(dir.path);
        return (
          <div key={dir.path}>
            <button
              type="button"
              onClick={() => onToggle(dir.path)}
              className="flex w-full items-center gap-1 py-1 pr-2 text-left text-xs text-pc-text hover:bg-[var(--pc-hover)]"
              style={{ paddingLeft: 8 + depth * 14 }}
            >
              <ChevronRight className={['size-3.5 shrink-0 text-pc-text-muted transition-transform', open ? 'rotate-90' : ''].join(' ')} />
              <Folder className="size-3.5 shrink-0 text-pc-text-muted" />
              <span className="truncate">{dir.name}</span>
            </button>
            {open ? (
              <SkillFileTreeRows
                node={dir}
                depth={depth + 1}
                collapsed={collapsed}
                selected={selected}
                onToggle={onToggle}
                onOpen={onOpen}
              />
            ) : null}
          </div>
        );
      })}
      {node.files.map((file) => (
        <button
          key={file.path}
          type="button"
          onClick={() => onOpen(file.path)}
          className={[
            'flex w-full items-center gap-1 py-1 pr-2 text-left font-mono text-xs',
            selected === file.path ? 'bg-[var(--pc-hover)] text-pc-text' : 'text-pc-text-secondary hover:bg-[var(--pc-hover)]',
          ].join(' ')}
          style={{ paddingLeft: 8 + depth * 14 + 18 }}
        >
          <File className="size-3.5 shrink-0 text-pc-text-muted" />
          <span className="truncate">{file.name}</span>
        </button>
      ))}
    </>
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

function packageFiles(list: readonly File[]): PackageFile[] {
  return [...list].map((file) => ({
    path: file.webkitRelativePath || file.name,
    text: () => file.text(),
    bytes: async () => new Uint8Array(await file.arrayBuffer()),
  }));
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
