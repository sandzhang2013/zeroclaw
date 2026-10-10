import { workspaceStorageId } from './platformUser.ts';

/** Personal composer snippets. Stored in this browser, one list per login. */

export interface QuickPrompt {
  id: string;
  title: string;
  body: string;
  /** Visible to every login on this browser. Personal rows omit this. */
  shared?: boolean;
}

const STORAGE_KEY = 'zeroclaw-quick-prompts';
const SHARED_STORAGE_KEY = 'zeroclaw-quick-prompts-global';
const DIRTY_KEY = 'zeroclaw-quick-prompts-dirty';
const TITLE_MAX = 40;
const BODY_MAX = 4000;

export const QUICK_PROMPTS_CHANGED = 'zeroclaw-quick-prompts-changed';

/** Account copy. `null` means that side has never been saved on the server. */
export interface QuickPromptStore {
  personal: Array<Pick<QuickPrompt, 'id' | 'title' | 'body'>> | null;
  shared: Array<Pick<QuickPrompt, 'id' | 'title' | 'body'>> | null;
}

export function quickPromptStorageKey(userId?: string): string {
  return userId ? `${STORAGE_KEY}:${workspaceStorageId(userId)}` : STORAGE_KEY;
}

export function sharedQuickPromptStorageKey(): string {
  return SHARED_STORAGE_KEY;
}

/** CJK counts as one token. ASCII runs count as about four characters. */
export function estimatePromptTokens(text: string): number {
  let tokens = 0;
  let ascii = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) {
      ascii += 1;
      continue;
    }
    if (ascii > 0) {
      tokens += Math.ceil(ascii / 4);
      ascii = 0;
    }
    tokens += 1;
  }
  if (ascii > 0) tokens += Math.ceil(ascii / 4);
  return tokens;
}

export function parseQuickPrompts(raw: string | null): QuickPrompt[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    const prompts: QuickPrompt[] = [];
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const row = item as { id?: unknown; title?: unknown; body?: unknown; shared?: unknown };
      const id = typeof row.id === 'string' ? row.id.trim() : '';
      const title = typeof row.title === 'string' ? row.title.trim().slice(0, TITLE_MAX) : '';
      const body = typeof row.body === 'string' ? row.body.trim().slice(0, BODY_MAX) : '';
      if (!id || !title || !body) continue;
      prompts.push(row.shared === true ? { id, title, body, shared: true } : { id, title, body });
    }
    return prompts;
  } catch {
    return [];
  }
}

export function mergeQuickPromptLists(personal: QuickPrompt[], shared: QuickPrompt[]): QuickPrompt[] {
  const sharedRows = shared.map((prompt) => ({ ...prompt, shared: true as const }));
  const sharedIds = new Set(sharedRows.map((prompt) => prompt.id));
  return [
    ...personal.filter((prompt) => !prompt.shared && !sharedIds.has(prompt.id)),
    ...sharedRows,
  ];
}

export function loadQuickPrompts(userId?: string): QuickPrompt[] {
  try {
    return mergeQuickPromptLists(
      parseQuickPrompts(localStorage.getItem(quickPromptStorageKey(userId))),
      parseQuickPrompts(localStorage.getItem(sharedQuickPromptStorageKey())),
    );
  } catch {
    return [];
  }
}

export function splitQuickPrompts(prompts: QuickPrompt[]): {
  personal: Array<Pick<QuickPrompt, 'id' | 'title' | 'body'>>;
  shared: Array<Pick<QuickPrompt, 'id' | 'title' | 'body'>>;
} {
  return {
    personal: prompts.filter((prompt) => !prompt.shared).map(({ id, title, body }) => ({ id, title, body })),
    shared: prompts.filter((prompt) => prompt.shared).map(({ id, title, body }) => ({ id, title, body })),
  };
}

export function quickPromptDirtyKey(userId?: string): string {
  return userId ? `${DIRTY_KEY}:${workspaceStorageId(userId)}` : DIRTY_KEY;
}

export function quickPromptsDirty(userId?: string): boolean {
  try {
    return localStorage.getItem(quickPromptDirtyKey(userId)) === '1';
  } catch {
    return false;
  }
}

export function markQuickPromptsDirty(userId?: string): void {
  try {
    localStorage.setItem(quickPromptDirtyKey(userId), '1');
  } catch {
    /* the next save retries */
  }
}

export function clearQuickPromptsDirty(userId?: string): void {
  try {
    localStorage.removeItem(quickPromptDirtyKey(userId));
  } catch {
    /* a failed clear retries the upload */
  }
}

/**
 * Server rows win once that side has been saved, including a cleared list.
 * A missing server side keeps the browser rows and asks for one upload.
 */
export function reconcileQuickPromptStore(
  local: QuickPrompt[],
  server: QuickPromptStore,
): { prompts: QuickPrompt[]; upload: boolean } {
  const split = splitQuickPrompts(local);
  const personal = server.personal ?? split.personal;
  const shared = server.shared ?? split.shared;
  return {
    prompts: mergeQuickPromptLists(personal, shared.map((prompt) => ({ ...prompt, shared: true }))),
    upload: (server.personal === null && split.personal.length > 0)
      || (server.shared === null && split.shared.length > 0),
  };
}

export function saveQuickPrompts(userId: string | undefined, prompts: QuickPrompt[]): void {
  const { personal, shared } = splitQuickPrompts(prompts);
  try {
    localStorage.setItem(quickPromptStorageKey(userId), JSON.stringify(personal));
    localStorage.setItem(
      sharedQuickPromptStorageKey(),
      JSON.stringify(shared.map((prompt) => ({ ...prompt, shared: true }))),
    );
    window.dispatchEvent(new Event(QUICK_PROMPTS_CHANGED));
  } catch {
    /* a full browser store should not block the composer */
  }
}

/** Saved body when the composer is a title. Otherwise the text unchanged. */
export function quickPromptExpansion(text: string, prompts: QuickPrompt[]): QuickPrompt | null {
  const match = quickPromptForQuery(prompts, text);
  if (!match) return null;
  if (text.trim() === match.body.trim()) return null;
  return match;
}

export function expandQuickPrompt(text: string, prompts: QuickPrompt[]): string {
  return quickPromptExpansion(text, prompts)?.body ?? text;
}

/** Message body plus the short title used for the session name. */
export function resolveQuickPromptSend(
  text: string,
  prompts: QuickPrompt[],
): { text: string; title: string } {
  const trimmed = text.trim();
  const match = quickPromptExpansion(trimmed, prompts);
  if (!match) return { text: trimmed, title: trimmed };
  return { text: match.body, title: match.title };
}

export function filterQuickPrompts(prompts: QuickPrompt[], query: string): QuickPrompt[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return prompts;
  return prompts.filter((prompt) => prompt.title.toLowerCase().includes(needle));
}

/** Exact title, or the only title that contains the query. */
export function quickPromptForQuery(prompts: QuickPrompt[], query: string): QuickPrompt | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  const exact = prompts.find((prompt) => prompt.title === trimmed);
  if (exact) return exact;
  const matches = filterQuickPrompts(prompts, trimmed);
  return matches.length === 1 && matches[0] ? matches[0] : null;
}

export function upsertQuickPrompt(
  prompts: QuickPrompt[],
  input: { id?: string; title: string; body: string; shared?: boolean },
): QuickPrompt[] | null {
  const title = input.title.trim().slice(0, TITLE_MAX);
  const body = input.body.trim().slice(0, BODY_MAX);
  if (!title || !body) return null;
  const id = input.id?.trim();
  const existing = prompts.find((prompt) => prompt.id === id || prompt.title === title);
  const shared = input.shared ?? existing?.shared ?? false;
  const row = (idValue: string): QuickPrompt => (
    shared ? { id: idValue, title, body, shared: true } : { id: idValue, title, body }
  );
  if (existing) {
    return prompts.map((prompt) => (prompt.id === existing.id ? row(existing.id) : prompt));
  }
  const nextId = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `qp-${Date.now()}`;
  return [...prompts, row(nextId)];
}

export function removeQuickPrompt(prompts: QuickPrompt[], id: string): QuickPrompt[] {
  return prompts.filter((prompt) => prompt.id !== id);
}

/** Swap two rows. Returns the same array when either id is missing. */
export function swapQuickPrompts(prompts: QuickPrompt[], id: string, otherId: string): QuickPrompt[] {
  const left = prompts.findIndex((prompt) => prompt.id === id);
  const right = prompts.findIndex((prompt) => prompt.id === otherId);
  if (left < 0 || right < 0 || left === right) return prompts;
  const next = prompts.slice();
  const a = next[left];
  const b = next[right];
  if (!a || !b) return prompts;
  next[left] = b;
  next[right] = a;
  return next;
}
