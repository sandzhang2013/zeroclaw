import assert from 'node:assert/strict';
import test from 'node:test';

import {
  draftPersonalSkill,
  filterPersonalSkills,
  isPersonalSkillEnabled,
  shouldShowSaveSkillButton,
  skillSlug,
  skillTitleFromAsk,
} from './personalSkill.ts';

test('skillSlug strips paths and empty input', () => {
  assert.equal(skillSlug('流感周报'), '流感周报');
  assert.equal(skillSlug('  weekly flu  '), 'weekly-flu');
  assert.equal(skillSlug('a/b\\c'), 'a-b-c');
  assert.equal(skillSlug('../escape'), 'escape');
  assert.equal(skillSlug('   '), 'my-skill');
});

test('skillTitleFromAsk uses the first line', () => {
  assert.equal(skillTitleFromAsk('按近8周做武汉流感图\n附带CSV'), '按近8周做武汉流感图');
  assert.equal(skillTitleFromAsk('   '), '我的技能');
});

test('draftPersonalSkill keeps ask and reply in the body', () => {
  const draft = draftPersonalSkill({
    userText: '预测下周武汉流感',
    assistantText: '先查监测再出图。',
  });
  assert.equal(draft.name, '预测下周武汉流感');
  assert.match(draft.description, /武汉流感/);
  assert.match(draft.body, /预测下周武汉流感/);
  assert.match(draft.body, /先查监测再出图/);
});

test('filterPersonalSkills matches name title and description', () => {
  const rows = [
    { name: 'flu-weekly', title: '流感周报', description: '近8周趋势' },
    { name: 'intro', title: '自我介绍', description: '一句话' },
  ];
  assert.equal(filterPersonalSkills(rows, '流感').length, 1);
  assert.equal(filterPersonalSkills(rows, 'intro')[0]?.name, 'intro');
  assert.equal(filterPersonalSkills(rows, '  ').length, 2);
});

test('isPersonalSkillEnabled defaults to on', () => {
  assert.equal(isPersonalSkillEnabled({}), true);
  assert.equal(isPersonalSkillEnabled({ enabled: true }), true);
  assert.equal(isPersonalSkillEnabled({ enabled: false }), false);
});

test('shouldShowSaveSkillButton only on finished assistant prose', () => {
  assert.equal(
    shouldShowSaveSkillButton({
      isAssistant: true,
      streaming: false,
      hasProse: true,
      content: 'done',
    }),
    true,
  );
  assert.equal(
    shouldShowSaveSkillButton({
      isAssistant: true,
      streaming: true,
      hasProse: true,
      content: 'partial',
    }),
    false,
  );
  assert.equal(
    shouldShowSaveSkillButton({
      isAssistant: false,
      streaming: false,
      hasProse: true,
      content: 'ask',
    }),
    false,
  );
  assert.equal(
    shouldShowSaveSkillButton({
      isAssistant: true,
      streaming: false,
      hasProse: true,
      content: '[错误] credentials',
      isError: true,
    }),
    false,
  );
});
