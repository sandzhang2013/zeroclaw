import assert from 'node:assert/strict';
import test from 'node:test';

import {
  filterPersonalSkills,
  isIssuedSkillId,
  isPersonalSkillId,
  isPersonalSkillEnabled,
  skillIdTakenKey,
  skillSlug,
} from './personalSkill.ts';

test('skillSlug strips paths and empty input', () => {
  assert.equal(skillSlug('流感周报'), '流感周报');
  assert.equal(skillSlug('  weekly flu  '), 'weekly-flu');
  assert.equal(skillSlug('a/b\\c'), 'a-b-c');
  assert.equal(skillSlug('../escape'), 'escape');
  assert.equal(skillSlug('   '), 'my-skill');
});

test('issued and personal skill ids stay distinct', () => {
  assert.equal(isIssuedSkillId('sk0009'), true);
  assert.equal(isIssuedSkillId('sk10000'), true);
  assert.equal(isIssuedSkillId('sk-flu-trend'), false);
  assert.equal(isPersonalSkillId('ps0001'), true);
  assert.equal(isPersonalSkillId('ps10000'), true);
  assert.equal(isPersonalSkillId('sk0001'), false);
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

test('skillIdTakenKey maps duplicate skill ids', () => {
  assert.equal(
    skillIdTakenKey('API 409: {"error":"you already have this skill id"}'),
    'workbench.skill_id_taken_self',
  );
  assert.equal(
    skillIdTakenKey('API 409: {"error":"skill id is already used"}'),
    'workbench.skill_id_taken',
  );
  assert.equal(skillIdTakenKey('API 500: {"error":"Failed to write SKILL.md"}'), null);
});
