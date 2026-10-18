/** Session for a cross-site iframe, where SameSite=Lax cookies are not stored.
 *  Memory alone dies on refresh, and the next file request then gets
 *  `login required`. sessionStorage keeps it for this tab. */

const HEADER = 'X-Hbcdcagent-Session';
const PROTOCOL_PREFIX = 'hbcs.';
const STORAGE_KEY = 'hbcdcagent_embed_session';

let sessionId: string | null = null;

export function rememberEmbedSession(id: string | null | undefined): void {
  const next = (id ?? '').trim();
  sessionId = isSessionId(next) ? next : null;
  writeStored(sessionId);
}

export function embedSessionId(): string | null {
  return currentSession();
}

export function applyEmbedSession(headers: Headers): void {
  const id = currentSession();
  if (id) headers.set(HEADER, id);
}

export function embedWsProtocol(): string | null {
  const id = currentSession();
  return id ? `${PROTOCOL_PREFIX}${id}` : null;
}

function currentSession(): string | null {
  if (sessionId) return sessionId;
  const stored = readStored();
  if (!stored || !isSessionId(stored)) return null;
  sessionId = stored;
  return sessionId;
}

function readStored(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(id: string | null): void {
  try {
    if (id) sessionStorage.setItem(STORAGE_KEY, id);
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode or a sandboxed frame can reject storage.
  }
}

function isSessionId(value: string): boolean {
  return /^[0-9a-fA-F-]{36}$/.test(value);
}
