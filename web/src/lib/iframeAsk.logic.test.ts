import assert from 'node:assert/strict';
import test from 'node:test';
import {
  composeModelText,
  isEmbeddedFrame,
  planIframeAsk,
  stripProvideData,
} from './iframeAsk.ts';

test('standalone window is not an embed', () => {
  const win: { parent?: unknown; opener?: unknown } = { opener: null };
  win.parent = win;
  assert.equal(isEmbeddedFrame(win), false);
  assert.equal(isEmbeddedFrame({ parent: {}, opener: null }), true);
  assert.equal(isEmbeddedFrame({ parent: win, opener: {} }), true);
});

test('ai:ask keeps provideData off the visible text', () => {
  const plan = planIframeAsk({
    content: '请分析洪山区近一周的传染病态势',
    provideData: { area: '洪山区', from: '2026-09-13' },
    msgId: 'm1',
  }, new Map());
  assert.equal(plan.action, 'send');
  if (plan.action !== 'send') return;
  assert.equal(plan.title, '请分析洪山区近一周的传染病态势');
  assert.match(plan.modelText, /洪山区/);
  assert.equal(stripProvideData(plan.modelText).trim(), plan.content);
  assert.equal(stripProvideData('普通提问'), '普通提问');
});

test('missing content is rejected and msgId replays the same session', () => {
  assert.equal(planIframeAsk({ provideData: { a: 1 } }, new Map()).action, 'reject');
  const seen = new Map([['m1', 'sid-1']]);
  const replay = planIframeAsk({ content: '再问一次', msgId: 'm1' }, seen);
  assert.deepEqual(replay, { action: 'replay', sessionId: 'sid-1' });
  assert.equal(composeModelText('只看这句话', ''), '只看这句话');
});
