import assert from 'node:assert/strict';
import test from 'node:test';

import { artifactKind, isVisualArtifact, parseToolArtifact } from './artifactKind.ts';

test('artifactKind maps html image pdf office', () => {
  assert.equal(artifactKind('text/html', 'login.html'), 'html');
  assert.equal(artifactKind('', 'chart.PNG'), 'image');
  assert.equal(artifactKind('image/svg+xml', 'chart.svg'), 'other');
  assert.equal(artifactKind('', 'icon.svg'), 'other');
  assert.equal(artifactKind('application/pdf', 'a.pdf'), 'pdf');
  assert.equal(artifactKind('', 'report.docx'), 'office');
  assert.equal(artifactKind('', 'notes.txt'), 'other');
});

test('isVisualArtifact is html image pdf only', () => {
  assert.equal(isVisualArtifact({ path: 'a.html', filename: 'a.html', title: 'a', mime: '', size: 1 }), true);
  assert.equal(isVisualArtifact({ path: 'a.png', filename: 'a.png', title: 'a', mime: '', size: 1 }), true);
  assert.equal(isVisualArtifact({ path: 'a.svg', filename: 'a.svg', title: 'a', mime: 'image/svg+xml', size: 1 }), false);
  assert.equal(isVisualArtifact({ path: 'a.pdf', filename: 'a.pdf', title: 'a', mime: '', size: 1 }), true);
  assert.equal(isVisualArtifact({ path: 'a.docx', filename: 'a.docx', title: 'a', mime: '', size: 1 }), false);
  assert.equal(isVisualArtifact(undefined), false);
});

test('parseToolArtifact rejects host paths and traversal', () => {
  assert.equal(parseToolArtifact(null), undefined);
  assert.equal(parseToolArtifact({ path: '/etc/passwd', filename: 'passwd' }), undefined);
  assert.equal(parseToolArtifact({ path: 'sessions/../secret', filename: 'secret' }), undefined);
  const ok = parseToolArtifact({
    path: 'sessions/s1/login.html',
    filename: 'login.html',
    title: '登录页',
    mime: 'text/html',
    size: 94,
  });
  assert.equal(ok?.path, 'sessions/s1/login.html');
  assert.equal(ok?.title, '登录页');
});
