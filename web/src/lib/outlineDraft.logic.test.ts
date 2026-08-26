import assert from 'node:assert/strict';
import test from 'node:test';

import {
  composeOutlineContinuePrompt,
  isOutlineEditTurn,
  loadOutlineDraft,
  outlineDraftStorageKey,
  persistOutlineDraft,
  shouldShowOutlineEditButton,
} from './outlineDraft.ts';

/** Keep in sync with `workbench.home_cap_*_prompt` in i18n.ts (zh + en). */
const REPORT_PROMPTS = [
  '帮我起草一份疾控工作简报提纲，结构清晰、重点突出。',
  '帮我起草本周传染病监测周报提纲。',
  '帮我起草一份专题分析报告提纲，含背景、发现和建议。',
  '帮我按疾控例会口径整理一份会议纪要提纲。',
  'Draft a CDC work-brief outline with a clear structure and key points.',
  'Draft an outline for this week’s infectious-disease surveillance report.',
  'Draft a special-analysis report outline covering background, findings, and recommendations.',
  'Draft a meeting-minutes outline in CDC standing-meeting style.',
];

const OTHER_PROMPTS = [
  '帮我查询并概述近期全省传染病疫情情况。',
  '帮我查询并解读近期疫苗接种覆盖率。',
  '帮我按地区和时间检索病例数据并给出要点。',
  '帮我查询相关疾控与医疗机构名单并整理成表。',
  '根据监测数据帮我分析近期疫情趋势并解读关键变化。',
  '帮我梳理近期聚集性疫情情况并提示风险点。',
  '帮我分析近期预警信号数据并给出研判建议。',
  '帮我对比各地市监测指标差异并标出异常地区。',
  'Query and summarize recent infectious-disease conditions across the province.',
  'Look up and explain recent vaccination coverage.',
  'Search cases by region and time, then highlight the key points.',
  'Look up CDC and medical facilities and organize them into a table.',
  'Analyze recent epidemic trends from surveillance data and explain key changes.',
  'Summarize recent cluster outbreaks and flag risk points.',
  'Analyze recent alert signals and provide an assessment.',
  'Compare prefecture-level indicators and mark unusual areas.',
];

test('outlineDraftStorageKey is session-scoped', () => {
  assert.equal(outlineDraftStorageKey('abc'), 'zeroclaw-outline-draft:abc');
});

test('composeOutlineContinuePrompt asks the model to keep the edited structure', () => {
  const prompt = composeOutlineContinuePrompt('  一、疫情概况\n  二、措施  ');
  assert.match(prompt, /已确认提纲/);
  assert.match(prompt, /不要再改章节结构/);
  assert.ok(prompt.endsWith('一、疫情概况\n  二、措施'));
  assert.equal(isOutlineEditTurn(prompt), false);
});

test('isOutlineEditTurn matches outline asks', () => {
  assert.equal(isOutlineEditTurn('帮我起草一份疾控工作简报提纲，结构清晰、重点突出。'), true);
  assert.equal(isOutlineEditTurn('  把大纲第三点改成学校监测  '), true);
  assert.equal(isOutlineEditTurn('Draft an outline for the weekly report'), true);
  assert.equal(isOutlineEditTurn('Please add two OUTLINES'), true);
  assert.equal(isOutlineEditTurn('outlines for next week'), true);
});

test('isOutlineEditTurn rejects unrelated asks and empty text', () => {
  assert.equal(isOutlineEditTurn('帮我查询并概述近期全省传染病疫情情况。'), false);
  assert.equal(isOutlineEditTurn('The region is outlined in red'), false);
  assert.equal(isOutlineEditTurn(''), false);
  assert.equal(isOutlineEditTurn('   '), false);
});

test('isOutlineEditTurn rejects the body-writing follow-up', () => {
  assert.equal(isOutlineEditTurn(composeOutlineContinuePrompt('一、概况\n二、措施')), false);
});

test('home report prompts are outline turns; query and monitor prompts are not', () => {
  for (const prompt of REPORT_PROMPTS) {
    assert.equal(isOutlineEditTurn(prompt), true, prompt);
  }
  for (const prompt of OTHER_PROMPTS) {
    assert.equal(isOutlineEditTurn(prompt), false, prompt);
  }
});

test('shouldShowOutlineEditButton only on finished assistant outline replies', () => {
  const outlineAsk = '帮我起草一份疾控工作简报提纲，结构清晰、重点突出。';
  const outbreakAsk = '帮我查询并概述近期全省传染病疫情情况。';
  const base = {
    isAssistant: true,
    streaming: false,
    hasProse: true,
    content: '一、概况\n二、措施\n三、建议',
    previousUserText: outlineAsk,
  };

  assert.equal(shouldShowOutlineEditButton(base), true);
  assert.equal(shouldShowOutlineEditButton({ ...base, isAssistant: false }), false);
  assert.equal(shouldShowOutlineEditButton({ ...base, streaming: true }), false);
  assert.equal(shouldShowOutlineEditButton({ ...base, hasProse: false }), false);
  assert.equal(shouldShowOutlineEditButton({ ...base, content: '   ' }), false);
  assert.equal(shouldShowOutlineEditButton({ ...base, previousUserText: outbreakAsk }), false);
  assert.equal(shouldShowOutlineEditButton({
    ...base,
    previousUserText: composeOutlineContinuePrompt(base.content),
  }), false);
  assert.equal(shouldShowOutlineEditButton({ ...base, previousUserText: '' }), false);
});

test('loadOutlineDraft and persistOutlineDraft round-trip per session', () => {
  const store = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    },
  });
  try {
    assert.equal(loadOutlineDraft('s1'), null);
    persistOutlineDraft('s1', '一、概况');
    persistOutlineDraft('s2', '二、措施');
    assert.equal(loadOutlineDraft('s1'), '一、概况');
    assert.equal(loadOutlineDraft('s2'), '二、措施');
    persistOutlineDraft('s1', '   ');
    assert.equal(loadOutlineDraft('s1'), null);
    persistOutlineDraft('s1', null);
    assert.equal(loadOutlineDraft('s1'), null);
    assert.equal(loadOutlineDraft('s2'), '二、措施');
    assert.equal(loadOutlineDraft(''), null);
    persistOutlineDraft('', 'ignored');
    assert.equal(store.has(outlineDraftStorageKey('s2')), true);
    assert.equal(store.has(outlineDraftStorageKey('')), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
});
