import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldFollowThinkingScroll } from './thinkingScroll.ts';

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
