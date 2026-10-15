import { DEFAULT_WEB_PREFIX } from './webPrefix.ts';

/** Prototype identity for the workbench. Production skips the picker:
 * the embedding platform injects `window.__ZEROCLAW_PLATFORM_USER__`.
 * Mock login sets a same-origin cookie; the Vite dev proxy (fake BFF)
 * translates it into `X-User-*` + `X-Auth-Secret`. Never encode user_id
 * into gateway session_id. */

export type CanonicalRole = '普通用户' | '管理员';

export interface PlatformUser {
  userId: string;
  displayName: string;
  role: CanonicalRole;
  region: string;
  org: string;
  source: 'mock' | 'platform';
}

const MOCK_STORAGE_KEY = 'zeroclaw-workbench-mock-user';
export const MOCK_USER_COOKIE = 'zeroclaw_mock_user';

export const MOCK_USERS: PlatformUser[] = [
  {
    userId: 'chenmin',
    displayName: '陈敏',
    role: '普通用户',
    region: '武汉市',
    org: '武汉市疾病预防控制中心',
    source: 'mock',
  },
  {
    userId: 'liuyang',
    displayName: '刘洋',
    role: '普通用户',
    region: '武汉市',
    org: '武汉市疾病预防控制中心',
    source: 'mock',
  },
  {
    userId: 'zhoujing',
    displayName: '周静',
    role: '普通用户',
    region: '宜昌市',
    org: '宜昌市疾病预防控制中心',
    source: 'mock',
  },
  {
    userId: 'ops',
    displayName: '系统管理员',
    role: '管理员',
    region: '全省',
    org: '湖北省疾病预防控制中心',
    source: 'mock',
  },
];

export function normalizeRole(raw?: string): CanonicalRole {
  const v = (raw ?? '').trim();
  if (v === '管理员' || v === 'ops') return '管理员';
  return '普通用户';
}

export function roleI18nKey(role: string): 'workbench.role_ops' | 'workbench.role_user' {
  if (normalizeRole(role) === '管理员') return 'workbench.role_ops';
  return 'workbench.role_user';
}

/** Config/Logs dashboard is ops-only. Ordinary users stay on the workbench. */
export function canOpenDashboard(role?: string): boolean {
  return normalizeRole(role) === '管理员';
}

/** Safe localStorage suffix for workbench UI state. Not a gateway identity. */
export function workspaceStorageId(userId: string): string {
  const cleaned = userId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
  return cleaned || 'user';
}

function textField(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** Verify response uses nickName/userName. HTML inject uses displayName. */
export function platformUserFromTicket(raw: unknown): PlatformUser | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const userId = textField(o, 'userId');
  if (!userId) return null;
  const displayName =
    textField(o, 'nickName') || textField(o, 'userName') || textField(o, 'displayName') || userId;
  return parsePlatformPayload({
    userId,
    displayName,
    role: textField(o, 'role') || undefined,
    region: textField(o, 'region') || textField(o, 'regionName') || textField(o, 'regionCode'),
    org: textField(o, 'org') || textField(o, 'tenantName'),
  });
}

/** The page verifies after HTML is painted. Replace a leftover inject. */
export function applyTicketUser(raw: unknown): void {
  const user = platformUserFromTicket(raw);
  if (!user || typeof window === 'undefined') return;
  window.__ZEROCLAW_PLATFORM_USER__ = {
    userId: user.userId,
    displayName: user.displayName,
    role: user.role,
    region: user.region,
    org: user.org,
  };
}

export function parsePlatformPayload(raw: unknown): PlatformUser | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const userId = typeof o.userId === 'string' ? o.userId.trim() : '';
  const displayName = typeof o.displayName === 'string' ? o.displayName.trim() : '';
  if (!userId || !displayName) return null;
  if (userId.includes('..') || /[/\\]/.test(userId) || /[\u0000-\u001f]/.test(userId)) return null;
  return {
    userId,
    displayName,
    role: normalizeRole(typeof o.role === 'string' ? o.role : undefined),
    region: typeof o.region === 'string' ? o.region.trim() : '',
    org: typeof o.org === 'string' ? o.org.trim() : '',
    source: 'platform',
  };
}

export function parseMockUserCookie(cookieHeader: string | undefined | null): PlatformUser | null {
  if (!cookieHeader) return null;
  const re = /(?:^|;\s*)zeroclaw_mock_user=([^;]*)/g;
  let encoded: string | undefined;
  let match: RegExpExecArray | null;
  while ((match = re.exec(cookieHeader)) !== null) {
    encoded = match[1];
  }
  if (!encoded) return null;
  let userId: string;
  try {
    userId = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  return MOCK_USERS.find((u) => u.userId === userId) ?? null;
}

function mockCookiePath(): string {
  return DEFAULT_WEB_PREFIX || '/';
}

function writeMockUserCookie(userId: string): void {
  if (typeof document === 'undefined') return;
  const path = mockCookiePath();
  // Drop the legacy Path=/ copy so it cannot win over Path=/hbcdcagent.
  if (path !== '/') {
    document.cookie = `${MOCK_USER_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
  }
  document.cookie = `${MOCK_USER_COOKIE}=${encodeURIComponent(userId)}; Path=${path}; SameSite=Lax`;
}

function clearMockUserCookie(): void {
  if (typeof document === 'undefined') return;
  const path = mockCookiePath();
  document.cookie = `${MOCK_USER_COOKIE}=; Path=${path}; Max-Age=0; SameSite=Lax`;
  if (path !== '/') {
    document.cookie = `${MOCK_USER_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
  }
}

export function loadMockUser(): PlatformUser | null {
  try {
    const raw = sessionStorage.getItem(MOCK_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PlatformUser>;
    const match = MOCK_USERS.find((u) => u.userId === parsed.userId);
    if (match) writeMockUserCookie(match.userId);
    return match ?? null;
  } catch {
    return null;
  }
}

export function saveMockUser(user: PlatformUser): void {
  try {
    sessionStorage.setItem(MOCK_STORAGE_KEY, JSON.stringify({ userId: user.userId }));
    writeMockUserCookie(user.userId);
  } catch { /* noop */ }
}

export function clearMockUser(): void {
  try {
    sessionStorage.removeItem(MOCK_STORAGE_KEY);
    clearMockUserCookie();
  } catch { /* noop */ }
}

/**
 * A real SSO inject wins over a leftover local cookie. Catalog injects still
 * lose to the cookie: switching mock users does not reload the document, so
 * `__ZEROCLAW_PLATFORM_USER__` can still be the first login.
 */
export function pickWorkbenchIdentity(input: {
  injected?: unknown;
  cookieHeader?: string | null;
  storedUserId?: string | null;
}): PlatformUser | null {
  const injected = parsePlatformPayload(input.injected);
  const fromCookie = parseMockUserCookie(input.cookieHeader);
  if (injected && !MOCK_USERS.some((user) => user.userId === injected.userId)) {
    return injected;
  }
  if (fromCookie) return fromCookie;
  if (injected) return switchableWorkbenchUser(injected);
  if (input.storedUserId) {
    return MOCK_USERS.find((u) => u.userId === input.storedUserId) ?? null;
  }
  return null;
}

export function resolveWorkbenchUser(): PlatformUser | null {
  const injected =
    typeof window !== 'undefined' ? window.__ZEROCLAW_PLATFORM_USER__ : undefined;
  // SSO pages set this flag. A leftover local cookie or sessionStorage must
  // not paint the mock picker over the injected user.
  if (typeof window !== 'undefined' && window.__ZEROCLAW_LOCAL_MOCK__ === false) {
    clearMockUser();
    return parsePlatformPayload(injected);
  }
  const cookieHeader = typeof document !== 'undefined' ? document.cookie : undefined;
  const picked = pickWorkbenchIdentity({ injected, cookieHeader });
  if (picked) return picked;
  return loadMockUser();
}

/** Catalog mock ids stay switchable even when the BFF HTML-injected them. */
export function switchableWorkbenchUser(user: PlatformUser): PlatformUser {
  const catalog = MOCK_USERS.find((u) => u.userId === user.userId);
  return catalog ? { ...catalog, source: 'mock' } : user;
}

declare global {
  interface Window {
    /** Injected by the embedding platform BFF. Presence skips the mock login. */
    __ZEROCLAW_PLATFORM_USER__?: {
      userId: string;
      displayName: string;
      role?: string;
      region?: string;
      org?: string;
    };
    /** Set by the BFF outside local mock. Disables the leftover mock cookie. */
    __ZEROCLAW_LOCAL_MOCK__?: boolean;
  }
}
