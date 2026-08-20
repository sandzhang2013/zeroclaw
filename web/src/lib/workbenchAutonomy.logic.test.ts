import assert from 'node:assert/strict';
import test from 'node:test';

import {
  autonomyLabelKey,
  autonomyStorageKey,
  DEFAULT_WORKBENCH_AUTONOMY,
  parseWorkbenchAutonomy,
  clampWorkbenchAutonomy,
  maxAutonomyForRole,
  autonomyLevelsUpTo,
} from './workbenchAutonomy.ts';

test('parseWorkbenchAutonomy accepts runtime wire values', () => {
  assert.equal(parseWorkbenchAutonomy('readonly'), 'readonly');
  assert.equal(parseWorkbenchAutonomy('supervised'), 'supervised');
  assert.equal(parseWorkbenchAutonomy('full'), 'full');
});

test('parseWorkbenchAutonomy falls back to supervised', () => {
  assert.equal(parseWorkbenchAutonomy(undefined), DEFAULT_WORKBENCH_AUTONOMY);
  assert.equal(parseWorkbenchAutonomy('yolo'), DEFAULT_WORKBENCH_AUTONOMY);
  assert.equal(parseWorkbenchAutonomy('read_only'), DEFAULT_WORKBENCH_AUTONOMY);
});

test('autonomyLabelKey maps each mode', () => {
  assert.equal(autonomyLabelKey('readonly'), 'workbench.mode_readonly');
  assert.equal(autonomyLabelKey('supervised'), 'workbench.mode_supervised');
  assert.equal(autonomyLabelKey('full'), 'workbench.mode_full');
});

test('autonomyStorageKey strips unsafe scope characters', () => {
  assert.equal(autonomyStorageKey('abc'), 'zeroclaw-workbench-autonomy:abc');
  assert.equal(
    autonomyStorageKey('../etc/passwd'),
    'zeroclaw-workbench-autonomy:.._etc_passwd',
  );
});

test('ordinary users cannot pick full; advanced and ops can', () => {
  assert.equal(maxAutonomyForRole('普通用户'), 'supervised');
  assert.equal(maxAutonomyForRole(undefined), 'full');
  assert.equal(maxAutonomyForRole(''), 'full');
  assert.equal(maxAutonomyForRole('高级用户'), 'full');
  assert.equal(maxAutonomyForRole('ops'), 'full');
  assert.equal(clampWorkbenchAutonomy('full', 'supervised'), 'supervised');
  assert.equal(clampWorkbenchAutonomy('readonly', 'supervised'), 'readonly');
  assert.deepEqual(autonomyLevelsUpTo('supervised'), ['readonly', 'supervised']);
});
