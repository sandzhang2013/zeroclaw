import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2, X } from 'lucide-react';
import { Button, ConfirmDialog, Select } from '@/components/ui';
import { ApiError, getWorkbenchHomeCatalog, putWorkbenchHomeCatalog } from '@/lib/api';
import { t } from '@/lib/i18n';
import {
  canSubmitHomeDraft,
  draftHomeCap,
  draftHomePrompt,
  draftHomeTab,
  moveItem,
  previewLabel,
  usedHomeIds,
} from '@/lib/homeCatalogEdit';
import { useFocusTrap, FOCUSABLE_SELECTOR_FORM } from '@/hooks/useFocusTrap';
import {
  HOME_CAP_ICON_IDS,
  homeCapIcon,
  type HomeCapEdit,
  type HomeCatalogEdit,
  type HomePromptEdit,
  type HomeTabEdit,
} from '@/lib/workbenchHomeCatalog';

type DraftKind = 'tab' | 'cap' | 'prompt';
type DeleteKind = 'tab' | 'cap' | 'prompt';

export function HomeCatalogEditor({
  onClose,
  onSaved,
}: {
  onClose?: () => void;
  onSaved?: () => void;
}) {
  const [catalog, setCatalog] = useState<HomeCatalogEdit | null>(null);
  const [tabIndex, setTabIndex] = useState(0);
  const [capIndex, setCapIndex] = useState(0);
  const [promptIndex, setPromptIndex] = useState(0);
  const [previewZh, setPreviewZh] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [draftKind, setDraftKind] = useState<DraftKind | null>(null);
  const [pendingDelete, setPendingDelete] = useState<DeleteKind | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getWorkbenchHomeCatalog()
      .then((data) => {
        if (cancelled) return;
        setCatalog(data);
        setTabIndex(0);
        setCapIndex(0);
        setPromptIndex(0);
        setDirty(false);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : t('workbench.home_edit_failed'));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const tab = catalog?.tabs[tabIndex];
  const cap = tab?.caps[capIndex];
  const prompt = cap?.prompts[promptIndex];
  const previewTabs = useMemo(
    () =>
      (catalog?.tabs ?? []).map((item) => ({
        ...item,
        preview: previewLabel(item.label_zh, item.label_en, previewZh) || item.id,
      })),
    [catalog, previewZh],
  );

  function updateTabs(next: HomeTabEdit[]) {
    setCatalog((prev) => (prev ? { ...prev, tabs: next } : prev));
    setDirty(true);
  }

  function patchTab(index: number, patch: Partial<HomeTabEdit>) {
    if (!catalog) return;
    updateTabs(catalog.tabs.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function patchCap(next: HomeCapEdit) {
    if (!catalog || !tab) return;
    patchTab(tabIndex, {
      caps: tab.caps.map((item, i) => (i === capIndex ? next : item)),
    });
  }

  function patchPrompt(next: HomePromptEdit) {
    if (!cap) return;
    patchCap({
      ...cap,
      prompts: cap.prompts.map((item, i) => (i === promptIndex ? next : item)),
    });
  }

  function confirmDraft(labelZh: string, labelEn: string) {
    if (!catalog) return;
    if (draftKind === 'tab') {
      const next = draftHomeTab(labelZh, labelEn, usedHomeIds(catalog.tabs));
      updateTabs([...catalog.tabs, next]);
      setTabIndex(catalog.tabs.length);
      setCapIndex(0);
      setPromptIndex(0);
    } else if (draftKind === 'cap' && tab) {
      const next = draftHomeCap(labelZh, labelEn, usedHomeIds(catalog.tabs));
      const caps = [...tab.caps, next];
      patchTab(tabIndex, { caps });
      setCapIndex(caps.length - 1);
      setPromptIndex(0);
    } else if (draftKind === 'prompt' && cap) {
      const next = draftHomePrompt(labelZh, labelEn, usedHomeIds(catalog.tabs));
      const prompts = [...cap.prompts, next];
      patchCap({ ...cap, prompts });
      setPromptIndex(prompts.length - 1);
    }
    setDraftKind(null);
  }

  function confirmDelete() {
    if (pendingDelete === 'tab') {
      if (!catalog || catalog.tabs.length === 0) return;
      const next = catalog.tabs.filter((_, i) => i !== tabIndex);
      updateTabs(next);
      setTabIndex(Math.max(0, tabIndex - 1));
      setCapIndex(0);
      setPromptIndex(0);
    } else if (pendingDelete === 'cap' && tab) {
      const caps = tab.caps.filter((_, i) => i !== capIndex);
      patchTab(tabIndex, { caps });
      setCapIndex(Math.max(0, capIndex - 1));
      setPromptIndex(0);
    } else if (pendingDelete === 'prompt' && cap) {
      const prompts = cap.prompts.filter((_, i) => i !== promptIndex);
      patchCap({ ...cap, prompts });
      setPromptIndex(Math.max(0, promptIndex - 1));
    }
    setPendingDelete(null);
  }

  async function save() {
    if (!catalog) return;
    setSaving(true);
    setError(null);
    try {
      const next = await putWorkbenchHomeCatalog(catalog.tabs);
      setCatalog(next);
      setDirty(false);
      onSaved?.();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : t('workbench.home_edit_save_failed'));
    } finally {
      setSaving(false);
    }
  }

  async function resetBuiltin() {
    setSaving(true);
    setError(null);
    setConfirmReset(false);
    try {
      const next = await putWorkbenchHomeCatalog([]);
      setCatalog(next);
      setTabIndex(0);
      setCapIndex(0);
      setPromptIndex(0);
      setDirty(false);
      onSaved?.();
    } catch (err: unknown) {
      setError(err instanceof ApiError ? err.message : t('workbench.home_edit_save_failed'));
    } finally {
      setSaving(false);
    }
  }

  const deleteName =
    pendingDelete === 'tab'
      ? previewLabel(tab?.label_zh ?? '', tab?.label_en ?? '', previewZh) || tab?.id || ''
      : pendingDelete === 'prompt'
        ? previewLabel(prompt?.text_zh ?? '', prompt?.text_en ?? '', previewZh) || prompt?.id || ''
        : previewLabel(cap?.label_zh ?? '', cap?.label_en ?? '', previewZh) || cap?.id || '';

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-pc-surface">
      <div className="flex shrink-0 items-center gap-3 border-b border-pc-border px-6 py-4">
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="inline-flex size-8 items-center justify-center rounded-md text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-pc-text"
            aria-label={t('common.close')}
          >
            <X className="size-4" />
          </button>
        ) : null}
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold text-pc-text">{t('workbench.home_edit_title')}</h1>
          <p className="text-xs text-pc-text-muted">{t('workbench.home_edit_hint')}</p>
        </div>
        <div className="inline-flex rounded-full p-1" style={{ background: 'color-mix(in srgb, var(--pc-text-primary) 8%, transparent)' }}>
          <button
            type="button"
            onClick={() => setPreviewZh(true)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${previewZh ? 'bg-pc-text text-pc-base' : 'text-pc-text'}`}
          >
            {t('workbench.home_edit_preview_zh')}
          </button>
          <button
            type="button"
            onClick={() => setPreviewZh(false)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${previewZh ? 'text-pc-text' : 'bg-pc-text text-pc-base'}`}
          >
            {t('workbench.home_edit_preview_en')}
          </button>
        </div>
        <button
          type="button"
          onClick={() => setConfirmReset(true)}
          disabled={saving}
          className="rounded-md px-3 py-1.5 text-sm text-pc-text-muted hover:bg-[var(--pc-hover)] hover:text-pc-text"
        >
          {t('workbench.home_edit_reset')}
        </button>
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || !catalog}
          className="rounded-md bg-pc-text px-3 py-1.5 text-sm font-medium text-pc-base disabled:opacity-50"
        >
          {saving ? t('workbench.home_edit_saving') : t('common.save')}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        {loading ? (
          <p className="text-sm text-pc-text-muted">{t('common.loading')}</p>
        ) : (
          <>
            {catalog?.source === 'builtin' && !dirty ? (
              <p className="mb-4 rounded-lg border border-pc-border bg-pc-elevated px-3 py-2 text-sm text-pc-text-secondary">
                {t('workbench.home_edit_builtin')}
              </p>
            ) : null}
            {error ? <p className="mb-4 text-sm text-status-error">{error}</p> : null}

            <div className="mb-4 flex flex-wrap items-center gap-2">
              {previewTabs.map((item, i) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setTabIndex(i);
                    setCapIndex(0);
                    setPromptIndex(0);
                  }}
                  className={[
                    'rounded-full px-[18px] py-2 text-sm font-medium',
                    i === tabIndex ? 'bg-pc-text text-pc-base' : 'bg-[color-mix(in_srgb,var(--pc-text-primary)_8%,transparent)] text-pc-text',
                  ].join(' ')}
                >
                  {item.preview}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setDraftKind('tab')}
                className="inline-flex items-center gap-1 rounded-full border border-dashed border-pc-border px-3 py-2 text-sm text-pc-text-muted hover:text-pc-text"
              >
                <Plus className="size-3.5" />
                {t('workbench.home_edit_add_tab')}
              </button>
            </div>

            {tab ? (
              <div className="mb-4 grid gap-3 rounded-xl border border-pc-border p-4 md:grid-cols-2">
                <label className="text-sm text-pc-text-secondary">
                  {t('workbench.home_edit_tab_zh')}
                  <input
                    className="mt-1 w-full rounded-md border border-pc-border bg-pc-elevated px-3 py-2 text-sm text-pc-text"
                    value={tab.label_zh}
                    onChange={(e) => patchTab(tabIndex, { label_zh: e.target.value })}
                  />
                </label>
                <label className="text-sm text-pc-text-secondary">
                  {t('workbench.home_edit_tab_en')}
                  <input
                    className="mt-1 w-full rounded-md border border-pc-border bg-pc-elevated px-3 py-2 text-sm text-pc-text"
                    value={tab.label_en}
                    onChange={(e) => patchTab(tabIndex, { label_en: e.target.value })}
                  />
                </label>
                <div className="flex items-center gap-2 md:col-span-2">
                  <button type="button" onClick={() => updateTabs(moveItem(catalog?.tabs ?? [], tabIndex, -1))} className="btn-icon" title={t('workbench.home_edit_move_left')}>
                    <ArrowUp className="size-4" />
                  </button>
                  <button type="button" onClick={() => updateTabs(moveItem(catalog?.tabs ?? [], tabIndex, 1))} className="btn-icon" title={t('workbench.home_edit_move_right')}>
                    <ArrowDown className="size-4" />
                  </button>
                  <button type="button" onClick={() => setPendingDelete('tab')} className="inline-flex items-center gap-1 text-sm text-status-error">
                    <Trash2 className="size-3.5" />
                    {t('workbench.home_edit_delete_tab')}
                  </button>
                </div>
              </div>
            ) : (
              <p className="mb-4 text-sm text-pc-text-muted">{t('workbench.home_edit_no_tabs')}</p>
            )}

            <div className="mb-4 flex flex-wrap items-center gap-2">
              {(tab?.caps ?? []).map((item, i) => {
                const Icon = homeCapIcon(item.icon);
                const label = previewLabel(item.label_zh, item.label_en, previewZh) || item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setCapIndex(i);
                      setPromptIndex(0);
                    }}
                    className={[
                      'inline-flex items-center gap-2 rounded-full border px-[18px] py-[9px] text-sm',
                      i === capIndex
                        ? 'border-pc-text bg-pc-text text-pc-base'
                        : 'border-pc-border bg-pc-surface text-pc-text-secondary',
                    ].join(' ')}
                  >
                    <Icon className="size-4" />
                    {label}
                  </button>
                );
              })}
              {tab ? (
                <button
                  type="button"
                  onClick={() => setDraftKind('cap')}
                  className="inline-flex items-center gap-1 rounded-full border border-dashed border-pc-border px-3 py-2 text-sm text-pc-text-muted hover:text-pc-text"
                >
                  <Plus className="size-3.5" />
                  {t('workbench.home_edit_add_cap')}
                </button>
              ) : null}
            </div>

            {cap ? (
              <div className="mb-4 grid gap-3 rounded-xl border border-pc-border p-4 md:grid-cols-2">
                <label className="text-sm text-pc-text-secondary">
                  {t('workbench.home_edit_cap_zh')}
                  <input
                    className="mt-1 w-full rounded-md border border-pc-border bg-pc-elevated px-3 py-2 text-sm text-pc-text"
                    value={cap.label_zh}
                    onChange={(e) => patchCap({ ...cap, label_zh: e.target.value })}
                  />
                </label>
                <label className="text-sm text-pc-text-secondary">
                  {t('workbench.home_edit_cap_en')}
                  <input
                    className="mt-1 w-full rounded-md border border-pc-border bg-pc-elevated px-3 py-2 text-sm text-pc-text"
                    value={cap.label_en}
                    onChange={(e) => patchCap({ ...cap, label_en: e.target.value })}
                  />
                </label>
                <label className="text-sm text-pc-text-secondary">
                  {t('workbench.home_edit_icon')}
                  <Select
                    className="mt-1"
                    aria-label={t('workbench.home_edit_icon')}
                    value={HOME_CAP_ICON_IDS.includes(cap.icon) ? cap.icon : 'file-text'}
                    onChange={(value) => patchCap({ ...cap, icon: value })}
                    options={HOME_CAP_ICON_IDS.map((id) => ({
                      value: id,
                      label: id,
                      icon: homeCapIcon(id),
                    }))}
                  />
                </label>
                <label className="text-sm text-pc-text-secondary">
                  {t('workbench.home_edit_kind')}
                  <select
                    className="mt-1 w-full rounded-md border border-pc-border bg-pc-elevated px-3 py-2 text-sm text-pc-text"
                    value={cap.kind === 'outline' ? 'outline' : 'chat'}
                    onChange={(e) => patchCap({ ...cap, kind: e.target.value })}
                  >
                    <option value="chat">{t('workbench.home_edit_kind_chat')}</option>
                    <option value="outline">{t('workbench.home_edit_kind_outline')}</option>
                  </select>
                </label>
                <div className="flex items-center gap-2 md:col-span-2">
                  <button type="button" onClick={() => tab && patchTab(tabIndex, { caps: moveItem(tab.caps, capIndex, -1) })} className="btn-icon">
                    <ArrowUp className="size-4" />
                  </button>
                  <button type="button" onClick={() => tab && patchTab(tabIndex, { caps: moveItem(tab.caps, capIndex, 1) })} className="btn-icon">
                    <ArrowDown className="size-4" />
                  </button>
                  <button type="button" onClick={() => setPendingDelete('cap')} className="inline-flex items-center gap-1 text-sm text-status-error">
                    <Trash2 className="size-3.5" />
                    {t('workbench.home_edit_delete_cap')}
                  </button>
                </div>
              </div>
            ) : null}

            {cap ? (
              <>
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  {cap.prompts.map((item, i) => {
                    const label = previewLabel(item.text_zh, item.text_en, previewZh) || item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        title={label}
                        onClick={() => setPromptIndex(i)}
                        className={[
                          'max-w-[280px] truncate rounded-full border px-[18px] py-[9px] text-sm',
                          i === promptIndex
                            ? 'border-pc-text bg-pc-text text-pc-base'
                            : 'border-pc-border bg-pc-surface text-pc-text-secondary',
                        ].join(' ')}
                      >
                        {label}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    onClick={() => setDraftKind('prompt')}
                    className="inline-flex items-center gap-1 rounded-full border border-dashed border-pc-border px-3 py-2 text-sm text-pc-text-muted hover:text-pc-text"
                  >
                    <Plus className="size-3.5" />
                    {t('workbench.home_edit_add_prompt')}
                  </button>
                </div>
                {prompt ? (
                  <div className="grid gap-3 rounded-xl border border-pc-border p-4">
                    <label className="text-sm text-pc-text-secondary">
                      {t('workbench.home_edit_prompt_zh')}
                      <textarea
                        rows={3}
                        className="mt-1 w-full rounded-md border border-pc-border bg-pc-elevated px-3 py-2 text-sm text-pc-text"
                        value={prompt.text_zh}
                        onChange={(e) => patchPrompt({ ...prompt, text_zh: e.target.value })}
                      />
                    </label>
                    <label className="text-sm text-pc-text-secondary">
                      {t('workbench.home_edit_prompt_en')}
                      <textarea
                        rows={3}
                        className="mt-1 w-full rounded-md border border-pc-border bg-pc-elevated px-3 py-2 text-sm text-pc-text"
                        value={prompt.text_en}
                        onChange={(e) => patchPrompt({ ...prompt, text_en: e.target.value })}
                      />
                    </label>
                    <div className="flex items-center gap-2">
                      <button type="button" onClick={() => patchCap({ ...cap, prompts: moveItem(cap.prompts, promptIndex, -1) })} className="btn-icon">
                        <ArrowUp className="size-4" />
                      </button>
                      <button type="button" onClick={() => patchCap({ ...cap, prompts: moveItem(cap.prompts, promptIndex, 1) })} className="btn-icon">
                        <ArrowDown className="size-4" />
                      </button>
                      <button type="button" onClick={() => setPendingDelete('prompt')} className="inline-flex items-center gap-1 text-sm text-status-error">
                        <Trash2 className="size-3.5" />
                        {t('workbench.home_edit_delete_prompt')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-pc-text-muted">{t('workbench.home_edit_no_prompts')}</p>
                )}
              </>
            ) : null}
          </>
        )}
      </div>

      <HomeCatalogNameDialog
        kind={draftKind}
        onClose={() => setDraftKind(null)}
        onConfirm={confirmDraft}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        danger
        title={
          pendingDelete === 'tab'
            ? t('workbench.home_edit_delete_tab_title')
            : pendingDelete === 'prompt'
              ? t('workbench.home_edit_delete_prompt_title')
              : t('workbench.home_edit_delete_cap_title')
        }
        message={(pendingDelete === 'tab'
          ? t('workbench.home_edit_delete_tab_hint')
          : pendingDelete === 'prompt'
            ? t('workbench.home_edit_delete_prompt_hint')
            : t('workbench.home_edit_delete_cap_hint')
        ).replace('{name}', deleteName)}
        confirmLabel={
          pendingDelete === 'tab'
            ? t('workbench.home_edit_delete_tab')
            : pendingDelete === 'prompt'
              ? t('workbench.home_edit_delete_prompt')
              : t('workbench.home_edit_delete_cap')
        }
        onConfirm={confirmDelete}
        onClose={() => setPendingDelete(null)}
      />

      <ConfirmDialog
        open={confirmReset}
        danger
        title={t('workbench.home_edit_reset_title')}
        message={t('workbench.home_edit_reset_hint')}
        confirmLabel={t('workbench.home_edit_reset')}
        onConfirm={() => void resetBuiltin()}
        onClose={() => setConfirmReset(false)}
      />
    </div>
  );
}

function HomeCatalogNameDialog({
  kind,
  onClose,
  onConfirm,
}: {
  kind: DraftKind | null;
  onClose: () => void;
  onConfirm: (labelZh: string, labelEn: string) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const hintId = useId();
  const [labelZh, setLabelZh] = useState('');
  const [labelEn, setLabelEn] = useState('');
  const open = kind !== null;
  const canSubmit = canSubmitHomeDraft(labelZh, labelEn);
  const isPrompt = kind === 'prompt';

  useFocusTrap(panelRef, {
    onClose,
    enabled: open,
    focusableSelector: FOCUSABLE_SELECTOR_FORM,
    preventDefaultOnEscape: true,
  });

  useEffect(() => {
    if (!open) return;
    setLabelZh('');
    setLabelEn('');
    if (kind === 'prompt') areaRef.current?.focus();
    else inputRef.current?.focus();
  }, [open, kind]);

  if (!open) return null;

  const title =
    kind === 'tab'
      ? t('workbench.home_edit_add_tab_title')
      : kind === 'prompt'
        ? t('workbench.home_edit_add_prompt_title')
        : t('workbench.home_edit_add_cap_title');
  const zhLabel =
    kind === 'tab'
      ? t('workbench.home_edit_tab_zh')
      : kind === 'prompt'
        ? t('workbench.home_edit_prompt_zh')
        : t('workbench.home_edit_cap_zh');
  const enLabel =
    kind === 'tab'
      ? t('workbench.home_edit_tab_en')
      : kind === 'prompt'
        ? t('workbench.home_edit_prompt_en')
        : t('workbench.home_edit_cap_en');
  const confirmLabel =
    kind === 'tab'
      ? t('workbench.home_edit_add_tab')
      : kind === 'prompt'
        ? t('workbench.home_edit_add_prompt')
        : t('workbench.home_edit_add_cap');

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
        className="relative w-full max-w-sm rounded-[var(--radius-xl)] border border-pc-border bg-pc-base shadow-[var(--pc-shadow-md)] animate-fade-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 pt-5 pb-2">
          <h2 id={titleId} className="text-sm font-semibold text-pc-text">
            {title}
          </h2>
          <p id={hintId} className="mt-1 text-xs leading-relaxed text-pc-text-muted">
            {t('workbench.home_edit_add_hint')}
          </p>
        </div>
        <form
          className="flex flex-col gap-3 px-6 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSubmit) return;
            onConfirm(labelZh, labelEn);
          }}
        >
          <label className="text-xs font-medium text-pc-text-secondary">
            {zhLabel}
            {isPrompt ? (
              <textarea
                ref={areaRef}
                rows={3}
                className="mt-1 w-full rounded-md border border-pc-border bg-pc-elevated px-3 py-2 text-sm text-pc-text"
                value={labelZh}
                onChange={(e) => setLabelZh(e.target.value)}
              />
            ) : (
              <input
                ref={inputRef}
                className="mt-1 w-full rounded-md border border-pc-border bg-pc-elevated px-3 py-2 text-sm text-pc-text"
                value={labelZh}
                onChange={(e) => setLabelZh(e.target.value)}
              />
            )}
          </label>
          <label className="text-xs font-medium text-pc-text-secondary">
            {enLabel}
            {isPrompt ? (
              <textarea
                rows={3}
                className="mt-1 w-full rounded-md border border-pc-border bg-pc-elevated px-3 py-2 text-sm text-pc-text"
                value={labelEn}
                onChange={(e) => setLabelEn(e.target.value)}
              />
            ) : (
              <input
                className="mt-1 w-full rounded-md border border-pc-border bg-pc-elevated px-3 py-2 text-sm text-pc-text"
                value={labelEn}
                onChange={(e) => setLabelEn(e.target.value)}
              />
            )}
          </label>
          <div className="flex items-center justify-end gap-2 border-t border-pc-border px-0 py-4">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {confirmLabel}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default HomeCatalogEditor;
