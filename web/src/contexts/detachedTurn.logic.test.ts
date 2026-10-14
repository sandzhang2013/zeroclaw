import assert from 'node:assert/strict';
import test from 'node:test';

import { recoveredAssistant } from './detachedTurn.logic.ts';

test('recoveredAssistant returns the newest assistant row the page has not shown', () => {
  const answer = recoveredAssistant(
    ['上一轮已经在屏幕上'],
    [
      { role: 'user', content: '新问题' },
      { role: 'assistant', content: '上一轮已经在屏幕上' },
      { role: 'assistant', content: '   ' },
      { role: 'tool', content: '工具输出不算回答' },
      { role: 'assistant', content: '先写到这里' },
      { role: 'assistant', content: '完整回答' },
    ],
  );
  assert.equal(answer, '完整回答');
});

test('recoveredAssistant waits while the server has not stored the answer', () => {
  assert.equal(
    recoveredAssistant(['已有回答'], [
      { role: 'user', content: '新问题' },
      { role: 'assistant', content: '已有回答' },
    ]),
    null,
  );
  assert.equal(recoveredAssistant([], []), null);
});
