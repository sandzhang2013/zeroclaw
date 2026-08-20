import assert from 'node:assert/strict';
import test from 'node:test';

import { canvasFrameFromToolArgs, canvasIdFromToolArgs, canvasPreviewFromToolCall } from './canvasFrame.ts';

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

test('canvasFrameFromToolArgs accepts svg, rejects oversize and unknown types', () => {
  const svg = canvasFrameFromToolArgs({
    action: 'render',
    canvas_id: 'c1',
    content_type: 'svg',
    content: '<svg></svg>',
  });
  assert.equal(svg?.contentType, 'svg');
  assert.equal(
    canvasFrameFromToolArgs({
      action: 'render',
      content_type: 'markdown',
      content: '# hi',
    }),
    null,
  );
  assert.equal(
    canvasFrameFromToolArgs({
      action: 'render',
      content_type: 'html',
      content: 'x'.repeat(256 * 1024 + 1),
    }),
    null,
  );
  assert.equal(canvasIdFromToolArgs({ action: 'render', canvas_id: 'a b' }), null);
  assert.equal(canvasIdFromToolArgs(null), null);
  assert.equal(canvasPreviewFromToolCall({ name: 'shell', args: { action: 'render' } }), null);
  assert.equal(
    canvasPreviewFromToolCall({
      name: 'canvas',
      args: { action: 'render', content_type: 'html', content: '<p>ok</p>' },
    })?.content,
    '<p>ok</p>',
  );
  assert.equal(
    canvasPreviewFromToolCall({
      canvas: { canvasId: 'preset', contentType: 'html', content: '<p>x</p>' },
    })?.canvasId,
    'preset',
  );
});
