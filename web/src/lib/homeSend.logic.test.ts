import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canSubmitHomeMessage,
  composeHomeMessage,
  homeSessionTitle,
  nextStoredSessionTitle,
  parseHomeSkillDisplay,
  recoverHomeSkill,
  titleFromUserMessage,
} from './homeSend.ts';

const weekly = {
  label: '监测周报',
  kind: 'outline',
  prompts: [{ text: '帮我起草本周传染病监测周报提纲。' }],
};

test('composeHomeMessage without a skill is the typed text', () => {
  assert.equal(composeHomeMessage({ userText: '  湖北的23周  ' }), '湖北的23周');
});

test('composeHomeMessage names the skill and keeps the user constraint', () => {
  const text = composeHomeMessage({ userText: '湖北的23周', skill: weekly });
  assert.match(text, /请使用技能「监测周报」/);
  assert.match(text, /先给出可修改的提纲/);
  assert.match(text, /帮我起草本周传染病监测周报提纲。/);
  assert.match(text, /补充要求：湖北的23周/);
});

test('composeHomeMessage does not duplicate a prompt the user already picked', () => {
  const picked = '帮我起草本周传染病监测周报提纲。\n湖北的23周';
  const text = composeHomeMessage({ userText: picked, skill: weekly });
  assert.equal(text.split('帮我起草本周传染病监测周报提纲。').length - 1, 1);
  assert.match(text, /请使用技能「监测周报」/);
  assert.match(text, /湖北的23周/);
});

test('composeHomeMessage still names a skill with no prompts', () => {
  const text = composeHomeMessage({
    userText: '湖北的23周',
    skill: { label: '监测周报', prompts: [] },
  });
  assert.match(text, /请使用技能「监测周报」/);
  assert.match(text, /补充要求：湖北的23周/);
});

test('canSubmitHomeMessage allows a selected skill with empty input', () => {
  assert.equal(canSubmitHomeMessage({ userText: '', hasAttachments: false, skill: weekly }), true);
  assert.equal(canSubmitHomeMessage({ userText: '', hasAttachments: false }), false);
  assert.equal(canSubmitHomeMessage({ userText: '', hasAttachments: true }), true);
});

test('homeSessionTitle prefers the typed line over the skill wrapper', () => {
  assert.equal(homeSessionTitle({ userText: '湖北的23周', skillLabel: '监测周报' }), '湖北的23周');
  assert.equal(homeSessionTitle({ userText: '  ', skillLabel: '监测周报' }), '监测周报');
});

test('parseHomeSkillDisplay shows the skill tag and the typed constraint', () => {
  const model = composeHomeMessage({ userText: '湖北的23周', skill: weekly });
  assert.deepEqual(parseHomeSkillDisplay(model), {
    skillLabel: '监测周报',
    visible: '湖北的23周',
  });
});

test('parseHomeSkillDisplay keeps a picked prompt as the visible text', () => {
  const model = composeHomeMessage({
    userText: '帮我起草本周传染病监测周报提纲。',
    skill: weekly,
  });
  assert.deepEqual(parseHomeSkillDisplay(model), {
    skillLabel: '监测周报',
    visible: '帮我起草本周传染病监测周报提纲。',
  });
});

test('parseHomeSkillDisplay leaves ordinary chat unchanged', () => {
  assert.deepEqual(parseHomeSkillDisplay('湖北的23周'), { visible: '湖北的23周' });
});

test('parseHomeSkillDisplay still shows the skill tag after a stored runtime date prefix', () => {
  const model = composeHomeMessage({ userText: '湖北的23周', skill: weekly });
  const stored = `[CURRENT DATE & TIME: 2026-09-09 20:06:50 +08:00]\n\n${model}`;
  assert.deepEqual(parseHomeSkillDisplay(stored), {
    skillLabel: '监测周报',
    visible: '湖北的23周',
  });
  assert.deepEqual(recoverHomeSkill(stored), {
    id: '监测周报',
    label: '监测周报',
    kind: 'outline',
  });
});

test('composeHomeMessage follow-up keeps the skill tag without repeating the prompt', () => {
  const text = composeHomeMessage({
    userText: '加上发病数表',
    skill: weekly,
    includePrompt: false,
  });
  assert.match(text, /请使用技能「监测周报」/);
  assert.doesNotMatch(text, /帮我起草本周传染病监测周报提纲/);
  assert.equal(parseHomeSkillDisplay(text).visible, '加上发病数表');
  assert.equal(parseHomeSkillDisplay(text).skillLabel, '监测周报');
});

test('compose and parse keep English skill tags as tag plus user text', () => {
  const skill = {
    label: 'Weekly report',
    kind: 'outline',
    prompts: [{ text: 'Draft an outline for this week’s infectious-disease surveillance report.' }],
  };
  const model = composeHomeMessage({ userText: 'Hubei week 23', skill, locale: 'en' });
  assert.match(model, /Use the skill "Weekly report"/);
  assert.match(model, /Additional request: Hubei week 23/);
  assert.deepEqual(parseHomeSkillDisplay(model), {
    skillLabel: 'Weekly report',
    visible: 'Hubei week 23',
  });
  assert.equal(recoverHomeSkill(model)?.kind, 'outline');
});

test('a skill-only first send still renders as a tag with the catalog prompt', () => {
  const model = composeHomeMessage({ userText: '', skill: weekly });
  assert.deepEqual(parseHomeSkillDisplay(model), {
    skillLabel: '监测周报',
    visible: '帮我起草本周传染病监测周报提纲。',
  });
});

test('reopening a stored turn is still tag plus user text, not the skill wrapper', () => {
  const first = composeHomeMessage({ userText: '湖北的23周', skill: weekly });
  const stored = `[2026-09-09 20:06:50 +08:00]\n[CURRENT DATE & TIME: 2026-09-09 20:06:50 +08:00]\n\n${first}`;
  assert.deepEqual(parseHomeSkillDisplay(stored), {
    skillLabel: '监测周报',
    visible: '湖北的23周',
  });
  const follow = composeHomeMessage({
    userText: '补一张发病数表',
    skill: recoverHomeSkill(stored),
    includePrompt: false,
  });
  assert.deepEqual(parseHomeSkillDisplay(follow), {
    skillLabel: '监测周报',
    visible: '补一张发病数表',
  });
});

test('parseHomeSkillDisplay strips a date prefix from ordinary chat', () => {
  assert.deepEqual(
    parseHomeSkillDisplay('[CURRENT DATE & TIME: 2026-09-09 20:06:50 +08:00]\n\n湖北的23周'),
    { visible: '湖北的23周' },
  );
});

test('follow-up with empty text still names the skill for the model', () => {
  const text = composeHomeMessage({ userText: '', skill: weekly, includePrompt: false });
  assert.equal(text, '请使用技能「监测周报」完成下面的任务。先给出可修改的提纲，确认后再写正文。');
  assert.deepEqual(parseHomeSkillDisplay(text), {
    skillLabel: '监测周报',
    visible: '',
  });
});

test('titleFromUserMessage uses visible text after a date prefix and skill wrapper', () => {
  const model = composeHomeMessage({ userText: '全面测试周23', skill: weekly });
  const stored = `[CURRENT DATE & TIME: 2026-09-09 20:06:50 +08:00]\n\n${model}`;
  assert.equal(titleFromUserMessage(stored), '全面测试周23');
  assert.equal(
    titleFromUserMessage('[CURRENT DATE & TIME: 2026-09-09 20:06:50 +08:00]\n\n'),
    '',
  );
  assert.equal(
    titleFromUserMessage('[CURRENT DATE & TIME: 2026-09-09 20:06:50 +08:00]\n\n', '监测周报'),
    '监测周报',
  );
});

test('nextStoredSessionTitle does not fall back to a hex task id', () => {
  const wrapper = '请使用技能「监测周报」完成下面的任务。先给出可修改的提纲，确认后再写正文。';
  assert.equal(
    nextStoredSessionTitle({ stored: '全面测试周23', preview: wrapper }),
    '全面测试周23',
  );
  assert.equal(
    nextStoredSessionTitle({
      stored: '[CURRENT DATE & TIME: 2026-09-09 20:06:50 +08:00]',
      preview: '全面测试周23',
    }),
    '全面测试周23',
  );
  assert.equal(
    nextStoredSessionTitle({ stored: wrapper, preview: '全面测试周23' }),
    '全面测试周23',
  );
  assert.equal(
    nextStoredSessionTitle({
      stored: '',
      preview: '',
      skillLabel: '监测周报',
    }),
    '监测周报',
  );
  assert.equal(nextStoredSessionTitle({ stored: '', preview: '' }), undefined);
});

test('recoverHomeSkill leaves ordinary chat and mid-message dates alone', () => {
  assert.equal(recoverHomeSkill('湖北的23周'), undefined);
  assert.equal(
    recoverHomeSkill('解释一下 [CURRENT DATE & TIME: 2026-09-09 20:06:50 +08:00] 是什么'),
    undefined,
  );
  assert.equal(
    recoverHomeSkill(composeHomeMessage({
      userText: '对比近两周',
      skill: { label: '疫情概况', kind: 'chat', prompts: [{ text: '帮我概述近期疫情。' }] },
    }))?.kind,
    'chat',
  );
});
