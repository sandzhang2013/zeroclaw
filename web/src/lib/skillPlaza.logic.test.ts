import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PLAZA_SKILLS,
  filterPlazaSkills,
  installedSkillNames,
  isPlazaInstalled,
  resolvePlazaSkill,
  resolvePlazaSkills,
} from './skillPlaza.ts';

test('plaza catalog has unique ids and recommended skills', () => {
  const ids = PLAZA_SKILLS.map((skill) => skill.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.length >= 1);
  assert.ok(PLAZA_SKILLS.every((skill) => skill.category === 'recommended'));
});

test('resolvePlazaSkill follows locale', () => {
  const skill = PLAZA_SKILLS[0];
  assert.ok(skill);
  assert.equal(resolvePlazaSkill(skill, 'zh').title, skill.title_zh);
  assert.equal(resolvePlazaSkill(skill, 'en').title, skill.title_en);
});

test('resolvePlazaSkills can filter by category', () => {
  assert.equal(resolvePlazaSkills('zh').length, PLAZA_SKILLS.length);
  assert.equal(resolvePlazaSkills('zh', 'recommended').length, PLAZA_SKILLS.length);
});

test('filterPlazaSkills matches title and description', () => {
  const rows = resolvePlazaSkills('zh');
  assert.ok(filterPlazaSkills(rows, '流感').some((row) => row.id === 'flu-trend'));
  assert.equal(filterPlazaSkills(rows, 'zzz-no-such').length, 0);
  assert.equal(filterPlazaSkills(rows, '  ').length, rows.length);
});

test('isPlazaInstalled uses the catalog id as the personal skill name', () => {
  const installed = installedSkillNames([{ name: 'flu-trend' }, { name: 'other' }]);
  assert.equal(isPlazaInstalled('flu-trend', installed), true);
  assert.equal(isPlazaInstalled('infectious-weekly', installed), false);
});
