import assert from 'node:assert/strict';
import test from 'node:test';

import { cssSupportsColorMix, installStructuredClonePolyfill } from './browserSupport.ts';

test('cssSupportsColorMix accepts the one-argument CSS.supports form', () => {
  const supports = (a: string, b?: string) => b === undefined && a.startsWith('color: color-mix');
  assert.equal(cssSupportsColorMix(supports), true);
});

test('cssSupportsColorMix accepts the two-argument form with hex colors', () => {
  const supports = (a: string, b?: string) =>
    a === 'color' && b === 'color-mix(in srgb, #f00 50%, #00f)';
  assert.equal(cssSupportsColorMix(supports), true);
});

test('cssSupportsColorMix is false when CSS.supports is missing', () => {
  assert.equal(cssSupportsColorMix(undefined), false);
});

test('cssSupportsColorMix is false when every probe throws', () => {
  const supports = () => {
    throw new Error('nope');
  };
  assert.equal(cssSupportsColorMix(supports), false);
});

test('installStructuredClonePolyfill keeps a native implementation', () => {
  const native = (value: unknown) => value;
  const target = { structuredClone: native, JSON };
  assert.equal(installStructuredClonePolyfill(target), true);
  assert.equal(target.structuredClone, native);
});

test('installStructuredClonePolyfill adds a JSON clone when missing', () => {
  const target: {
    structuredClone?: (value: unknown) => unknown;
    JSON: typeof JSON;
  } = { JSON };
  assert.equal(installStructuredClonePolyfill(target), true);
  assert.deepEqual(target.structuredClone?.({ a: 1 }), { a: 1 });
});
