import assert from 'node:assert/strict';
import test from 'node:test';

import { htmlPreviewSrcDoc, splitChatHtmlBlocks, HTML_PREVIEW_SANDBOX, HTML_PREVIEW_CSP } from './chatHtmlPreview.ts';

test('splitChatHtmlBlocks extracts html fences and keeps surrounding text', () => {
  const src = [
    '趋势图已在上方渲染出来了',
    '',
    '```html',
    '<div id="chart">ok</div>',
    '```',
    '',
    '结论：上升。',
  ].join('\n');
  const { markdown, htmlBlocks } = splitChatHtmlBlocks(src);
  assert.equal(htmlBlocks.length, 1);
  assert.equal(htmlBlocks[0], '<div id="chart">ok</div>');
  assert.match(markdown, /趋势图已在上方渲染出来了/);
  assert.match(markdown, /结论：上升。/);
  assert.doesNotMatch(markdown, /id="chart"/);
});

test('splitChatHtmlBlocks ignores non-html fences', () => {
  const { markdown, htmlBlocks } = splitChatHtmlBlocks('```js\nalert(1)\n```');
  assert.deepEqual(htmlBlocks, []);
  assert.match(markdown, /alert\(1\)/);
});

test('htmlPreviewSrcDoc wraps fragments and leaves full documents', () => {
  const wrapped = htmlPreviewSrcDoc('<canvas id="c"></canvas>');
  assert.match(wrapped, /<!DOCTYPE html>/);
  assert.match(wrapped, /<canvas id="c"><\/canvas>/);
  assert.match(wrapped, /Content-Security-Policy/);
  const full = '<!DOCTYPE html><html><body>x</body></html>';
  const withCsp = htmlPreviewSrcDoc(full);
  assert.match(withCsp, /<body>x<\/body>/);
  assert.match(withCsp, /Content-Security-Policy/);
});

test('html preview sandbox keeps scripts but not popups or same-origin', () => {
  assert.equal(HTML_PREVIEW_SANDBOX, 'allow-scripts');
  assert.doesNotMatch(HTML_PREVIEW_SANDBOX, /popup/);
  assert.doesNotMatch(HTML_PREVIEW_SANDBOX, /same-origin/);
  assert.doesNotMatch(HTML_PREVIEW_SANDBOX, /forms/);
  assert.match(HTML_PREVIEW_CSP, /form-action 'none'/);
  assert.match(HTML_PREVIEW_CSP, /object-src 'none'/);
  assert.doesNotMatch(HTML_PREVIEW_CSP, /sandbox/);
});

test('splitChatHtmlBlocks handles htm fences, CRLF, empties, and multiples', () => {
  const src = '```htm\r\n<div>a</div>\r\n```\n```html\n\n```\n```html\n<canvas></canvas>\n```';
  const { htmlBlocks, markdown } = splitChatHtmlBlocks(src);
  assert.deepEqual(htmlBlocks, ['<div>a</div>', '<canvas></canvas>']);
  assert.doesNotMatch(markdown, /canvas/);
  assert.deepEqual(splitChatHtmlBlocks('```HTML\n<p>x</p>\n```').htmlBlocks, []);
});

test('htmlPreviewSrcDoc injects CSP into existing head and html shells', () => {
  const headed = htmlPreviewSrcDoc('<html lang="zh"><head data-x="1"><title>t</title></head><body>x</body></html>');
  assert.match(headed, /<head data-x="1"><meta http-equiv="Content-Security-Policy"/);
  const noHead = htmlPreviewSrcDoc('<html><body>y</body></html>');
  assert.match(noHead, /<html><head><meta http-equiv="Content-Security-Policy"/);
  const withOwn = htmlPreviewSrcDoc(
    '<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body>z</body></html>',
  );
  const oursMeta = withOwn.indexOf(`content="${HTML_PREVIEW_CSP}"`);
  const untrusted = withOwn.indexOf('default-src *');
  assert.ok(oursMeta >= 0 && oursMeta < untrusted, 'our CSP meta must come first so it intersects the untrusted policy');
  assert.match(HTML_PREVIEW_CSP, /frame-src 'none'/);
  assert.match(HTML_PREVIEW_CSP, /base-uri 'none'/);
});
