import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveContextBarState } from '../lib/contextBar.ts';
import {
  contextLimitsFromDoneFrame,
  loadContextMeter,
  parseContextMeterSnapshot,
  saveContextMeter,
} from './contextLimits.logic.ts';

test('a done frame without capacity clears the previous route denominator', () => {
  let limits = contextLimitsFromDoneFrame({
    max_context_tokens: 180_000,
    model_context_window: 200_000,
  });
  assert.deepEqual(limits, { maxTokens: 180_000, modelWindow: 200_000 });

  limits = contextLimitsFromDoneFrame({
    max_context_tokens: 32_000,
  });
  assert.deepEqual(limits, { maxTokens: 32_000, modelWindow: null });

  const rendered = resolveContextBarState(
    limits.maxTokens,
    limits.modelWindow,
    16_000,
  );
  assert.ok(rendered);
  assert.equal(rendered.denominator, 32_000);
  assert.equal(rendered.trimMarkerIndex, null);
});

test('a saved meter restores the last measured prompt size', () => {
  const storage = new Map<string, string>();
  const memory = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
    },
  };
  saveContextMeter('sess-1', {
    maxTokens: 128_000,
    modelWindow: 128_000,
    inputTokens: 17_000,
  }, memory);

  const saved = loadContextMeter('sess-1', memory);
  assert.deepEqual(saved, {
    maxTokens: 128_000,
    modelWindow: 128_000,
    inputTokens: 17_000,
  });
  assert.equal(loadContextMeter('sess-2', memory), null);
  assert.equal(parseContextMeterSnapshot('not-json'), null);
  assert.equal(parseContextMeterSnapshot('{"inputTokens":12}'), null);
});
