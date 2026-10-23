import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHAT_HISTORY_BUDGET_CHARS,
  clearChatHistory,
  loadCachedTranscript,
  loadChatHistory,
  mapServerMessagesToPersisted,
  mergePersistedThinking,
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
      removeItem: (key: string) => {
        store.delete(key);
      },
      key: (index: number) => [...store.keys()][index] ?? null,
      get length() {
        return store.size;
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
    {
      id: '4',
      role: 'agent',
      content: 'answer',
      thinking: 'reason',
      thinkingSeconds: 12,
      timestamp: new Date('2026-01-01T00:00:01Z'),
    },
  ]);
  assert.equal(persisted.length, 3);
  assert.equal(persisted.find((m) => m.id === '2'), undefined);
  assert.equal(persisted.find((m) => m.id === '3')?.local, true);
  assert.equal(persisted.find((m) => m.id === '4')?.thinkingSeconds, 12);
  assert.equal(persistedToUiMessages(persisted).find((m) => m.id === '4')?.thinkingSeconds, 12);
});

test('mergePersistedThinking restores thinking onto the matching assistant row', () => {
  const merged = mergePersistedThinking(
    [
      { id: 'u', role: 'user', content: '算一下', timestamp: '2026-01-01T00:00:00.000Z' },
      { id: 'a', role: 'agent', content: '391', markdown: true, timestamp: '2026-01-01T00:00:01.000Z' },
    ],
    [
      { id: 'local-a', role: 'agent', content: '391', thinking: '17×20', thinkingSeconds: 4, timestamp: '2026-01-01T00:00:01.000Z' },
      { id: 'other', role: 'agent', content: '别的', thinking: '不该配上', timestamp: '2026-01-01T00:00:02.000Z' },
    ],
  );
  assert.equal(merged[1]?.thinking, '17×20');
  assert.equal(merged[1]?.thinkingSeconds, 4);
  assert.equal(merged[0]?.thinking, undefined);
});

test('thinking cache drops the report body and still restores reasoning', () => {
  const store = mockLocalStorage();
  const report = `结论\n\n\`\`\`html\n${'<div>report</div>'.repeat(200)}\n\`\`\``;
  saveChatHistory('deep', [
    { id: 'u', role: 'user', content: '出一份报告', timestamp: '2026-01-01T00:00:00.000Z' },
    {
      id: 'a',
      role: 'agent',
      content: report,
      thinking: '先查数据',
      thinkingSeconds: 3,
      toolCall: {
        name: 'file_write',
        args: { body: 'x'.repeat(8000) },
        output: 'y'.repeat(8000),
        artifact: {
          path: 'sessions/s/a.html',
          filename: 'a.html',
          title: '报告',
          mime: 'text/html',
          size: 12,
        },
      },
      timestamp: '2026-01-01T00:00:01.000Z',
    },
  ], 'thinking');

  const raw = store.get('zeroclaw_chat_history_v1:deep') ?? '';
  assert.equal(raw.includes('<div>report</div>'), false);
  assert.equal(raw.includes('出一份报告'), false);
  assert.equal(raw.includes('x'.repeat(100)), false);
  const cached = loadChatHistory('deep');
  assert.equal(cached.length, 1);
  assert.equal(cached[0]?.content, '');
  assert.equal(cached[0]?.thinking, '先查数据');
  assert.equal(cached[0]?.thinkingSeconds, 3);
  assert.equal(cached[0]?.toolCall?.name, 'file_write');
  assert.equal(cached[0]?.toolCall?.output, undefined);
  assert.equal(cached[0]?.toolCall?.artifact, undefined);
  assert.deepEqual(loadCachedTranscript('deep'), []);

  const merged = mergePersistedThinking(
    [{ id: 'srv', role: 'agent', content: report, markdown: true, timestamp: '2026-01-01T00:00:01.000Z' }],
    cached,
  );
  assert.equal(merged[0]?.thinking, '先查数据');
  assert.equal(merged[0]?.thinkingSeconds, 3);
  assert.equal(merged[0]?.content, report);
});

test('transcript cache strips html fences and caps tool output', () => {
  mockLocalStorage();
  saveChatHistory('offline', [{
    id: 'a',
    role: 'agent',
    content: `说明\n\n\`\`\`html\n${'<p>body</p>'.repeat(300)}\n\`\`\`\n\n结束`,
    thinking: '想一下',
    toolCall: {
      name: 'file_write',
      args: { body: 'z'.repeat(9000) },
      output: 'o'.repeat(8000),
      artifact: {
        path: 'sessions/s/a.html',
        filename: 'a.html',
        title: '报告',
        mime: 'text/html',
        size: 10,
      },
    },
    timestamp: '2026-01-01T00:00:00.000Z',
  }]);
  const row = loadChatHistory('offline')[0];
  assert.match(row?.content ?? '', /说明/);
  assert.match(row?.content ?? '', /结束/);
  assert.equal(row?.content.includes('<p>body</p>'), false);
  assert.equal(row?.toolCall?.args, undefined);
  assert.equal(row?.toolCall?.output?.length, 4096);
  assert.equal(row?.toolCall?.artifact?.path, 'sessions/s/a.html');
  assert.equal(row?.thinking, '想一下');
  assert.ok((row?.contentPreview?.length ?? 0) <= 400);
  assert.equal(loadCachedTranscript('offline').length, 1);
});

test('saveChatHistory drops the oldest conversation once the cache budget is full', () => {
  const store = mockLocalStorage();
  const fat = 'z'.repeat(CHAT_HISTORY_BUDGET_CHARS - 50_000);
  store.set('zeroclaw_chat_history_v1:old', JSON.stringify({
    messages: [{ id: 'old', role: 'user', content: fat, timestamp: '2020-01-01T00:00:00.000Z' }],
  }));
  store.set('zeroclaw_chat_history_v1:keep', JSON.stringify({
    messages: [{ id: 'keep', role: 'user', content: 'stay', timestamp: '2026-01-01T00:00:00.000Z' }],
  }));
  saveChatHistory('new', [{
    id: 'n',
    role: 'user',
    content: 'y'.repeat(80_000),
    timestamp: '2026-06-01T00:00:00.000Z',
  }]);
  assert.equal(store.has('zeroclaw_chat_history_v1:old'), false);
  assert.equal(store.has('zeroclaw_chat_history_v1:keep'), true);
  assert.equal(loadChatHistory('new')[0]?.id, 'n');
  let total = 0;
  for (const value of store.values()) total += value.length;
  assert.ok(total <= CHAT_HISTORY_BUDGET_CHARS);
});

test('clearChatHistory removes the persisted transcript', () => {
  mockLocalStorage();
  saveChatHistory('s-del', [
    { id: '1', role: 'user', content: 'hi', timestamp: '2026-01-01T00:00:00.000Z' },
  ]);
  assert.equal(loadChatHistory('s-del').length, 1);
  clearChatHistory('s-del');
  assert.deepEqual(loadChatHistory('s-del'), []);
});
