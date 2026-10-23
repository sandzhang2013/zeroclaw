import assert from 'node:assert/strict';
import test from 'node:test';

import { writeLocalStorage } from './localStorageWrite.ts';

function installStore(opts: { fail: 'until-history-gone' | 'always' }) {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      get length() {
        return store.size;
      },
      key: (index: number) => [...store.keys()][index] ?? null,
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        const historyLeft = [...store.keys()].some((item) => item.startsWith('zeroclaw_chat_history_v1:') && item !== key);
        const blocked = opts.fail === 'always' || (opts.fail === 'until-history-gone' && historyLeft);
        if (blocked && key.startsWith('zeroclaw_session_id.')) {
          const err = new Error('quota');
          err.name = 'QuotaExceededError';
          throw err;
        }
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    },
    configurable: true,
  });
  return store;
}

test('writeLocalStorage drops chat cache and retries when the quota is full', () => {
  const store = installStore({ fail: 'until-history-gone' });
  store.set('zeroclaw_chat_history_v1:old', 'x'.repeat(50));
  const key = 'zeroclaw_session_id.task.deepseek.c3ee39fd';
  assert.equal(writeLocalStorage(key, '11111111-1111-4111-8111-111111111111'), true);
  assert.equal(store.get(key), '11111111-1111-4111-8111-111111111111');
  assert.equal(store.has('zeroclaw_chat_history_v1:old'), false);
});

test('writeLocalStorage does not throw when storage stays full', () => {
  installStore({ fail: 'always' });
  assert.equal(writeLocalStorage('zeroclaw_session_id.task.deepseek.c3ee39fd', 'session'), false);
});
