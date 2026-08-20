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
