import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldFollowThinkingScroll, thinkingPanelOpen } from './thinkingScroll.ts';

test('thinkingPanelOpen stays open until the answer has visible text', () => {
  assert.equal(thinkingPanelOpen(''), true);
  assert.equal(thinkingPanelOpen(' \n\t'), true);
  assert.equal(thinkingPanelOpen('好的'), false);
});

test('shouldFollowThinkingScroll stays pinned near the bottom', () => {
  assert.equal(
    shouldFollowThinkingScroll({
      scrollTop: 400,
      clientHeight: 200,
      scrollHeight: 600,
    }),
    true,
  );
  assert.equal(
    shouldFollowThinkingScroll({
      scrollTop: 376,
      clientHeight: 200,
      scrollHeight: 600,
    }),
    true,
  );
});

test('shouldFollowThinkingScroll releases after the reader scrolls up', () => {
  assert.equal(
    shouldFollowThinkingScroll({
      scrollTop: 0,
      clientHeight: 200,
      scrollHeight: 600,
    }),
    false,
  );
  assert.equal(
    shouldFollowThinkingScroll({
      scrollTop: 100,
      clientHeight: 200,
      scrollHeight: 600,
    }),
    false,
  );
});
