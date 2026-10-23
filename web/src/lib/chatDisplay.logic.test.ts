import assert from 'node:assert/strict';
import test from 'node:test';

import { collapseChatBlankRuns } from './chatDisplay.ts';

test('collapseChatBlankRuns keeps one paragraph break and drops the hole', () => {
  assert.equal(collapseChatBlankRuns('前文\n\n\n\n\n\n后文'), '前文\n\n后文');
  assert.equal(collapseChatBlankRuns('前文\n\n后文'), '前文\n\n后文');
  assert.equal(collapseChatBlankRuns('\n\n\n只有空行\n\n\n'), '只有空行');
  assert.equal(collapseChatBlankRuns('   \n\t\n\n'), '');
});

test('collapseChatBlankRuns leaves blank lines inside a closed fence', () => {
  const src = '说明\n\n\n```\n\n\nkeep\n```\n\n\n结尾';
  assert.equal(collapseChatBlankRuns(src), '说明\n\n```\n\n\nkeep\n```\n\n结尾');
});
