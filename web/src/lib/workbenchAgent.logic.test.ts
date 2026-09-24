import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveWorkbenchAgentAlias } from './workbenchAgent.ts';

test('keeps the URL alias when that agent is configured', () => {
  assert.equal(resolveWorkbenchAgentAlias('deepseek', ['default', 'deepseek']), 'deepseek');
});

test('falls back to default when the URL alias is missing', () => {
  assert.equal(resolveWorkbenchAgentAlias('deepseek', ['default']), 'default');
});

test('uses the first configured agent when default is absent', () => {
  assert.equal(resolveWorkbenchAgentAlias('deepseek', ['ops', 'web']), 'ops');
});

test('bare /workbench prefers default', () => {
  assert.equal(resolveWorkbenchAgentAlias(undefined, ['ops', 'default']), 'default');
  assert.equal(resolveWorkbenchAgentAlias('', ['ops']), 'ops');
});

test('unknown config still returns a usable alias', () => {
  assert.equal(resolveWorkbenchAgentAlias('deepseek', []), 'deepseek');
  assert.equal(resolveWorkbenchAgentAlias(undefined, []), 'default');
});
