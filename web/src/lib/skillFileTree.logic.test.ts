import assert from 'node:assert/strict';
import test from 'node:test';

import { skillDirPaths, skillFileTree } from './skillFileTree.ts';

test('skillFileTree groups files under their directories', () => {
  const tree = skillFileTree([
    'scripts/compute.py',
    'SKILL.md',
    'references/usage.md',
    'scripts/build.py',
    'assets/example.json',
  ]);
  assert.deepEqual(
    tree.dirs.map((dir) => dir.name),
    ['assets', 'references', 'scripts'],
  );
  assert.deepEqual(
    tree.files.map((file) => file.name),
    ['SKILL.md'],
  );
  const scripts = tree.dirs.find((dir) => dir.name === 'scripts');
  assert.deepEqual(
    scripts?.files.map((file) => file.path),
    ['scripts/build.py', 'scripts/compute.py'],
  );
  assert.deepEqual(skillDirPaths(tree), ['assets', 'references', 'scripts']);
});
