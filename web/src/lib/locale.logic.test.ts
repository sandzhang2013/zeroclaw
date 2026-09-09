import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveStoredLocale } from './locale.ts';

test('resolveStoredLocale keeps Chinese and English', () => {
  assert.equal(resolveStoredLocale('zh'), 'zh');
  assert.equal(resolveStoredLocale('en'), 'en');
});

test('resolveStoredLocale defaults anything else to Chinese', () => {
  assert.equal(resolveStoredLocale(null), 'zh');
  assert.equal(resolveStoredLocale(undefined), 'zh');
  assert.equal(resolveStoredLocale(''), 'zh');
  assert.equal(resolveStoredLocale('ja'), 'zh');
  assert.equal(resolveStoredLocale('zh-CN'), 'zh');
});
