import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FOLDER_NAV_STORAGE_KEY,
  defaultFolderNav,
  folderNavStorageKey,
  isFolderExpanded,
  parseFolderNav,
} from './workbenchFolderNav.ts';

test('parseFolderNav falls back on empty or junk', () => {
  assert.deepEqual(parseFolderNav(null), defaultFolderNav());
  assert.deepEqual(parseFolderNav(''), defaultFolderNav());
  assert.deepEqual(parseFolderNav('{'), defaultFolderNav());
  assert.deepEqual(parseFolderNav('[]'), defaultFolderNav());
  assert.deepEqual(parseFolderNav('1'), defaultFolderNav());
});

test('parseFolderNav keeps collapsed folders across reload JSON', () => {
  const nav = parseFolderNav(JSON.stringify({
    projectsOpen: false,
    tasksOpen: true,
    folderOpen: { 'f-week': false, 'f-open': true },
  }));
  assert.equal(nav.projectsOpen, false);
  assert.equal(nav.tasksOpen, true);
  assert.equal(isFolderExpanded(nav.folderOpen, 'f-week'), false);
  assert.equal(isFolderExpanded(nav.folderOpen, 'f-open'), true);
  assert.equal(isFolderExpanded(nav.folderOpen, 'never-seen'), true);
});

test('parseFolderNav ignores non-boolean folder entries', () => {
  const nav = parseFolderNav(JSON.stringify({
    projectsOpen: 'no',
    folderOpen: { ok: false, bad: 'nope', '': false },
  }));
  assert.equal(nav.projectsOpen, true);
  assert.deepEqual(nav.folderOpen, { ok: false });
});

test('folderNavStorageKey scopes by user', () => {
  assert.equal(folderNavStorageKey(), FOLDER_NAV_STORAGE_KEY);
  assert.equal(folderNavStorageKey('ops'), `${FOLDER_NAV_STORAGE_KEY}:ops`);
});
