import assert from 'node:assert/strict';
import test from 'node:test';

import { isWorkbenchPath, shouldSkipPairing } from './skipPairing.ts';

test('isWorkbenchPath accepts prefixed and unprefixed workbench URLs', () => {
  assert.equal(isWorkbenchPath('/workbench'), true);
  assert.equal(isWorkbenchPath('/workbench/deepseek'), true);
  assert.equal(isWorkbenchPath('/hbcdcagent/workbench'), true);
  assert.equal(isWorkbenchPath('/hbcdcagent/workbench/deepseek'), true);
  assert.equal(isWorkbenchPath('/dashboard'), false);
  assert.equal(isWorkbenchPath('/hbcdcagent/dashboard'), false);
  assert.equal(isWorkbenchPath('/hbcdcagent/pairing'), false);
});

test('shouldSkipPairing skips Vite, workbench, and BFF-injected users', () => {
  assert.equal(shouldSkipPairing({ dev: true, pathname: '/dashboard' }), true);
  assert.equal(shouldSkipPairing({ pathname: '/hbcdcagent/workbench' }), true);
  assert.equal(
    shouldSkipPairing({
      pathname: '/hbcdcagent/dashboard',
      platformUser: { userId: 'chenmin', displayName: '陈敏', role: '普通用户' },
    }),
    true,
  );
  assert.equal(shouldSkipPairing({ pathname: '/dashboard' }), false);
  assert.equal(
    shouldSkipPairing({
      pathname: '/dashboard',
      platformUser: { userId: 'chenmin' },
    }),
    false,
  );
});
