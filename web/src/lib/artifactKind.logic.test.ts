import assert from 'node:assert/strict';
import test from 'node:test';

import {
  artifactKind,
  isVisualArtifact,
  parseToolArtifact,
  sortArtifactEntries,
  workspaceBrowsePath,
} from './artifactKind.ts';

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

test('artifactKind treats every svg mime as non-preview even with a png name', () => {
  assert.equal(artifactKind('image/svg', 'chart.png'), 'other');
  assert.equal(artifactKind('IMAGE/SVG+XML', 'chart.png'), 'other');
  assert.equal(artifactKind('text/html; charset=utf-8', 'x'), 'html');
  assert.equal(artifactKind('', 'page.HTM'), 'html');
  assert.equal(artifactKind('', 'shot.jpeg'), 'image');
  assert.equal(artifactKind('', 'shot.webp'), 'image');
  assert.equal(artifactKind('application/vnd.ms-excel', 'a.csv'), 'office');
  assert.equal(artifactKind('', 'deck.ppt'), 'office');
  assert.equal(artifactKind('', 'deck.pptx'), 'office');
});

test('parseToolArtifact fills filename from path and drops windows paths', () => {
  assert.equal(parseToolArtifact({ path: 'C:\\Windows\\secret.png' }), undefined);
  const ok = parseToolArtifact({ path: 'sessions/s1/a.png', size: Number.NaN });
  assert.equal(ok?.filename, 'a.png');
  assert.equal(ok?.title, 'a.png');
  assert.equal(ok?.size, 0);
  assert.equal(parseToolArtifact({ path: '', filename: 'a.png' }), undefined);
  assert.equal(parseToolArtifact({ path: '  ', filename: 'a.png' }), undefined);
  assert.equal(isVisualArtifact({ path: 'a.htm', filename: 'a.htm', title: 'a', mime: '', size: 1 }), true);
});

test('workspaceBrowsePath keeps session paths and lifts host session tails', () => {
  assert.equal(workspaceBrowsePath('sessions/s1/login.html'), 'sessions/s1/login.html');
  assert.equal(workspaceBrowsePath('login.html'), 'login.html');
  assert.equal(
    workspaceBrowsePath('/Users/sand/.zeroclaw/users/ops/agents/deepseek/workspace/sessions/s1/login.html'),
    'sessions/s1/login.html',
  );
  assert.equal(workspaceBrowsePath('/etc/passwd'), undefined);
  assert.equal(workspaceBrowsePath('sessions/../secret'), undefined);
});

test('parseToolArtifact accepts a host path that still ends under sessions/', () => {
  const ok = parseToolArtifact({
    path: '/Users/x/.zeroclaw/users/ops/agents/deepseek/workspace/sessions/s1/r.html',
    filename: 'r.html',
    mime: 'text/html',
    size: 4,
  });
  assert.equal(ok?.path, 'sessions/s1/r.html');
});

test('sortArtifactEntries puts html before scripts and folders', () => {
  const names = sortArtifactEntries([
    { kind: 'dir', name: 'scripts' },
    { kind: 'file', name: 'analyze.py' },
    { kind: 'file', name: '两热比对报告.html' },
    { kind: 'file', name: 'data.xlsx' },
    { kind: 'dir', name: 'uploads' },
  ]).map((e) => e.name);
  assert.deepEqual(names, ['两热比对报告.html', 'data.xlsx', 'analyze.py', 'scripts', 'uploads']);
});
