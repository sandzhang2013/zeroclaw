import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { filterPlazaSkills, installedSkillNames, isPlazaInstalled, plazaCardAction, plazaUpdateAvailable, type PlazaSkillView } from './skillPlaza.ts';

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

test('own working copy stays added even when the plaza version differs', () => {
  assert.equal(plazaCardAction({ installed: true, ownCopy: true, plazaVersion: '2', installedVersion: '' }), 'added');
  assert.equal(plazaCardAction({ installed: true, ownCopy: false, plazaVersion: '2', installedVersion: '1' }), 'update');
  assert.equal(plazaCardAction({ installed: false, ownCopy: false, plazaVersion: '1' }), 'add');
});

test('plazaUpdateAvailable only when the installed version differs', () => {
  assert.equal(plazaUpdateAvailable('2', '1', true), true);
  assert.equal(plazaUpdateAvailable('1', '1', true), false);
  assert.equal(plazaUpdateAvailable('', '1', true), false);
  assert.equal(plazaUpdateAvailable('2', '1', false), false);
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
