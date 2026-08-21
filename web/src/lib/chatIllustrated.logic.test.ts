import assert from 'node:assert/strict';
import test from 'node:test';

import {
  groupIllustratedBubbles,
  shouldAttachStreamingToGroup,
  visibleChatMessages,
} from './chatIllustrated.ts';

test('visibleChatMessages hides plumbing tools unless the wrench is on', () => {
  const rows = [
    { id: 'u', role: 'user' as const },
    { id: 't', role: 'agent' as const, toolCall: { name: 'shell', output: 'ok' } },
    { id: 'img', role: 'agent' as const, toolCall: { name: 'plot', output: '[IMAGE:uploads/a.png]' } },
  ];
  assert.deepEqual(visibleChatMessages(rows, false).map((m) => m.id), ['u', 'img']);
  assert.deepEqual(visibleChatMessages(rows, true).map((m) => m.id), ['u', 't', 'img']);
});

test('groupIllustratedBubbles keeps user rows solo and joins chart plus prose', () => {
  const groups = groupIllustratedBubbles([
    { id: 'u', role: 'user' as const },
    { id: 'img', role: 'agent' as const, toolCall: { name: 'plot', output: '[IMAGE:uploads/a.png]' } },
    { id: 'txt', role: 'agent' as const },
    { id: 'u2', role: 'user' as const },
    { id: 'txt2', role: 'agent' as const },
  ], false);
  assert.deepEqual(groups.map((g) => g.map((m) => m.id)), [['u'], ['img', 'txt'], ['u2'], ['txt2']]);
});

test('groupIllustratedBubbles does not swallow notices or wrench-only cards', () => {
  const groups = groupIllustratedBubbles([
    { id: 'img', role: 'agent' as const, toolCall: { name: 'plot', output: '[IMAGE:uploads/a.png]' } },
    { id: 'n', role: 'agent' as const, notice: true },
    { id: 'txt', role: 'agent' as const },
    { id: 'sh', role: 'agent' as const, toolCall: { name: 'shell', output: 'ok' } },
    { id: 'txt2', role: 'agent' as const },
  ], true);
  assert.deepEqual(groups.map((g) => g.map((m) => m.id)), [['img'], ['n'], ['txt'], ['sh'], ['txt2']]);
});

test('visibleChatMessages hides html reports and canvas from the transcript', () => {
  const rows = [
    { id: 'u', role: 'user' as const, content: '写报告' },
    {
      id: 'html',
      role: 'agent' as const,
      toolCall: { name: 'file_write', artifact: { path: 'sessions/s1/a.html', filename: 'a.html', title: '报告', mime: 'text/html', size: 12 } },
    },
    { id: 'fence', role: 'agent' as const, content: '```html\n<html><body>r</body></html>\n```' },
    { id: 'img', role: 'agent' as const, toolCall: { name: 'plot', output: '[IMAGE:uploads/a.png]' } },
    { id: 'txt', role: 'agent' as const, content: '见右侧报告。' },
  ];
  assert.deepEqual(visibleChatMessages(rows, false).map((m) => m.id), ['u', 'img', 'txt']);
});

test('shouldAttachStreamingToGroup follows an illustrated agent bubble', () => {
  assert.equal(shouldAttachStreamingToGroup([{ id: 'img', role: 'agent', toolCall: { output: '[IMAGE:a.png]' } }]), true);
  assert.equal(shouldAttachStreamingToGroup([{ id: 'u', role: 'user' }]), false);
  assert.equal(shouldAttachStreamingToGroup(undefined), false);
});
