import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canOpenDashboard,
  normalizeRole,
  parseMockUserCookie,
  parsePlatformPayload,
  pickWorkbenchIdentity,
  roleI18nKey,
  switchableWorkbenchUser,
  workspaceStorageId,
} from './platformUser.ts';

test('parsePlatformPayload requires userId and displayName', () => {
  assert.equal(parsePlatformPayload(null), null);
  assert.equal(parsePlatformPayload({ userId: 'alice' }), null);
  assert.equal(parsePlatformPayload({ displayName: 'Alice' }), null);
});

test('parsePlatformPayload rejects path-like user ids', () => {
  assert.equal(parsePlatformPayload({ userId: '../alice', displayName: 'Alice' }), null);
  assert.equal(parsePlatformPayload({ userId: 'a/b', displayName: 'Alice' }), null);
});

test('parsePlatformPayload maps BFF roles and skips login identity into session_id', () => {
  const user = parsePlatformPayload({
    userId: 'liuyang',
    displayName: '刘洋',
    role: 'advanced',
    region: '武汉市',
    org: '武汉市疾病预防控制中心',
  });
  assert.ok(user);
  assert.equal(user.source, 'platform');
  assert.equal(user.role, '高级用户');
  assert.equal(user.userId.includes(':'), false);
  const mock = switchableWorkbenchUser(user);
  assert.equal(mock.source, 'mock');
  assert.equal(mock.displayName, '刘洋');
});

test('normalizeRole and storage id stay UI-only', () => {
  assert.equal(normalizeRole('运维'), '运维');
  assert.equal(normalizeRole('ops'), '运维');
  assert.equal(roleI18nKey('高级用户'), 'workbench.role_advanced');
  assert.equal(workspaceStorageId('liu/yang'), 'liu_yang');
});

test('only ops can open the dashboard', () => {
  assert.equal(canOpenDashboard('运维'), true);
  assert.equal(canOpenDashboard('ops'), true);
  assert.equal(canOpenDashboard('普通用户'), false);
  assert.equal(canOpenDashboard('高级用户'), false);
});

test('parseMockUserCookie only accepts catalog users', () => {
  assert.equal(parseMockUserCookie(undefined), null);
  assert.equal(parseMockUserCookie('other=1'), null);
  assert.equal(parseMockUserCookie('zeroclaw_mock_user=not-a-user'), null);
  const user = parseMockUserCookie('zeroclaw_mock_user=liuyang; Path=/');
  assert.ok(user);
  assert.equal(user.userId, 'liuyang');
  assert.equal(user.role, '高级用户');
  assert.equal(user.region, '武汉市');
});

test('parsePlatformPayload rejects control chars, backslash, and empty ids', () => {
  assert.equal(parsePlatformPayload({ userId: 'a\\b', displayName: 'A' }), null);
  assert.equal(parsePlatformPayload({ userId: 'alice\u0000', displayName: 'A' }), null);
  assert.equal(parsePlatformPayload({ userId: '  ', displayName: 'A' }), null);
  assert.equal(parsePlatformPayload({ userId: 'alice', displayName: '  ' }), null);
  assert.equal(parsePlatformPayload('alice'), null);
  assert.equal(parsePlatformPayload([]), null);
});

test('parsePlatformPayload keeps colon in userId and does not mint session keys', () => {
  const user = parsePlatformPayload({ userId: 'liu:yang', displayName: '刘洋' });
  assert.ok(user);
  assert.equal(user.userId, 'liu:yang');
  assert.equal(user.role, '普通用户');
  assert.equal(user.source, 'platform');
});

test('normalizeRole maps aliases and unknown values to 普通用户', () => {
  assert.equal(normalizeRole('普通用户'), '普通用户');
  assert.equal(normalizeRole('advanced'), '高级用户');
  assert.equal(normalizeRole('  ops  '), '运维');
  assert.equal(normalizeRole('admin'), '普通用户');
  assert.equal(normalizeRole(undefined), '普通用户');
  assert.equal(roleI18nKey('ops'), 'workbench.role_ops');
  assert.equal(roleI18nKey('nobody'), 'workbench.role_user');
});

test('workspaceStorageId is a UI suffix, never a path', () => {
  assert.equal(workspaceStorageId(''), 'user');
  assert.equal(workspaceStorageId('../etc'), '.._etc');
  assert.equal(workspaceStorageId('a'.repeat(80)).length, 64);
  assert.equal(workspaceStorageId('chen.min-1'), 'chen.min-1');
});

test('parseMockUserCookie reads among other cookies and decodes URI', () => {
  const encoded = parseMockUserCookie(
    'theme=dark; zeroclaw_mock_user=chenmin; other=1',
  );
  assert.equal(encoded?.userId, 'chenmin');
  assert.equal(encoded?.role, '普通用户');
  const hex = parseMockUserCookie('zeroclaw_mock_user=%6C%69%75%79%61%6E%67');
  assert.equal(hex?.userId, 'liuyang');
  assert.equal(parseMockUserCookie('zeroclaw_mock_user=%E0%A4%A'), null);
  assert.equal(parseMockUserCookie('zeroclaw_mock_user=ops')?.role, '运维');
  assert.equal(
    parseMockUserCookie('zeroclaw_mock_user=chenmin; zeroclaw_mock_user=ops')?.userId,
    'ops',
  );
  assert.equal(canOpenDashboard(undefined), false);
  assert.equal(canOpenDashboard('admin'), false);
});

test('catalog injects stay mock so the sidebar can return to the picker', () => {
  const injected = parsePlatformPayload({
    userId: 'chenmin',
    displayName: '陈敏',
    role: '普通用户',
  });
  assert.ok(injected);
  assert.equal(injected.source, 'platform');
  assert.equal(switchableWorkbenchUser(injected).source, 'mock');
  const sso = parsePlatformPayload({ userId: 'alice', displayName: '爱丽丝' });
  assert.ok(sso);
  assert.equal(switchableWorkbenchUser(sso).source, 'platform');
});

test('pickWorkbenchIdentity prefers mock cookie over a stale HTML inject', () => {
  const switched = pickWorkbenchIdentity({
    injected: { userId: 'chenmin', displayName: '陈敏', role: '普通用户' },
    cookieHeader: 'zeroclaw_mock_user=ops',
  });
  assert.equal(switched?.userId, 'ops');
  assert.equal(canOpenDashboard(switched?.role), true);

  const fromInject = pickWorkbenchIdentity({
    injected: { userId: 'ops', displayName: '系统运维', role: '运维' },
    cookieHeader: '',
  });
  assert.equal(fromInject?.userId, 'ops');
  assert.equal(fromInject?.source, 'mock');

  const sso = pickWorkbenchIdentity({
    injected: { userId: 'alice', displayName: '爱丽丝', role: '运维' },
  });
  assert.equal(sso?.userId, 'alice');
  assert.equal(sso?.source, 'platform');
  assert.equal(canOpenDashboard(sso?.role), true);

  const stored = pickWorkbenchIdentity({ storedUserId: 'liuyang' });
  assert.equal(stored?.userId, 'liuyang');
});
