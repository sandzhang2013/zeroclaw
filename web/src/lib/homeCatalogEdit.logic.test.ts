import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canSubmitHomeDraft,
  draftHomeCap,
  draftHomePrompt,
  draftHomeTab,
  moveItem,
  previewLabel,
  suggestHomeId,
  usedHomeIds,
  normalizeHomeCatalog,
  normalizeHomeCatalogEdit,
} from './homeCatalogEdit.ts';

test('suggestHomeId slugs ascii and avoids collisions', () => {
  assert.equal(suggestHomeId('Outbreak overview', []), 'outbreak_overview');
  assert.equal(suggestHomeId('Outbreak overview', ['outbreak_overview']), 'outbreak_overview_2');
});

test('suggestHomeId falls back when the label has no ascii', () => {
  assert.equal(suggestHomeId('疫情概况', []), 'item');
  assert.equal(suggestHomeId('疫情概况', ['item']), 'item_2');
});

test('moveItem swaps neighbors and no-ops at the edges', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c'], 1, -1), ['b', 'a', 'c']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 0, -1), ['a', 'b', 'c']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 2, 1), ['a', 'b', 'c']);
});

test('previewLabel prefers the active locale then falls back', () => {
  assert.equal(previewLabel('疫情', 'Outbreak', true), '疫情');
  assert.equal(previewLabel('', 'Outbreak', true), 'Outbreak');
  assert.equal(previewLabel('疫情', '', false), '疫情');
});

test('canSubmitHomeDraft requires a zh or en label', () => {
  assert.equal(canSubmitHomeDraft('  ', ''), false);
  assert.equal(canSubmitHomeDraft('数据查询', ''), true);
  assert.equal(canSubmitHomeDraft('', 'Query'), true);
});

test('draftHomeTab uses the english label for the id when present', () => {
  const tab = draftHomeTab('数据查询', 'Query', []);
  assert.equal(tab.id, 'query');
  assert.equal(tab.label_zh, '数据查询');
  assert.equal(tab.label_en, 'Query');
  assert.deepEqual(tab.caps, []);
});

test('draftHomeCap falls back to item when the label has no ascii', () => {
  const cap = draftHomeCap('疫情概况', '', ['item']);
  assert.equal(cap.id, 'item_2');
  assert.equal(cap.label_zh, '疫情概况');
  assert.equal(cap.kind, 'chat');
  assert.deepEqual(cap.prompts, []);
});

test('draftHomePrompt slugs from english text when present', () => {
  const prompt = draftHomePrompt('帮我查询疫情', 'Query outbreaks', []);
  assert.equal(prompt.id, 'query_outbreaks');
  assert.equal(prompt.text_zh, '帮我查询疫情');
});

test('usedHomeIds includes tabs, skills, and prompts', () => {
  assert.deepEqual(
    usedHomeIds([
      {
        id: 'query',
        label_zh: '数据查询',
        label_en: 'Query',
        caps: [
          {
            id: 'outbreak',
            icon: 'activity',
            kind: 'chat',
            label_zh: '疫情概况',
            label_en: '',
            prompts: [{ id: 'outbreak_p1', text_zh: '查疫情', text_en: '' }],
          },
        ],
      },
    ]),
    ['query', 'outbreak', 'outbreak_p1'],
  );
});

test('normalizeHomeCatalog lifts a legacy single prompt', () => {
  const catalog = normalizeHomeCatalog({
    source: 'config',
    tabs: [
      {
        id: 'query',
        label: '数据查询',
        caps: [
          {
            id: 'outbreak',
            icon: 'activity',
            kind: 'chat',
            label: '疫情概况',
            prompts: [],
            prompt: '帮我查疫情',
          } as never,
        ],
      },
    ],
  });
  assert.deepEqual(catalog.tabs[0]?.caps[0]?.prompts, [
    { id: 'outbreak_p1', text: '帮我查疫情' },
  ]);
});

test('normalizeHomeCatalogEdit lifts legacy prompt_zh/prompt_en', () => {
  const catalog = normalizeHomeCatalogEdit({
    source: 'config',
    tabs: [
      {
        id: 'query',
        label_zh: '数据查询',
        label_en: '',
        caps: [
          {
            id: 'outbreak',
            icon: 'activity',
            kind: 'chat',
            label_zh: '疫情概况',
            label_en: '',
            prompts: [],
            prompt_zh: '帮我查疫情',
            prompt_en: 'Query outbreaks',
          } as never,
        ],
      },
    ],
  });
  assert.deepEqual(catalog.tabs[0]?.caps[0]?.prompts, [
    { id: 'outbreak_p1', text_zh: '帮我查疫情', text_en: 'Query outbreaks' },
  ]);
});
