/** In-memory session for a cross-site iframe, where SameSite=Lax cookies are not stored. */

const HEADER = 'X-Hbcdcagent-Session';
const PROTOCOL_PREFIX = 'hbcs.';

let sessionId: string | null = null;

export function rememberEmbedSession(id: string | null | undefined): void {
  const next = (id ?? '').trim();
  sessionId = isSessionId(next) ? next : null;
}

export function embedSessionId(): string | null {
  return sessionId;
}

export function applyEmbedSession(headers: Headers): void {
  if (sessionId) headers.set(HEADER, sessionId);
}

export function embedWsProtocol(): string | null {
  return sessionId ? `${PROTOCOL_PREFIX}${sessionId}` : null;
}

function isSessionId(value: string): boolean {
  return /^[0-9a-fA-F-]{36}$/.test(value);
}
