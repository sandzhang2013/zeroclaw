import { workspaceStorageId } from './platformUser.ts';

/** Workbench conversation titles. Local UI state — not a gateway session key. */

export const WORKSPACE_STORAGE_KEY = 'zeroclaw-chat-workspace-v3';
export const WORKSPACE_STORAGE_KEY_V2 = 'zeroclaw-chat-workspace-v2';

export function workspaceStorageKey(userId?: string): string {
  return userId ? `${WORKSPACE_STORAGE_KEY}:${workspaceStorageId(userId)}` : WORKSPACE_STORAGE_KEY;
}

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function idOf(item: unknown): string | null {
  if (!item || typeof item !== 'object') return null;
  const id = (item as { id?: unknown }).id;
  return typeof id === 'string' && id ? id : null;
}

function unionById(primary: unknown, secondary: unknown): unknown[] {
  const a = Array.isArray(primary) ? primary : [];
  const b = Array.isArray(secondary) ? secondary : [];
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const item of [...a, ...b]) {
    const id = idOf(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(item);
  }
  return out;
}

/** Merge leftover pre-identity snapshot into the first user's scoped copy. */
function mergeWorkspaceSnapshots(scopedRaw: string | null, legacyRaw: string): string {
  const scoped = parseObject(scopedRaw);
  const legacy = parseObject(legacyRaw);
  if (!legacy) return scopedRaw ?? legacyRaw;
  if (!scoped) return legacyRaw;

  const sessions = unionById(legacy.sessions, scoped.sessions);
  const folders = unionById(legacy.folders, scoped.folders);
  const sessionIds = new Set(sessions.map(idOf).filter((id): id is string => Boolean(id)));
  const legacyActive = typeof legacy.activeSessionId === 'string' ? legacy.activeSessionId : '';
  const scopedActive = typeof scoped.activeSessionId === 'string' ? scoped.activeSessionId : '';
  const activeSessionId = sessionIds.has(legacyActive)
    ? legacyActive
    : sessionIds.has(scopedActive)
      ? scopedActive
      : (idOf(sessions[0]) ?? '');

  return JSON.stringify({
    ...legacy,
    ...scoped,
    ...(folders.length ? { folders } : {}),
    sessions,
    activeSessionId,
  });
}

/** Read the sidebar snapshot. Leftover pre-identity (unscoped) data is claimed
 * by the first identity that loads, even if that user already has a scoped copy. */
export function readWorkspaceSnapshot(userId?: string): string | null {
  if (typeof localStorage === 'undefined') return null;
  const legacy =
    localStorage.getItem(WORKSPACE_STORAGE_KEY)
    ?? localStorage.getItem(WORKSPACE_STORAGE_KEY_V2);
  if (!userId) return legacy;
  const scopedKey = workspaceStorageKey(userId);
  const scoped = localStorage.getItem(scopedKey);
  if (!legacy) return scoped;
  const merged = mergeWorkspaceSnapshots(scoped, legacy);
  localStorage.setItem(scopedKey, merged);
  localStorage.removeItem(WORKSPACE_STORAGE_KEY);
  localStorage.removeItem(WORKSPACE_STORAGE_KEY_V2);
  return merged;
}

export interface RecoverableGatewaySession {
  session_id: string;
  agent_alias: string | null;
  message_count: number;
  channel_id: string | null;
  last_activity: string;
  name?: string;
  user_id?: string | null;
}

/** Gateway rows that should appear in the workbench sidebar. Empty and
 * channel-owned sessions stay out; the default UUID is already a tab. */
export function gatewaySessionsToRecover(
  rows: RecoverableGatewaySession[],
  defaultSessionId: string,
  userId?: string,
): Array<{ sessionId: string; agentAlias: string; lastActivity: number; title?: string }> {
  const out: Array<{ sessionId: string; agentAlias: string; lastActivity: number; title?: string }> = [];
  for (const row of rows) {
    if (!row.agent_alias || row.channel_id || row.message_count <= 0) continue;
    if (row.session_id === defaultSessionId) continue;
    if (userId && row.user_id && row.user_id !== userId) continue;
    const title = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : undefined;
    out.push({
      sessionId: row.session_id,
      agentAlias: row.agent_alias,
      lastActivity: Date.parse(row.last_activity) || 0,
      title,
    });
  }
  return out;
}

export const MAX_SESSION_TITLE_LENGTH = 128;

const BARE_TIMESTAMP_PREFIX =
  /^\[\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:\s*(?:UTC|[+-]\d{2}:?\d{2}))?\]\s*/;
const LABELED_TIMESTAMP_PREFIX =
  /^\[CURRENT DATE & TIME:\s*[^\]]+\]\s*/i;

/** Drop runtime-injected date prefixes so sidebar labels stay the user text. */
export function stripSessionTitleTimestamp(raw: string): string {
  let out = raw.trim();
  for (;;) {
    const next = out.replace(LABELED_TIMESTAMP_PREFIX, '').replace(BARE_TIMESTAMP_PREFIX, '').trim();
    if (next === out) return out;
    out = next;
  }
}

/** Trim, collapse whitespace, drop controls. Empty input is rejected. */
export function sanitizeSessionTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = stripSessionTitleTimestamp(raw)
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, MAX_SESSION_TITLE_LENGTH);
}

export function sessionDisplayTitle(
  session: { title?: string; taskId: string },
  untitledFallback: string,
): string {
  const title = sanitizeSessionTitle(session.title);
  if (title) return title;
  if (session.taskId === '__default__') return untitledFallback;
  return session.taskId;
}
