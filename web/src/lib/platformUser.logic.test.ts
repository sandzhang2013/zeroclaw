import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canOpenDashboard,
  normalizeRole,
  parseMockUserCookie,
  parsePlatformPayload,
  roleI18nKey,
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
