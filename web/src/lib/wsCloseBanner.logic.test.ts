import assert from 'node:assert/strict';
import test from 'node:test';

import { isNormalWsClose, wsDropBanner } from './wsCloseBanner.ts';

const t = (key: string) => key;

test('normal close codes stay silent', () => {
  assert.equal(isNormalWsClose(1000), true);
  assert.equal(isNormalWsClose(1001), true);
  assert.equal(wsDropBanner(1000, 'reconnect', t), '');
  assert.equal(wsDropBanner(1001, 'failed', t), '');
});

test('abnormal close uses reconnect copy first', () => {
  assert.equal(isNormalWsClose(1006), false);
  assert.equal(wsDropBanner(1006, 'reconnect', t), 'agent.connection_error');
});

test('abnormal close escalates after reconnect gives up', () => {
  assert.equal(wsDropBanner(1006, 'failed', t), 'agent.reconnect_failed');
});
