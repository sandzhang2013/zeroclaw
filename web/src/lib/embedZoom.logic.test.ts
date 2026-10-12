import assert from 'node:assert/strict';
import test from 'node:test';

import { browserZoomFactor, embedZoomStyle, installEmbedCounterZoom } from './embedZoom.ts';

test('zoom factor cancels a stable system DPR', () => {
  assert.equal(browserZoomFactor(1.5, 1.5), 1);
  assert.equal(browserZoomFactor(3, 2), 1.5);
  assert.equal(browserZoomFactor(0, 1), null);
});

test('counter zoom restores the size captured at load and fills the viewport', () => {
  assert.deepEqual(embedZoomStyle(2, 1), { zoom: '0.5', width: '200%', minHeight: '200vh' });
  assert.deepEqual(embedZoomStyle(1, 1), { zoom: '1', width: '100%', minHeight: '100vh' });
});

function fakeRoot() {
  const style = {
    zoom: '',
    width: '',
    minHeight: '',
    setProperty(name: string, value: string) {
      if (name === 'zoom') style.zoom = value;
    },
  };
  return { style };
}

test('install is a no-op outside an embed and listens once inside one', () => {
  const topRoot = fakeRoot();
  const topWin = { devicePixelRatio: 2, parent: undefined as unknown, opener: undefined };
  topWin.parent = topWin;
  installEmbedCounterZoom(topWin, topRoot);
  assert.equal(topRoot.style.zoom, '');

  const listeners: Array<{ once?: boolean; fn: () => void }> = [];
  const root = fakeRoot();
  const frame = {
    devicePixelRatio: 2,
    parent: {},
    matchMedia: () => ({
      addEventListener: (_type: 'change', fn: () => void, options?: { once?: boolean }) => {
        listeners.push({ once: options?.once, fn });
      },
    }),
  };
  installEmbedCounterZoom(frame, root);
  assert.equal(root.style.zoom, '1');
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0]?.once, true);
  frame.devicePixelRatio = 4;
  listeners[0]?.fn();
  assert.equal(root.style.zoom, '0.5');
  assert.equal(root.style.width, '200%');
  assert.equal(root.style.minHeight, '200vh');
  assert.equal(listeners.length, 2);
  assert.equal(listeners[1]?.once, true);
});
