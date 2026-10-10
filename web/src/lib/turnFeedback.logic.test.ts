import assert from 'node:assert/strict';
import test from 'node:test';

import { latestTurnVerdict, turnKeyAt } from './turnFeedback.ts';

test('turnKeyAt numbers identical replies and ignores blank text', () => {
  const texts = ['概述疫情', '  概述疫情  ', ''];
  assert.equal(turnKeyAt('s1', texts, 0), 's1:0:概述疫情');
  assert.equal(turnKeyAt('s1', texts, 1), 's1:1:概述疫情');
  assert.equal(turnKeyAt('s1', texts, 2), null);
});

test('latestTurnVerdict reads only the last prose reply', () => {
  const history = [
    { role: 'user', content: '查一下' },
    { role: 'agent', content: '第一轮' },
    { role: 'agent', content: 'tool noise', toolCall: { name: 'shell' } },
    { role: 'agent', content: '第二轮' },
  ];
  const entries = [
    { session_id: 's1', message_key: 's1:0:第一轮', verdict: 'like' as const },
    { session_id: 's1', message_key: 's1:0:第二轮', verdict: 'dislike' as const },
  ];
  assert.equal(latestTurnVerdict('s1', history, entries), 'dislike');
  assert.equal(latestTurnVerdict('s1', history.slice(0, 2), entries), 'like');
  assert.equal(latestTurnVerdict('s1', [], entries), undefined);
});
