import assert from 'node:assert/strict';
import test from 'node:test';

import {
  advanceThinkingClock,
  elapsedThinkingSeconds,
  freezeThinkingClock,
  idleThinkingClock,
  shouldFollowThinkingScroll,
  startThinkingClock,
  thinkingPanelOpen,
} from './thinkingScroll.ts';

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

test('elapsedThinkingSeconds counts whole seconds and never shows zero', () => {
  assert.equal(elapsedThinkingSeconds(1_000, 1_000), 1);
  assert.equal(elapsedThinkingSeconds(1_000, 1_400), 1);
  assert.equal(elapsedThinkingSeconds(1_000, 2_000), 1);
  assert.equal(elapsedThinkingSeconds(1_000, 2_001), 2);
  assert.equal(elapsedThinkingSeconds(5_000, 1_000), 1);
});

test('thinking clock starts once and freezes on the first stop', () => {
  const running = startThinkingClock(idleThinkingClock, 1_000);
  assert.deepEqual(startThinkingClock(running, 9_000), running);
  const frozen = freezeThinkingClock(running, 4_200);
  assert.equal(frozen.seconds, 4);
  assert.deepEqual(freezeThinkingClock(frozen, 9_000), frozen);
  assert.equal(freezeThinkingClock(idleThinkingClock, 9_000), idleThinkingClock);
});

test('answer chunks leave the thinking clock running until the turn stops', () => {
  let clock = advanceThinkingClock(idleThinkingClock, 'thinking', 1_000);
  clock = advanceThinkingClock(clock, 'chunk', 2_000);
  assert.equal(clock.startedAt, 1_000);
  assert.equal(clock.seconds, undefined);
  clock = advanceThinkingClock(clock, 'chunk_reset', 5_000);
  assert.equal(clock.seconds, undefined);
  clock = advanceThinkingClock(clock, 'thinking', 6_000);
  assert.equal(clock.startedAt, 1_000);
  assert.equal(clock.seconds, undefined);
  const stopped = advanceThinkingClock(clock, 'stop', 8_200);
  assert.equal(stopped.seconds, 8);
  assert.equal(advanceThinkingClock(stopped, 'chunk', 9_000).seconds, 8);
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
