/** Workbench conversation titles. Local UI state — not a gateway session key. */

export const MAX_SESSION_TITLE_LENGTH = 64;

/** Trim, collapse whitespace, drop controls. Empty input is rejected. */
export function sanitizeSessionTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.slice(0, MAX_SESSION_TITLE_LENGTH);
}

export function sessionDisplayTitle(
  session: { title?: string; taskId: string },
  untitledFallback: string,
): string {
  const title = session.title?.trim();
  if (title) return title;
  if (session.taskId === '__default__') return untitledFallback;
  return session.taskId;
}
