import assert from 'node:assert/strict';
import test from 'node:test';

import { canvasFrameFromToolArgs, canvasIdFromToolArgs } from './canvasFrame.ts';

test('canvasIdFromToolArgs reads render ids and defaults', () => {
  assert.equal(canvasIdFromToolArgs({ action: 'render', canvas_id: 'covid-report' }), 'covid-report');
  assert.equal(canvasIdFromToolArgs({ action: 'render' }), 'default');
  assert.equal(canvasIdFromToolArgs({ action: 'clear', canvas_id: 'covid-report' }), null);
  assert.equal(canvasIdFromToolArgs({ action: 'render', canvas_id: '../x' }), null);
});

test('canvasFrameFromToolArgs reads html from render args', () => {
  const frame = canvasFrameFromToolArgs({
    action: 'render',
    canvas_id: 'covid-report',
    content_type: 'html',
    content: '<svg></svg>',
  });
  assert.equal(frame?.canvasId, 'covid-report');
  assert.equal(frame?.contentType, 'html');
  assert.equal(canvasFrameFromToolArgs({ action: 'render' }), null);
});
