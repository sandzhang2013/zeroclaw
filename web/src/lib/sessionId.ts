import { generateUUID } from './uuid.ts';

export const SESSION_ID_KEY_PREFIX = 'zeroclaw_session_id';

function storageOwner(userId?: string): string {
  return (userId ?? '').replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 128);
}

/** localStorage key for the default per-agent session UUID.
 * Owner is only in the key — the stored value is a bare UUID. */
export function sessionIdStorageKey(agentAlias: string, userId?: string): string {
  const owner = storageOwner(userId);
  return owner
    ? `${SESSION_ID_KEY_PREFIX}.${owner}.${agentAlias}`
    : `${SESSION_ID_KEY_PREFIX}.${agentAlias}`;
}

export function persistSessionId(agentAlias: string, id: string, userId?: string): void {
  localStorage.setItem(sessionIdStorageKey(agentAlias, userId), id);
}

/** Return a stable session ID for the given agent alias, persisted in
 * localStorage. Each agent gets its own session so parallel conversations
 * don't collide. Isolation is the BFF frozen identity — never prefix user_id
 * into the UUID. When `userId` is set, each login gets a distinct UUID so
 * switching mock users does not reuse another user's gateway session. */
export function getOrCreateSessionId(agentAlias: string, userId?: string): string {
  const key = sessionIdStorageKey(agentAlias, userId);
  let id = localStorage.getItem(key);
  if (!id) {
    id = generateUUID();
    localStorage.setItem(key, id);
  }
  return id;
}
