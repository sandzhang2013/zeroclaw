const STORAGE_PREFIX = 'zeroclaw-outline-draft:';

export function outlineDraftStorageKey(sessionId: string): string {
  return `${STORAGE_PREFIX}${sessionId}`;
}

export function loadOutlineDraft(sessionId: string): string | null {
  if (!sessionId) return null;
  try {
    const raw = sessionStorage.getItem(outlineDraftStorageKey(sessionId));
    if (raw == null || raw.trim() === '') return null;
    return raw;
  } catch {
    return null;
  }
}

export function persistOutlineDraft(sessionId: string, text: string | null): void {
  if (!sessionId) return;
  try {
    const key = outlineDraftStorageKey(sessionId);
    if (text == null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, text);
  } catch {
    /* quota / private mode */
  }
}

/** Wrap a hand-edited outline so the model writes the body without re-planning. */
export function composeOutlineContinuePrompt(outline: string): string {
  const body = outline.trim();
  return [
    '请按下面【已确认提纲】撰写正文。不要再改章节结构；某节缺数据时再调用工具查询。',
    '',
    '【已确认提纲】',
    body,
  ].join('\n');
}

const OUTLINE_ASK = /提纲|大纲|\boutlines?\b/i;

/** True when the user asked to draft or revise an outline (not to write the body). */
export function isOutlineEditTurn(userText: string): boolean {
  const q = userText.trim();
  if (!q) return false;
  if (q.includes('【已确认提纲】')) return false;
  return OUTLINE_ASK.test(q);
}

/** Whether the assistant bubble should show「手动修改」. */
export function shouldShowOutlineEditButton(input: {
  isAssistant: boolean;
  streaming: boolean;
  hasProse: boolean;
  content: string;
  previousUserText: string;
}): boolean {
  if (!input.isAssistant || input.streaming || !input.hasProse) return false;
  if (!input.content.trim()) return false;
  return isOutlineEditTurn(input.previousUserText);
}
