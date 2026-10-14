/** A persisted transcript row from GET /api/sessions/{id}/messages. */
export interface TranscriptRow {
  role: string;
  content: string;
}

/** How often to look for the answer the disconnected turn is still writing. */
export const DETACHED_TURN_POLL_MS = 3_000;

/** Stop looking after this long. The notice stays; a refresh still loads the record. */
export const DETACHED_TURN_POLL_BUDGET_MS = 10 * 60 * 1000;

/**
 * Assistant text the server has that this page had not already shown before
 * the dropped turn. The last such row is the finished answer. Earlier
 * assistant rows, user rows, and blanks are not a new answer.
 */
export function recoveredAssistant(
  knownAssistantContents: readonly string[],
  rows: readonly TranscriptRow[],
): string | null {
  const known = new Set(
    knownAssistantContents
      .map((content) => content.trim())
      .filter((content) => content.length > 0),
  );
  let found: string | null = null;
  for (const row of rows) {
    if (row.role !== 'assistant') continue;
    const content = row.content.trim();
    if (!content || known.has(content)) continue;
    found = content;
  }
  return found;
}
