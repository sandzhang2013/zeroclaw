import assert from 'node:assert/strict';
import test from 'node:test';

import {
  composeUploadMessage,
  cwdRelativeUploadPath,
  displayUploadMessage,
  isVisionImage,
  safeUploadFileName,
  sessionUploadWorkspacePath,
  uniqueUploadFileName,
} from './chatUpload.ts';

test('safeUploadFileName strips paths and keeps CJK', () => {
  assert.equal(safeUploadFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeUploadFileName('报告 2026.csv'), '报告_2026.csv');
});

test('uniqueUploadFileName suffixes collisions', () => {
  assert.equal(uniqueUploadFileName(['a.csv'], 'a.csv'), 'a-2.csv');
  assert.equal(uniqueUploadFileName(['a.csv', 'a-2.csv'], 'a.csv'), 'a-3.csv');
});

test('session and cwd paths stay relative', () => {
  assert.equal(
    sessionUploadWorkspacePath('s1', 'foo.csv'),
    'sessions/s1/uploads/foo.csv',
  );
  assert.equal(cwdRelativeUploadPath('foo.csv'), 'uploads/foo.csv');
});

test('composeUploadMessage lists filenames and keeps path markers', () => {
  const msg = composeUploadMessage('看这个', [
    { cwdRel: 'uploads/a.csv', filename: 'a.csv', mime: 'text/csv' },
    { cwdRel: 'uploads/p.png', filename: 'p.png', mime: 'image/png' },
  ]);
  assert.match(msg, /^看这个/);
  assert.match(msg, /^a\.csv$/m);
  assert.match(msg, /\[FILE:uploads\/a\.csv\]/);
  assert.match(msg, /\[IMAGE:uploads\/p\.png\]/);
  assert.equal(msg.includes('Attached files'), false);
});

test('displayUploadMessage shows filenames only', () => {
  const sent = composeUploadMessage('分析', [
    { cwdRel: 'uploads/6-1985湖北-横转名单.xlsx', filename: '6-1985湖北-横转名单.xlsx', mime: '' },
  ]);
  assert.equal(displayUploadMessage(sent), '分析\n\n6-1985湖北-横转名单.xlsx');
  assert.equal(
    displayUploadMessage(
      '分析\n\nAttached files (paths are relative to the current session workspace):\n- uploads/6-1985湖北-横转名单.xlsx',
    ),
    '分析\n\n6-1985湖北-横转名单.xlsx',
  );
});

test('isVisionImage rejects svg', () => {
  assert.equal(isVisionImage('image/svg+xml', 'a.svg'), false);
  assert.equal(isVisionImage('image/png', 'a.png'), true);
});
