/** Chat transcripts are a cache. The gateway still has the conversation. */
const HISTORY_PREFIX = 'zeroclaw_chat_history_v1:';

function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = 'name' in err ? String(err.name) : '';
  const code = 'code' in err ? Number(err.code) : 0;
  return name === 'QuotaExceededError'
    || name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || code === 22
    || code === 1014;
}

function historyKeys(): string[] {
  if (typeof localStorage.key !== 'function') return [];
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key?.startsWith(HISTORY_PREFIX)) keys.push(key);
  }
  return keys;
}

/** Persist a small pointer. A full quota must not throw into render. */
export function writeLocalStorage(key: string, value: string): boolean {
  try {
    return writeLocalStorageOnce(key, value);
  } catch {
    return false;
  }
}

/** Drop cached transcripts so a session pointer can be stored. */
export function dropChatHistoryCache(): void {
  try {
    for (const key of historyKeys()) localStorage.removeItem(key);
  } catch {
    // Storage may be locked. Callers still have to survive without the cache.
  }
}

function writeLocalStorageOnce(key: string, value: string): boolean {
  const write = (): boolean => {
    localStorage.setItem(key, value);
    return true;
  };
  try {
    return write();
  } catch (err) {
    if (!isQuotaError(err)) return false;
  }
  const victims = historyKeys()
    .filter((item) => item !== key)
    .sort((a, b) => (localStorage.getItem(b)?.length ?? 0) - (localStorage.getItem(a)?.length ?? 0));
  for (const victim of victims) {
    try {
      localStorage.removeItem(victim);
    } catch {
      // Keep trying the remaining cache keys.
    }
    try {
      return write();
    } catch (err) {
      if (!isQuotaError(err)) return false;
    }
  }
  return false;
}
