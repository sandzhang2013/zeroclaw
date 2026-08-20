import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractImageMarkers,
  extractMcpToolImages,
  extractMcpToolText,
  extractToolImages,
  looksLikeChatImages,
  stripImageMarkers,
} from './chatImages.ts';

test('extractImageMarkers keeps data uris and relative paths', () => {
  const imgs = extractImageMarkers('see [IMAGE:data:image/png;base64,abc] and [IMAGE:uploads/a.png]');
  assert.deepEqual(imgs, [
    { kind: 'data', src: 'data:image/png;base64,abc' },
    { kind: 'path', path: 'uploads/a.png' },
  ]);
  assert.deepEqual(extractImageMarkers('[IMAGE:/etc/passwd]'), []);
  assert.deepEqual(extractImageMarkers('[IMAGE:../secret]'), []);
  assert.deepEqual(extractImageMarkers('[IMAGE:data:image/svg+xml;base64,PHN2Zz4=]'), []);
  assert.deepEqual(extractImageMarkers('[IMAGE:charts/trend.svg]'), []);
});

test('extractMcpToolImages reads tools/call image parts', () => {
  const raw = JSON.stringify({
    content: [
      { type: 'text', text: 'ok' },
      { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
    ],
  });
  const imgs = extractMcpToolImages(raw);
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0]?.kind, 'data');
  if (imgs[0]?.kind === 'data') {
    assert.equal(imgs[0].src, 'data:image/png;base64,iVBORw0KGgo=');
  }
  const svg = JSON.stringify({
    content: [{ type: 'image', mimeType: 'image/svg+xml', data: 'PHN2Zz4=' }],
  });
  assert.deepEqual(extractMcpToolImages(svg), []);
});

test('extractToolImages prefers MCP payload over leftover markers', () => {
  const raw = JSON.stringify({
    content: [{ type: 'image', mimeType: 'image/png', data: 'QQ==' }],
  });
  assert.equal(extractToolImages(raw).length, 1);
  assert.equal(stripImageMarkers('a [IMAGE:uploads/x.png] b'), 'a  b');
});

test('extractMcpToolImages walks nested content and mime_type', () => {
  const raw = JSON.stringify({
    isError: false,
    result: {
      content: [{ type: 'Image', mime_type: 'image/png', data: 'QQ==' }],
    },
  });
  const imgs = extractMcpToolImages(raw);
  assert.equal(imgs.length, 1);
  assert.equal(extractMcpToolText(JSON.stringify({
    content: [
      { type: 'text', text: '湖北省新冠趋势' },
      { type: 'image', mimeType: 'image/png', data: 'QQ==' },
    ],
  })), '湖北省新冠趋势');
  assert.equal(looksLikeChatImages(raw), true);
  assert.equal(looksLikeChatImages('{"ok":true}'), false);
});
