import assert from 'node:assert/strict';
import test from 'node:test';

import {
  estimatePromptTokens,
  expandQuickPrompt,
  filterQuickPrompts,
  mergeQuickPromptLists,
  parseQuickPrompts,
  quickPromptForQuery,
  reconcileQuickPromptStore,
  removeQuickPrompt,
  resolveQuickPromptSend,
  swapQuickPrompts,
  upsertQuickPrompt,
} from './quickPrompts.ts';

const saved = [
  { id: 'a', title: '疫情概况', body: '概述近期全省疫情。' },
  { id: 'b', title: '预警信号', body: '列出今日预警。' },
];

test('parseQuickPrompts drops blank and broken rows', () => {
  assert.deepEqual(parseQuickPrompts(null), []);
  assert.deepEqual(parseQuickPrompts('nope'), []);
  assert.deepEqual(parseQuickPrompts(JSON.stringify([
    { id: 'a', title: ' 标题 ', body: ' 正文 ' },
    { id: '', title: '空', body: 'x' },
    { title: '缺 id', body: 'x' },
  ])), [{ id: 'a', title: '标题', body: '正文' }]);
});

test('quickPromptForQuery prefers an exact title, otherwise a single match', () => {
  assert.equal(quickPromptForQuery(saved, '疫情概况')?.id, 'a');
  assert.equal(quickPromptForQuery(saved, '预警')?.id, 'b');
  assert.equal(quickPromptForQuery(saved, '疫')?.id, 'a');
  assert.equal(quickPromptForQuery([
    { id: 'a', title: '周报提纲', body: 'a' },
    { id: 'b', title: '周报正文', body: 'b' },
  ], '周报'), null);
  assert.equal(quickPromptForQuery(saved, '   '), null);
  assert.deepEqual(filterQuickPrompts(saved, '预').map((prompt) => prompt.id), ['b']);
});

test('upsertQuickPrompt updates the same title and remove drops one row', () => {
  const created = upsertQuickPrompt(saved, { title: '周报', body: '起草周报。' });
  assert.equal(created?.length, 3);
  const updated = upsertQuickPrompt(created ?? [], { title: '疫情概况', body: '换一段。' });
  assert.equal(updated?.find((prompt) => prompt.id === 'a')?.body, '换一段。');
  assert.equal(upsertQuickPrompt(saved, { title: '  ', body: 'x' }), null);
  assert.deepEqual(removeQuickPrompt(saved, 'a').map((prompt) => prompt.id), ['b']);
  assert.equal(upsertQuickPrompt(saved, { title: '疫情概况', body: '概述近期全省疫情。', shared: true })
    ?.find((prompt) => prompt.id === 'a')?.shared, true);
});

test('shared prompts stay visible beside a personal list', () => {
  assert.equal(estimatePromptTokens(''), 0);
  assert.equal(estimatePromptTokens('疫情'), 2);
  assert.equal(estimatePromptTokens('abcd'), 1);
  const merged = mergeQuickPromptLists(
    [{ id: 'a', title: '个人', body: '只给自己' }],
    [{ id: 'b', title: '全局', body: '大家都看得到' }],
  );
  assert.deepEqual(merged.map((prompt) => [prompt.id, prompt.shared ?? false]), [['a', false], ['b', true]]);
  assert.equal(parseQuickPrompts(JSON.stringify([{ id: 'b', title: '全局', body: 'x', shared: true }]))[0]?.shared, true);
});

test('swapQuickPrompts exchanges two rows and ignores a missing id', () => {
  assert.deepEqual(swapQuickPrompts(saved, 'a', 'b').map((prompt) => prompt.id), ['b', 'a']);
  assert.equal(swapQuickPrompts(saved, 'a', 'missing'), saved);
});

test('resolveQuickPromptSend replaces a title and leaves other text', () => {
  assert.equal(resolveQuickPromptSend('疫情概况', saved).text, '概述近期全省疫情。');
  assert.equal(resolveQuickPromptSend('疫情概况', saved).title, '疫情概况');
  assert.equal(expandQuickPrompt('疫', saved), '概述近期全省疫情。');
  assert.equal(resolveQuickPromptSend('随便写一段', saved).text, '随便写一段');
  assert.equal(resolveQuickPromptSend('概述近期全省疫情。', saved).text, '概述近期全省疫情。');
});

test('reconcile uploads only a side the server has never stored', () => {
  const local = [
    { id: 'a', title: '个人', body: '自己的' },
    { id: 's', title: '全局', body: '大家的', shared: true },
  ];
  const missing = reconcileQuickPromptStore(local, { personal: null, shared: null });
  assert.equal(missing.upload, true);
  assert.deepEqual(missing.prompts.map((prompt) => prompt.id), ['a', 's']);

  const cleared = reconcileQuickPromptStore(local, { personal: [], shared: [] });
  assert.equal(cleared.upload, false);
  assert.deepEqual(cleared.prompts, []);

  const mixed = reconcileQuickPromptStore(local, {
    personal: [{ id: 'b', title: '云端', body: '账号上的' }],
    shared: null,
  });
  assert.equal(mixed.upload, true);
  assert.deepEqual(mixed.prompts.map((prompt) => [prompt.id, Boolean(prompt.shared)]), [
    ['b', false],
    ['s', true],
  ]);
});
