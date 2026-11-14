import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  chatTranscriptClass,
  composerDockClass,
  playSteer,
  steerCaptionVisible,
  steerComposer,
  steerOutline,
  thinkingTranscriptClass,
  type SteerPlayEvent,
} from './steerTurn.logic.ts';

const idleComposer = {
  connected: true,
  hydrated: true,
  typing: false,
  draft: '',
  uploading: false,
  hasSendPayload: false,
  modelLoading: false,
  modelUnavailable: false,
};

function outline(events: SteerPlayEvent[]) {
  return steerOutline(playSteer(events));
}

function catalogPhrase(locale: 'zh' | 'en', key: string): string {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'i18n.ts'), 'utf8');
  const start = src.indexOf(locale === 'zh' ? '  zh: {' : '\n  en: {');
  const end = locale === 'zh' ? src.indexOf('\n  en: {') : src.length;
  const block = src.slice(start, end);
  const match = block.match(new RegExp(`'${key}':\\s*'([^']*)'`));
  return match?.[1] ?? '';
}

test('the follow-up copy is the recorded wording in both catalogs', () => {
  assert.equal(catalogPhrase('zh', 'agent.steer_placeholder'), '可追加指令，执行将动态调整');
  assert.equal(catalogPhrase('zh', 'agent.steer_pending'), '执行将动态纳入该新指令');
  assert.equal(catalogPhrase('en', 'agent.steer_placeholder'), 'You can add an instruction. Execution will adjust as it goes.');
  assert.equal(catalogPhrase('en', 'agent.steer_pending'), 'Execution will fold in this new instruction');
  assert.equal(catalogPhrase('zh', 'agent.interrupted'), '已停止');
});

test('while a turn is answering the composer stays open and the locks stay on', () => {
  const running = steerComposer({ ...idleComposer, typing: true, draft: '' });
  assert.equal(running.textareaDisabled, false);
  assert.equal(running.placeholderKey, 'agent.steer_placeholder');
  assert.equal(running.stopVisible, true);
  assert.equal(running.sendDisabled, true);
  assert.equal(running.autonomyDisabled, true);
  assert.equal(running.modelDisabled, true);

  const withDraft = steerComposer({ ...idleComposer, typing: true, draft: '上海' });
  assert.equal(withDraft.sendDisabled, false);
  assert.equal(withDraft.stopVisible, true);

  const idle = steerComposer(idleComposer);
  assert.equal(idle.placeholderKey, 'agent.type_message');
  assert.equal(idle.stopVisible, false);
  assert.equal(idle.autonomyDisabled, false);
  assert.equal(idle.modelDisabled, false);
});

test('a follow-up before any answer text does not leave an empty thinking card', () => {
  const mid = outline([
    { type: 'send', content: '天气' },
    { type: 'thinking', content: '先查天气' },
    { type: 'send', content: '上海' },
  ]);
  assert.deepEqual(mid.rows.map((row) => row.content), ['天气', '上海']);
  assert.equal(mid.rows[1]?.caption, true);
  assert.equal(mid.pendingThinking, '先查天气');
  assert.equal(mid.streamIndex, -1);

  const afterTool = outline([
    { type: 'send', content: '天气' },
    { type: 'thinking', content: '先查天气' },
    { type: 'tool' },
    { type: 'send', content: '上海' },
    { type: 'thinking', content: '改为查上海' },
  ]);
  assert.deepEqual(afterTool.rows.map((row) => row.content), ['天气', '上海']);
  assert.equal(afterTool.rows[1]?.caption, true);
  assert.equal(afterTool.pendingThinking, '改为查上海');
  assert.equal(afterTool.streamIndex, -1);

  const done = outline([
    { type: 'send', content: '天气' },
    { type: 'thinking', content: '先查天气' },
    { type: 'tool' },
    { type: 'send', content: '上海' },
    { type: 'thinking', content: '改为查上海' },
    { type: 'chunk', content: '上海也查不到' },
    { type: 'done', full: '上海也查不到' },
  ]);
  assert.deepEqual(done.rows.map((row) => [row.role, row.content, row.caption]), [
    ['user', '天气', false],
    ['user', '上海', false],
    ['agent', '上海也查不到', false],
  ]);
  assert.equal(done.rows[2]?.thinking, '改为查上海');
  assert.equal(steerCaptionVisible(false, true), false);
});

test('a follow-up after visible text keeps that text above and opens the next answer below', () => {
  const mid = outline([
    { type: 'send', content: '天气' },
    { type: 'thinking', content: '先问城市' },
    { type: 'chunk', content: '要哪个？' },
    { type: 'send', content: '上海' },
    { type: 'thinking', content: '改查上海' },
  ]);
  assert.deepEqual(mid.rows.map((row) => [row.role, row.content]), [
    ['user', '天气'],
    ['agent', '要哪个？'],
    ['user', '上海'],
  ]);
  assert.equal(mid.rows[1]?.thinking, '先问城市');
  assert.equal(mid.rows[2]?.caption, true);
  assert.equal(mid.pendingThinking, '改查上海');
  assert.equal(mid.streamIndex, -1);

  const held = outline([
    { type: 'send', content: '天气' },
    { type: 'thinking', content: '先问城市' },
    { type: 'chunk', content: '要哪个？' },
    { type: 'send', content: '上海' },
  ]);
  assert.equal(held.pending, '要哪个？');
  assert.equal(held.pendingThinking, '先问城市');
  assert.equal(held.rows[1]?.caption, true);
  assert.equal(held.streamIndex, -1);

  const done = outline([
    { type: 'send', content: '天气' },
    { type: 'thinking', content: '先问城市' },
    { type: 'chunk', content: '要哪个？' },
    { type: 'send', content: '上海' },
    { type: 'thinking', content: '改查上海' },
    { type: 'chunk', content: '上海暂时查不到' },
    { type: 'done', full: '要哪个？上海暂时查不到' },
  ]);
  assert.deepEqual(done.rows.map((row) => [row.role, row.content, row.thinking ?? '']), [
    ['user', '天气', ''],
    ['agent', '要哪个？', '先问城市'],
    ['user', '上海', ''],
    ['agent', '上海暂时查不到', '改查上海'],
  ]);
  assert.equal(done.rows.every((row) => !row.caption), true);
});

test('a later question streams under itself, not inside the previous answer', () => {
  const next = outline([
    { type: 'send', content: '天气' },
    { type: 'chunk', content: '要哪个？' },
    { type: 'done', full: '要哪个？' },
    { type: 'send', content: '只回复一个字：好' },
    { type: 'chunk', content: '好' },
  ]);
  assert.deepEqual(next.rows.map((row) => row.content), ['天气', '要哪个？', '只回复一个字：好']);
  assert.equal(next.rows[2]?.caption, false);
  assert.equal(next.streamIndex, -1);
  assert.equal(next.pending, '好');
});

test('stop ends the whole turn and clears the follow-up caption', () => {
  const early = outline([
    { type: 'send', content: '请慢慢想' },
    { type: 'stop', note: '已停止' },
  ]);
  assert.deepEqual(early.rows.map((row) => [row.role, row.content, row.caption]), [
    ['user', '请慢慢想', false],
    ['agent', '已停止', false],
  ]);

  const afterText = outline([
    { type: 'send', content: '天气' },
    { type: 'chunk', content: '先写到这里' },
    { type: 'send', content: '上海' },
    { type: 'stop', note: '已停止' },
  ]);
  assert.deepEqual(afterText.rows.map((row) => [row.content, row.caption]), [
    ['天气', false],
    ['上海', false],
    ['先写到这里\n\n已停止', false],
  ]);
});

test('finished thinking grows with the page and the message list stays the scroller', () => {
  assert.equal(thinkingTranscriptClass(true), 'max-h-60 overflow-auto [overflow-anchor:none]');
  assert.equal(thinkingTranscriptClass(false), '');
  assert.match(chatTranscriptClass(false), /min-h-0/);
  assert.match(chatTranscriptClass(false), /overflow-y-auto/);
  assert.match(composerDockClass(), /shrink-0/);
});
