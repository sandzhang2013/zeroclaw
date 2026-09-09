import assert from 'node:assert/strict';
import test from 'node:test';

import { composeHomeMessage } from './homeSend.ts';
import {
  clearSessionHomeSkill,
  inferHomeSkillFromMessages,
  resolveActiveHomeSkill,
  restoreSessionHomeSkill,
  shouldRestoreHomeSkill,
} from './homeSessionSkill.ts';

const weekly = {
  id: 'weekly',
  label: '监测周报',
  kind: 'outline',
  prompts: [{ text: '帮我起草本周传染病监测周报提纲。' }],
};

function storedTurn(userText: string): string {
  const model = composeHomeMessage({ userText, skill: weekly });
  return `[CURRENT DATE & TIME: 2026-09-09 20:06:50 +08:00]\n\n${model}`;
}

test('inferHomeSkillFromMessages skips notices and recovers the first user skill turn', () => {
  assert.equal(inferHomeSkillFromMessages([
    { role: 'user', content: '系统提示', notice: true },
    { role: 'agent', content: storedTurn('湖北的23周') },
    { role: 'user', content: storedTurn('湖北的23周') },
  ])?.label, '监测周报');
  assert.equal(inferHomeSkillFromMessages([
    { role: 'user', content: '湖北的23周' },
  ]), undefined);
});

test('resolveActiveHomeSkill prefers the live session tag until the user dismisses it', () => {
  const session = { id: 'weekly', label: '监测周报', kind: 'outline' as const };
  const inferred = { id: 'inferred', label: '工作简报', kind: 'outline' as const };
  assert.deepEqual(resolveActiveHomeSkill({ sessionSkill: session, inferredSkill: inferred, dismissed: false }), session);
  assert.deepEqual(resolveActiveHomeSkill({ inferredSkill: inferred, dismissed: false }), inferred);
  assert.equal(resolveActiveHomeSkill({ sessionSkill: session, inferredSkill: inferred, dismissed: true }), undefined);
});

test('shouldRestoreHomeSkill writes back only a missing undismissed tag', () => {
  const inferred = { id: '监测周报', label: '监测周报', kind: 'outline' as const };
  assert.deepEqual(shouldRestoreHomeSkill({ dismissed: false, inferredSkill: inferred }), inferred);
  assert.equal(shouldRestoreHomeSkill({ dismissed: false, sessionSkill: inferred, inferredSkill: inferred }), undefined);
  assert.equal(shouldRestoreHomeSkill({ dismissed: true, inferredSkill: inferred }), undefined);
});

test('clear and restore keep other sessions untouched', () => {
  const sessions = [
    { id: 'a', homeSkill: weekly },
    { id: 'b', title: '普通会话' },
  ];
  const cleared = clearSessionHomeSkill(sessions, 'a');
  assert.equal(cleared[0]?.homeSkill, undefined);
  assert.equal(sessions[0]?.homeSkill?.label, '监测周报');
  const restored = restoreSessionHomeSkill(cleared, 'a', { id: '监测周报', label: '监测周报' });
  assert.equal(restored[0]?.homeSkill?.label, '监测周报');
  assert.equal(restoreSessionHomeSkill(sessions, 'a', { id: 'x', label: '工作简报' })[0]?.homeSkill?.label, '监测周报');
});
