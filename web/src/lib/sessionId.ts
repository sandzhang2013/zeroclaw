import { generateUUID } from './uuid.ts';

export const SESSION_ID_KEY_PREFIX = 'zeroclaw_session_id';

/** Return a stable session ID for the given agent alias, persisted in
 * localStorage. Each agent gets its own session so parallel conversations
 * don't collide. Isolation is the BFF frozen identity — never prefix user_id. */
export function getOrCreateSessionId(agentAlias: string): string {
  const key = `${SESSION_ID_KEY_PREFIX}.${agentAlias}`;
  let id = localStorage.getItem(key);
  if (!id) {
    id = generateUUID();
    localStorage.setItem(key, id);
  }
  return id;
}
