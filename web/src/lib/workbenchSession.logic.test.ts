import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_SESSION_TITLE_LENGTH,
  WORKSPACE_STORAGE_KEY,
  gatewaySessionsToRecover,
  readWorkspaceSnapshot,
  sanitizeSessionTitle,
  sessionDisplayTitle,
  workspaceStorageKey,
  dropSessionFromList,
} from './workbenchSession.ts';

test('sanitizeSessionTitle trims, collapses space, and rejects empty', () => {
  assert.equal(sanitizeSessionTitle('  湖北疫情  '), '湖北疫情');
  assert.equal(sanitizeSessionTitle('a \n b'), 'a b');
  assert.equal(sanitizeSessionTitle('   '), null);
  assert.equal(sanitizeSessionTitle(''), null);
  assert.equal(sanitizeSessionTitle(undefined), null);
  assert.equal(sanitizeSessionTitle(1), null);
});

test('sanitizeSessionTitle strips runtime date prefixes from session labels', () => {
  assert.equal(
    sanitizeSessionTitle('[2026-08-20 09:12:35 +08:00] 设计登录界面'),
    '设计登录界面',
  );
  assert.equal(
    sanitizeSessionTitle('[CURRENT DATE & TIME: 2026-08-20 09:12:35 +08:00]\n\n设计登录界面'),
    '设计登录界面',
  );
  assert.equal(
    sanitizeSessionTitle('解释 [2026-08-20 09:12:35 +08:00] 这个例子'),
    '解释 [2026-08-20 09:12:35 +08:00] 这个例子',
  );
});

test('sanitizeSessionTitle drops controls and caps length', () => {
  assert.equal(sanitizeSessionTitle('ok\u0000name'), 'okname');
  const long = '汉'.repeat(MAX_SESSION_TITLE_LENGTH + 8);
  const out = sanitizeSessionTitle(long);
  assert.equal(out?.length, MAX_SESSION_TITLE_LENGTH);
});

test('sessionDisplayTitle prefers title then default then task id', () => {
  assert.equal(
    sessionDisplayTitle({ title: '周报', taskId: 'abc12345' }, '新会话'),
    '周报',
  );
  assert.equal(
    sessionDisplayTitle({ taskId: '__default__' }, '新会话'),
    '新会话',
  );
  assert.equal(
    sessionDisplayTitle({ title: '  ', taskId: 'abc12345' }, '新会话'),
    'abc12345',
  );
  assert.equal(
    sessionDisplayTitle(
      { title: '[2026-08-20 09:12:35 +08:00] 设计登录界面', taskId: 'abc12345' },
      '新会话',
    ),
    '设计登录界面',
  );
});

test('first identity login inherits the unscoped workbench snapshot', () => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    },
    configurable: true,
  });

  const snapshot = JSON.stringify({ sessions: [{ id: 'deepseek::__default__' }], activeSessionId: 'deepseek::__default__' });
  store.set(WORKSPACE_STORAGE_KEY, snapshot);
  assert.equal(readWorkspaceSnapshot('chenmin'), snapshot);
  assert.equal(store.get(workspaceStorageKey('chenmin')), snapshot);
  assert.equal(store.has(WORKSPACE_STORAGE_KEY), false);
  assert.equal(readWorkspaceSnapshot('liuyang'), null);
});

test('leftover unscoped snapshot is merged into an existing empty scoped copy', () => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    },
    configurable: true,
  });

  const legacy = JSON.stringify({
    folders: [{ id: 'f1', name: '周报' }],
    sessions: [{ id: 'deepseek::old', title: '旧会话' }],
    activeSessionId: 'deepseek::old',
  });
  const scoped = JSON.stringify({
    folders: [{ id: 'default', name: '' }],
    sessions: [{ id: 'deepseek::__default__' }],
    activeSessionId: 'deepseek::__default__',
  });
  store.set(WORKSPACE_STORAGE_KEY, legacy);
  store.set(workspaceStorageKey('chenmin'), scoped);

  const merged = JSON.parse(readWorkspaceSnapshot('chenmin') ?? '{}') as {
    sessions: Array<{ id: string }>;
    folders: Array<{ id: string }>;
    activeSessionId: string;
  };
  assert.deepEqual(merged.sessions.map((s) => s.id), ['deepseek::old', 'deepseek::__default__']);
  assert.deepEqual(merged.folders.map((f) => f.id), ['f1', 'default']);
  assert.equal(merged.activeSessionId, 'deepseek::old');
  assert.equal(store.has(WORKSPACE_STORAGE_KEY), false);
  assert.equal(readWorkspaceSnapshot('liuyang'), null);
});

test('gatewaySessionsToRecover keeps owned transcripts and skips empty or foreign rows', () => {
  const rows = gatewaySessionsToRecover(
    [
      {
        session_id: 'default-uuid',
        agent_alias: 'deepseek',
        message_count: 4,
        channel_id: null,
        last_activity: '2026-08-21T00:00:00.000Z',
      },
      {
        session_id: 'unowned-uuid',
        agent_alias: 'deepseek',
        message_count: 5,
        channel_id: null,
        last_activity: '2026-08-21T01:00:00.000Z',
      },
      {
        session_id: 'owned-uuid',
        agent_alias: 'deepseek',
        message_count: 8,
        channel_id: null,
        last_activity: '2026-08-21T03:10:27.000Z',
        name: '周报',
        user_id: 'chenmin',
      },
      {
        session_id: 'empty-uuid',
        agent_alias: 'deepseek',
        message_count: 0,
        channel_id: null,
        last_activity: '2026-08-27T00:00:00.000Z',
        user_id: 'chenmin',
      },
      {
        session_id: 'bob-uuid',
        agent_alias: 'deepseek',
        message_count: 2,
        channel_id: null,
        last_activity: '2026-08-21T00:00:00.000Z',
        user_id: 'liuyang',
      },
      {
        session_id: 'channel-uuid',
        agent_alias: 'deepseek',
        message_count: 3,
        channel_id: 'telegram.ops',
        last_activity: '2026-08-21T00:00:00.000Z',
        user_id: 'chenmin',
      },
    ],
    'default-uuid',
    'chenmin',
  );
  assert.deepEqual(rows, [
    {
      sessionId: 'owned-uuid',
      agentAlias: 'deepseek',
      lastActivity: Date.parse('2026-08-21T03:10:27.000Z'),
      title: '周报',
    },
  ]);
});

test('dropSessionFromList removes the row and moves active to a neighbor', () => {
  const sessions = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(dropSessionFromList(sessions, 'b', 'b'), {
    sessions: [{ id: 'a' }, { id: 'c' }],
    activeSessionId: 'c',
  });
  assert.deepEqual(dropSessionFromList(sessions, 'a', 'c'), {
    sessions: [{ id: 'b' }, { id: 'c' }],
    activeSessionId: 'c',
  });
  assert.deepEqual(dropSessionFromList([{ id: 'only' }], 'only', 'only'), {
    sessions: [],
    activeSessionId: '',
  });
});
