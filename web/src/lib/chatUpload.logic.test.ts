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
  CHAT_UPLOAD_MAX_BYTES,
  CHAT_UPLOAD_MAX_FILES,
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
  assert.equal(isVisionImage('image/svg', 'a.png'), false);
  assert.equal(isVisionImage('', 'chart.SVG'), false);
  assert.equal(isVisionImage('image/png', 'a.png'), true);
});

test('safeUploadFileName and unique names cover hidden files and empty input', () => {
  assert.equal(safeUploadFileName(''), 'file');
  assert.equal(safeUploadFileName('...env'), '_env');
  assert.equal(safeUploadFileName('a'.repeat(200)).length, 120);
  assert.equal(uniqueUploadFileName([], 'ok.csv'), 'ok.csv');
  assert.equal(uniqueUploadFileName(['stem'], 'stem'), 'stem-2');
});

test('composeUploadMessage is files-only when the prompt is empty', () => {
  const msg = composeUploadMessage('  ', [
    { cwdRel: 'uploads/p.jpg', filename: 'p.jpg', mime: 'image/jpeg' },
  ]);
  assert.match(msg, /^p\.jpg/);
  assert.match(msg, /\[IMAGE:uploads\/p\.jpg\]/);
  assert.equal(composeUploadMessage('hi', []).trim(), 'hi');
  assert.equal(CHAT_UPLOAD_MAX_FILES, 8);
  assert.equal(CHAT_UPLOAD_MAX_BYTES, 20 * 1024 * 1024);
});

test('displayUploadMessage strips session-qualified upload bullets', () => {
  assert.equal(
    displayUploadMessage('看\n\n- sessions/s1/uploads/a.csv'),
    '看\n\na.csv',
  );
});
