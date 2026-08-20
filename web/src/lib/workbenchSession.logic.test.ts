import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_SESSION_TITLE_LENGTH,
  sanitizeSessionTitle,
  sessionDisplayTitle,
} from './workbenchSession.ts';

test('sanitizeSessionTitle trims, collapses space, and rejects empty', () => {
  assert.equal(sanitizeSessionTitle('  湖北疫情  '), '湖北疫情');
  assert.equal(sanitizeSessionTitle('a \n b'), 'a b');
  assert.equal(sanitizeSessionTitle('   '), null);
  assert.equal(sanitizeSessionTitle(''), null);
  assert.equal(sanitizeSessionTitle(undefined), null);
  assert.equal(sanitizeSessionTitle(1), null);
});

test('sanitizeSessionTitle drops controls and caps length', () => {
  assert.equal(sanitizeSessionTitle('ok\u0000name'), 'okname');
  const long = '汉'.repeat(MAX_SESSION_TITLE_LENGTH + 8);
  const out = sanitizeSessionTitle(long);
  assert.equal(out?.length, MAX_SESSION_TITLE_LENGTH);
});

test('sessionDisplayTitle prefers title then default then task id', () => {
  assert.equal(
    sessionDisplayTitle({ title: '周报', taskId: 'abc12345' }, '新会话'),
    '周报',
  );
  assert.equal(
    sessionDisplayTitle({ taskId: '__default__' }, '新会话'),
    '新会话',
  );
  assert.equal(
    sessionDisplayTitle({ title: '  ', taskId: 'abc12345' }, '新会话'),
    'abc12345',
  );
});
