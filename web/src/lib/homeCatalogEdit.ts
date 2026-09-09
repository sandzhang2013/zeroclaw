/** Helpers for the ops homepage catalog editor. */

import type {
  HomeCapEdit,
  HomeCatalogEdit,
  HomePromptEdit,
  HomeTabEdit,
  WorkbenchHomeCapView,
  WorkbenchHomeCatalog,
} from './workbenchHomeCatalog';

const ALIAS = /^(?!_)(?!.*__)(?!.*_$)[a-z0-9_]{1,63}$/;

export function suggestHomeId(label: string, used: Iterable<string>): string {
  const taken = new Set(used);
  const ascii = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .slice(0, 40);
  let base = ascii && ALIAS.test(ascii) ? ascii : 'item';
  if (!ALIAS.test(base)) base = 'item';
  if (!taken.has(base)) return base;
  for (let i = 2; i < 100; i += 1) {
    const candidate = `${base}_${i}`.slice(0, 63);
    if (ALIAS.test(candidate) && !taken.has(candidate)) return candidate;
  }
  return `item_${Date.now().toString(36)}`.slice(0, 63);
}

export function moveItem<T>(items: T[], index: number, delta: number): T[] {
  const next = index + delta;
  if (index < 0 || next < 0 || index >= items.length || next >= items.length) {
    return items;
  }
  const copy = items.slice();
  const row = copy.splice(index, 1)[0];
  if (row === undefined) return items;
  copy.splice(next, 0, row);
  return copy;
}

export function previewLabel(zhText: string, enText: string, zh: boolean): string {
  const zhTrim = zhText.trim();
  const enTrim = enText.trim();
  if (zh) return zhTrim || enTrim;
  return enTrim || zhTrim;
}

export function canSubmitHomeDraft(labelZh: string, labelEn: string): boolean {
  return Boolean(labelZh.trim() || labelEn.trim());
}

export function draftHomeTab(labelZh: string, labelEn: string, used: Iterable<string>): HomeTabEdit {
  const zh = labelZh.trim();
  const en = labelEn.trim();
  return {
    id: suggestHomeId(en || zh, used),
    label_zh: zh,
    label_en: en,
    caps: [],
  };
}

export function draftHomeCap(labelZh: string, labelEn: string, used: Iterable<string>): HomeCapEdit {
  const zh = labelZh.trim();
  const en = labelEn.trim();
  return {
    id: suggestHomeId(en || zh, used),
    icon: 'file-text',
    kind: 'chat',
    label_zh: zh,
    label_en: en,
    prompts: [],
  };
}

export function draftHomePrompt(textZh: string, textEn: string, used: Iterable<string>): HomePromptEdit {
  const zh = textZh.trim();
  const en = textEn.trim();
  return {
    id: suggestHomeId(en || zh || 'prompt', used),
    text_zh: zh,
    text_en: en,
  };
}

export function usedHomeIds(tabs: HomeTabEdit[]): string[] {
  return tabs.flatMap((tab) => [
    tab.id,
    ...tab.caps.flatMap((cap) => [cap.id, ...cap.prompts.map((prompt) => prompt.id)]),
  ]);
}

/** Accept GET /api/workbench/home from a daemon that still returns a single `prompt`. */
export function normalizeHomeCatalog(data: WorkbenchHomeCatalog): WorkbenchHomeCatalog {
  return {
    source: data.source,
    tabs: (data.tabs ?? []).map((tab) => ({
      ...tab,
      caps: (tab.caps ?? []).map((cap) => normalizeHomeCapView(cap)),
    })),
  };
}

function normalizeHomeCapView(
  cap: WorkbenchHomeCapView & { prompt?: string },
): WorkbenchHomeCapView {
  const listed = Array.isArray(cap.prompts)
    ? cap.prompts.filter((item) => typeof item?.text === 'string' && item.text.trim())
    : [];
  if (listed.length > 0) {
    return { ...cap, prompts: listed };
  }
  const legacy = typeof cap.prompt === 'string' ? cap.prompt.trim() : '';
  return {
    ...cap,
    prompts: legacy ? [{ id: `${cap.id}_p1`, text: legacy }] : [],
  };
}

/** Accept GET /api/workbench/home/catalog from a daemon that still returns prompt_zh/prompt_en. */
export function normalizeHomeCatalogEdit(data: HomeCatalogEdit): HomeCatalogEdit {
  return {
    source: data.source,
    tabs: (data.tabs ?? []).map((tab) => ({
      ...tab,
      caps: (tab.caps ?? []).map((cap) => normalizeHomeCapEdit(cap)),
    })),
  };
}

function normalizeHomeCapEdit(
  cap: HomeCapEdit & { prompt_zh?: string; prompt_en?: string },
): HomeCapEdit {
  const listed = Array.isArray(cap.prompts) ? cap.prompts : [];
  if (listed.length > 0) {
    return {
      id: cap.id,
      icon: cap.icon,
      kind: cap.kind,
      label_zh: cap.label_zh,
      label_en: cap.label_en,
      prompts: listed,
    };
  }
  const zh = cap.prompt_zh?.trim() ?? '';
  const en = cap.prompt_en?.trim() ?? '';
  return {
    id: cap.id,
    icon: cap.icon,
    kind: cap.kind,
    label_zh: cap.label_zh,
    label_en: cap.label_en,
    prompts: zh || en ? [{ id: `${cap.id}_p1`, text_zh: zh, text_en: en }] : [],
  };
}
