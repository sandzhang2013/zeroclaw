import assert from 'node:assert/strict';
import test from 'node:test';

import { getOrCreateSessionId } from './sessionId.ts';
import { generateUUID } from './uuid.ts';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test('getOrCreateSessionId is a UUID and never prefixes user_id', () => {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: localStorage,
    configurable: true,
  });

  const id = getOrCreateSessionId('deepseek');
  assert.match(id, UUID_RE);
  assert.equal(id.includes(':'), false);
  assert.equal(id.startsWith('alice'), false);
  assert.equal(getOrCreateSessionId('deepseek'), id);
});

test('generateUUID is RFC 4122 version 4', () => {
  assert.match(generateUUID(), UUID_RE);
});
