import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { canRollBack, filterPlazaSkills, installedSkillNames, installedSkillStamp, isPlazaInstalled, mineSkillUpdateAvailable, plazaCardAction, plazaUpdateAvailable, publishFailureKey, releaseNoteText, type PlazaSkillView } from './skillPlaza.ts';

const rows: PlazaSkillView[] = [
  {
    id: 'flu-trend',
    title: '流感趋势解读',
    description: '结合流感样病例和病原监测',
    body: '# 流感趋势解读',
  },
  {
    id: 'syndrome-ili-alert',
    title: 'ILI识别和预警',
    description: '用门诊 ILI% 判断是否触发预警',
    body: '# ILI',
  },
];

test('filterPlazaSkills matches title and description', () => {
  assert.ok(filterPlazaSkills(rows, '流感').some((row) => row.id === 'flu-trend'));
  assert.ok(filterPlazaSkills(rows, 'ILI').some((row) => row.id === 'syndrome-ili-alert'));
  assert.equal(filterPlazaSkills(rows, 'zzz-no-such').length, 0);
  assert.equal(filterPlazaSkills(rows, '  ').length, rows.length);
});

test('isPlazaInstalled uses the catalog id as the personal skill name', () => {
  const installed = installedSkillNames([{ name: 'flu-trend' }, { name: 'other' }]);
  assert.equal(isPlazaInstalled('flu-trend', installed), true);
  assert.equal(isPlazaInstalled('infectious-weekly', installed), false);
});

test('plaza cards only add or show added', () => {
  assert.equal(plazaCardAction(true), 'added');
  assert.equal(plazaCardAction(false), 'add');
});

test('installed stamp keeps the date only when the versions match', () => {
  assert.deepEqual(installedSkillStamp({ installedVersion: '2', plazaVersion: '2', publishedAt: '2026-09-26 08:38' }), {
    version: '2',
    publishedAt: '2026-09-26 08:38',
  });
  assert.deepEqual(installedSkillStamp({ installedVersion: '1', plazaVersion: '2', publishedAt: '2026-09-26 08:38' }), {
    version: '1',
    publishedAt: '',
  });
  assert.deepEqual(installedSkillStamp({ installedVersion: '2' }), { version: '2', publishedAt: '' });
});

test('my skills offers an update only for a plaza copy on a different version', () => {
  assert.equal(mineSkillUpdateAvailable({ fromPlaza: true, plazaVersion: '2', installedVersion: '1' }), true);
  assert.equal(mineSkillUpdateAvailable({ fromPlaza: true, plazaVersion: '2', installedVersion: '2' }), false);
  assert.equal(mineSkillUpdateAvailable({ fromPlaza: false, plazaVersion: '2', installedVersion: '1' }), false);
  assert.equal(mineSkillUpdateAvailable({ fromPlaza: true, plazaVersion: '', installedVersion: '1' }), false);
});

test('plazaUpdateAvailable only when the installed version differs', () => {
  assert.equal(plazaUpdateAvailable('2', '1', true), true);
  assert.equal(plazaUpdateAvailable('1', '1', true), false);
  assert.equal(plazaUpdateAvailable('', '1', true), false);
  assert.equal(plazaUpdateAvailable('2', '1', false), false);
});

test('a change note is the sentence on its own', () => {
  assert.equal(releaseNoteText('加了一种口径'), '加了一种口径');
  assert.equal(releaseNoteText('  '), '');
});

test('publish failures map onto the reason the admin can fix', () => {
  assert.equal(publishFailureKey('API 400: {"error":"description must say when to use this skill"}'), 'workbench.skill_center_need_description');
  assert.equal(publishFailureKey('a one-line change note is required'), 'workbench.skill_center_need_note');
  assert.equal(publishFailureKey('skill package looks like it contains a secret: SKILL.md'), 'workbench.skill_center_secret');
  assert.equal(publishFailureKey('scripts/run.sh: script-like files are blocked by skill security policy.'), 'workbench.skill_center_script');
  assert.equal(publishFailureKey('something else'), null);
});

test('rollback is offered only on the latest plaza copy', () => {
  assert.equal(canRollBack({ fromPlaza: true, installedVersion: '2', plazaVersion: '2', previousVersion: 1 }), true);
  assert.equal(canRollBack({ fromPlaza: true, installedVersion: '1', plazaVersion: '2', previousVersion: 1 }), false);
  assert.equal(canRollBack({ fromPlaza: false, installedVersion: '2', plazaVersion: '2', previousVersion: 1 }), false);
  assert.equal(canRollBack({ fromPlaza: true, installedVersion: '2', plazaVersion: '2' }), false);
});

test('shipped plaza skills are SKILL.md directories', () => {
  const root = path.resolve(import.meta.dirname, '../../../deploy/hbcdcagent/skill-plaza');
  const ids = fs.readdirSync(root).filter((name) => fs.existsSync(path.join(root, name, 'SKILL.md')));
  for (const id of ['sk0013', 'sk0021', 'sk0019', 'sk0001']) {
    assert.ok(ids.includes(id), id);
  }
  const md = fs.readFileSync(path.join(root, 'sk0013', 'SKILL.md'), 'utf8');
  assert.match(md, /^---\nname: /);
  assert.match(md, /\ndescription: \S+/);
});
