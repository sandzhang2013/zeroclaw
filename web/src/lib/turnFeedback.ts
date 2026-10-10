/** Like / dislike for one finished assistant turn. The key is the session
 * plus the reply text, so a reload that mints new bubble ids still matches. */

export type TurnVerdict = 'like' | 'dislike';

export type DislikeReason = 'wrong_data' | 'unhelpful' | 'unsafe' | 'other';

export const DISLIKE_REASONS: DislikeReason[] = [
  'wrong_data',
  'unhelpful',
  'unsafe',
  'other',
];

const CONTENT_MAX = 400;

export interface TurnFeedbackRow {
  session_id: string;
  message_key: string;
  verdict: TurnVerdict;
}

export function normalizeTurnContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, CONTENT_MAX);
}

/** Key for the rateable reply at `index` inside `texts`. Null when that
 * slot has no text. Occurrence disambiguates two identical replies. */
export function turnKeyAt(sessionId: string, texts: string[], index: number): string | null {
  const content = texts[index];
  if (content == null) return null;
  const needle = normalizeTurnContent(content);
  if (!needle) return null;
  let occurrence = 0;
  for (let i = 0; i <= index; i += 1) {
    if (normalizeTurnContent(texts[i] ?? '') === needle) occurrence += 1;
  }
  return `${sessionId}:${occurrence - 1}:${needle}`;
}

export function latestTurnVerdict(
  sessionId: string,
  history: Array<{ role: string; content: string; toolCall?: unknown }>,
  entries: TurnFeedbackRow[],
): TurnVerdict | undefined {
  const texts = history
    .filter((row) => row.role === 'agent' && !row.toolCall && normalizeTurnContent(row.content))
    .map((row) => row.content);
  const key = turnKeyAt(sessionId, texts, texts.length - 1);
  if (!key) return undefined;
  return entries.find((entry) => entry.session_id === sessionId && entry.message_key === key)?.verdict;
}
