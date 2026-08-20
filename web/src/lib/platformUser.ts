/** Prototype identity for the workbench. Production skips the picker:
 * the embedding platform injects `window.__ZEROCLAW_PLATFORM_USER__`.
 * Mock login sets a same-origin cookie; the Vite dev proxy (fake BFF)
 * translates it into `X-User-*` + `X-Auth-Secret`. Never encode user_id
 * into gateway session_id. */

export type CanonicalRole = '普通用户' | '高级用户' | '运维';

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
    role: '高级用户',
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
    displayName: '系统运维',
    role: '运维',
    region: '全省',
    org: '湖北省疾病预防控制中心',
    source: 'mock',
  },
];

export function normalizeRole(raw?: string): CanonicalRole {
  const v = (raw ?? '').trim();
  if (v === '高级用户' || v === 'advanced') return '高级用户';
  if (v === '运维' || v === 'ops') return '运维';
  return '普通用户';
}

export function roleI18nKey(role: string): 'workbench.role_advanced' | 'workbench.role_ops' | 'workbench.role_user' {
  const canonical = normalizeRole(role);
  if (canonical === '高级用户') return 'workbench.role_advanced';
  if (canonical === '运维') return 'workbench.role_ops';
  return 'workbench.role_user';
}

/** Config/Logs dashboard is ops-only. Standard and advanced users stay on the workbench. */
export function canOpenDashboard(role?: string): boolean {
  return normalizeRole(role) === '运维';
}

/** Safe localStorage suffix for workbench UI state. Not a gateway identity. */
export function workspaceStorageId(userId: string): string {
  const cleaned = userId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
  return cleaned || 'user';
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

function readInjectedUser(): PlatformUser | null {
  try {
    return parsePlatformPayload(window.__ZEROCLAW_PLATFORM_USER__);
  } catch {
    return null;
  }
}

export function parseMockUserCookie(cookieHeader: string | undefined | null): PlatformUser | null {
  if (!cookieHeader) return null;
  const match = /(?:^|;\s*)zeroclaw_mock_user=([^;]*)/.exec(cookieHeader);
  if (!match) return null;
  let userId = match[1];
  try {
    userId = decodeURIComponent(userId);
  } catch {
    return null;
  }
  return MOCK_USERS.find((u) => u.userId === userId) ?? null;
}

function writeMockUserCookie(userId: string): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${MOCK_USER_COOKIE}=${encodeURIComponent(userId)}; Path=/; SameSite=Lax`;
}

function clearMockUserCookie(): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${MOCK_USER_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
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

export function resolveWorkbenchUser(): PlatformUser | null {
  return readInjectedUser() ?? loadMockUser();
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
  }
}
