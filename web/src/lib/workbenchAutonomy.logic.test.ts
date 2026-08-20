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
  loadWorkbenchAutonomy,
  saveWorkbenchAutonomy,
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

test('clampWorkbenchAutonomy never raises and keeps equal levels', () => {
  const levels = ['readonly', 'supervised', 'full'] as const;
  for (const level of levels) {
    for (const max of levels) {
      const clamped = clampWorkbenchAutonomy(level, max);
      const rank = { readonly: 0, supervised: 1, full: 2 };
      assert.ok(rank[clamped] <= rank[max], `${level} vs ${max} -> ${clamped}`);
      if (rank[level] <= rank[max]) assert.equal(clamped, level);
    }
  }
});

test('unknown roles follow the ordinary-user cap; advanced aliases do not', () => {
  assert.equal(maxAutonomyForRole('admin'), 'supervised');
  assert.equal(maxAutonomyForRole('user'), 'supervised');
  assert.equal(maxAutonomyForRole('advanced'), 'full');
  assert.equal(maxAutonomyForRole('运维'), 'full');
  assert.deepEqual(autonomyLevelsUpTo('readonly'), ['readonly']);
  assert.deepEqual(autonomyLevelsUpTo('full'), ['readonly', 'supervised', 'full']);
});

test('autonomyStorageKey keeps colon scopes and load/save round-trip', () => {
  assert.match(autonomyStorageKey('deepseek:abc-1'), /deepseek:abc-1$/);
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    },
    configurable: true,
  });
  saveWorkbenchAutonomy('s1', 'readonly');
  assert.equal(loadWorkbenchAutonomy('s1'), 'readonly');
  assert.equal(loadWorkbenchAutonomy('missing'), DEFAULT_WORKBENCH_AUTONOMY);
  assert.equal(parseWorkbenchAutonomy(null), DEFAULT_WORKBENCH_AUTONOMY);
  assert.equal(parseWorkbenchAutonomy(1), DEFAULT_WORKBENCH_AUTONOMY);
});
