import assert from 'node:assert/strict';
import test from 'node:test';

import { getOrCreateSessionId } from './sessionId.ts';
import { generateUUID } from './uuid.ts';
import { releaseWebSocket } from './ws.release.ts';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

test('getOrCreateSessionId is a UUID and never prefixes user_id', () => {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: localStorage,
    configurable: true,
  });

  const alice = getOrCreateSessionId('deepseek', 'alice');
  const bob = getOrCreateSessionId('deepseek', 'bob');
  assert.match(alice, UUID_RE);
  assert.match(bob, UUID_RE);
  assert.notEqual(alice, bob);
  assert.equal(alice.includes(':'), false);
  assert.equal(alice.includes('alice'), false);
  assert.equal(getOrCreateSessionId('deepseek', 'alice'), alice);
});

test('first identity login inherits the pre-identity session UUID', () => {
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

  const legacy = getOrCreateSessionId('deepseek');
  const alice = getOrCreateSessionId('deepseek', 'alice');
  const bob = getOrCreateSessionId('deepseek', 'bob');
  assert.equal(alice, legacy);
  assert.notEqual(bob, alice);
  assert.equal(store.has('zeroclaw_session_id.deepseek'), false);
});

test('leftover unscoped UUID is claimed even if the first user already minted one', () => {
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

  store.set('zeroclaw_session_id.alice.deepseek', '11111111-1111-4111-8111-111111111111');
  store.set('zeroclaw_session_id.deepseek', '22222222-2222-4222-8222-222222222222');
  assert.equal(getOrCreateSessionId('deepseek', 'alice'), '22222222-2222-4222-8222-222222222222');
  assert.equal(store.has('zeroclaw_session_id.deepseek'), false);
  assert.equal(getOrCreateSessionId('deepseek', 'bob'), getOrCreateSessionId('deepseek', 'bob'));
  assert.notEqual(getOrCreateSessionId('deepseek', 'bob'), '22222222-2222-4222-8222-222222222222');
});

test('generateUUID is RFC 4122 version 4', () => {
  assert.match(generateUUID(), UUID_RE);
});

test('releaseWebSocket does not close() while CONNECTING', () => {
  let closed = 0;
  const socket = {
    readyState: 0,
    onopen: null as ((ev?: Event) => void) | null,
    onclose: () => {},
    onerror: () => {},
    onmessage: () => {},
    close() {
      closed += 1;
    },
  };
  releaseWebSocket(socket as unknown as WebSocket);
  assert.equal(closed, 0);
  socket.onopen?.();
  assert.equal(closed, 1);
});

test('releaseWebSocket closes an OPEN socket immediately', () => {
  let closed = 0;
  const socket = {
    readyState: 1,
    onopen: () => {},
    onclose: () => {},
    onerror: () => {},
    onmessage: () => {},
    close() {
      closed += 1;
    },
  };
  releaseWebSocket(socket as unknown as WebSocket);
  assert.equal(closed, 1);
  assert.equal(socket.onopen, null);
});
