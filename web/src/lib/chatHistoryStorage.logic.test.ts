import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadChatHistory,
  mapServerMessagesToPersisted,
  persistedToUiMessages,
  saveChatHistory,
  uiMessagesToPersisted,
} from './chatHistoryStorage.ts';

function mockLocalStorage() {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    },
    configurable: true,
  });
  return store;
}

test('loadChatHistory returns empty on missing or corrupt payloads', () => {
  const store = mockLocalStorage();
  assert.deepEqual(loadChatHistory('s1'), []);
  store.set('zeroclaw_chat_history_v1:s1', '{not json');
  assert.deepEqual(loadChatHistory('s1'), []);
  store.set('zeroclaw_chat_history_v1:s1', JSON.stringify({ messages: [] }));
  assert.deepEqual(loadChatHistory('s1'), []);
});

test('saveChatHistory keeps the last 100 messages and round-trips artifacts', () => {
  mockLocalStorage();
  const many = Array.from({ length: 105 }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? 'user' as const : 'agent' as const,
    content: `c${i}`,
    timestamp: new Date(2026, 0, 1, 0, 0, i).toISOString(),
  }));
  saveChatHistory('sess', many);
  const loaded = loadChatHistory('sess');
  assert.equal(loaded.length, 100);
  assert.equal(loaded[0]?.id, 'm5');
  assert.equal(loaded.at(-1)?.id, 'm104');

  saveChatHistory('art', [{
    id: 't1',
    role: 'agent',
    content: 'chart',
    markdown: true,
    toolCall: {
      name: 'file_write',
      artifact: {
        path: 'sessions/s1/login.html',
        filename: 'login.html',
        title: '登录页',
        mime: 'text/html',
        size: 12,
      },
    },
    timestamp: '2026-01-01T00:00:00.000Z',
  }]);
  assert.equal(loadChatHistory('art')[0]?.toolCall?.artifact?.path, 'sessions/s1/login.html');
});

test('mapServerMessagesToPersisted skips system rows and ui round-trip drops ephemeral', () => {
  const mapped = mapServerMessagesToPersisted([
    { role: 'system', content: 'hidden', created_at: null },
    { role: 'user', content: 'hi', created_at: null },
    { role: 'assistant', content: '**ok**', created_at: null },
    { role: 'tool', content: 'done', created_at: null },
  ]);
  assert.equal(mapped.length, 3);
  assert.equal(mapped[0]?.role, 'user');
  assert.equal(mapped[1]?.markdown, true);
  assert.equal(mapped[2]?.role, 'agent');
  assert.equal(mapped[2]?.markdown, false);

  const ui = persistedToUiMessages(mapped);
  assert.ok(ui[0]?.timestamp instanceof Date);

  const persisted = uiMessagesToPersisted([
    { id: '1', role: 'user', content: 'x', timestamp: new Date('2026-01-01T00:00:00Z') },
    { id: '2', role: 'agent', content: 'help', ephemeral: true, timestamp: new Date() },
    {
      id: '3',
      role: 'user',
      content: 'local',
      local: true,
      timestamp: new Date('2026-01-01T00:00:00Z'),
    },
  ]);
  assert.equal(persisted.length, 2);
  assert.equal(persisted.find((m) => m.id === '2'), undefined);
  assert.equal(persisted.find((m) => m.id === '3')?.local, true);
});
