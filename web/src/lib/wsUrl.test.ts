import assert from 'node:assert/strict';
import test from 'node:test';

import { sameOriginWebSocketUrl } from './wsUrl.ts';

test('sameOriginWebSocketUrl follows the page host, not a baked-in origin', () => {
  const url = sameOriginWebSocketUrl(
    '/hbcdcagent/ws/chat?agent=deepseek',
    'http://workbench.example:50001/hbcdcagent/workbench',
  );
  const parsed = new URL(url);
  assert.equal(parsed.protocol, 'ws:');
  assert.equal(parsed.host, 'workbench.example:50001');
  assert.equal(parsed.pathname, '/hbcdcagent/ws/chat');
  assert.equal(parsed.searchParams.get('agent'), 'deepseek');
});

test('sameOriginWebSocketUrl uses wss on https pages', () => {
  const url = sameOriginWebSocketUrl(
    '/hbcdcagent/ws/chat',
    'https://workbench.example/hbcdcagent/workbench/deepseek',
  );
  assert.equal(new URL(url).protocol, 'wss:');
  assert.equal(new URL(url).host, 'workbench.example');
});
