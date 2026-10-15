import assert from 'node:assert/strict';
import test from 'node:test';

import { browserZoomFactor, embedZoomStyle, installEmbedCounterZoom, resolveEmbedBaseDpr } from './embedZoom.ts';

test('zoom factor cancels a stable system DPR', () => {
  assert.equal(browserZoomFactor(1.5, 1.5), 1);
  assert.equal(browserZoomFactor(3, 2), 1.5);
  assert.equal(browserZoomFactor(0, 1), null);
});

test('base DPR prefers the query, then storage, then 100%', () => {
  assert.equal(resolveEmbedBaseDpr('', null), 1);
  assert.equal(resolveEmbedBaseDpr('', '1.5'), 1.5);
  assert.equal(resolveEmbedBaseDpr('?baseDpr=2', '1.5'), 2);
  assert.equal(resolveEmbedBaseDpr('?baseDpr=0', '1.5'), 1.5);
  assert.equal(resolveEmbedBaseDpr('?tab=1', ''), 1);
});

test('counter zoom only sets zoom and leaves the root at the parent size', () => {
  assert.deepEqual(embedZoomStyle(2, 1), { zoom: '0.5' });
  assert.deepEqual(embedZoomStyle(1, 1), { zoom: '1' });
});

function fakeRoot() {
  const style = {
    zoom: '',
    width: '',
    height: '',
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
  const page = {
    dataset: {} as { embedZoom?: string },
    style: {
      props: {} as Record<string, string>,
      setProperty(name: string, value: string) { this.props[name] = value; },
      removeProperty(name: string) { delete this.props[name]; },
    },
  };
  const frame = {
    devicePixelRatio: 2,
    parent: {},
    document: { documentElement: page },
    matchMedia: () => ({
      addEventListener: (_type: 'change', fn: () => void, options?: { once?: boolean }) => {
        listeners.push({ once: options?.once, fn });
      },
    }),
  };
  installEmbedCounterZoom(frame, root);
  assert.equal(root.style.zoom, '0.5');
  assert.equal(root.style.width, '');
  assert.equal(root.style.height, '');
  assert.equal(page.dataset.embedZoom, '1');
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0]?.once, true);
  frame.devicePixelRatio = 4;
  listeners[0]?.fn();
  assert.equal(root.style.zoom, '0.25');
  assert.equal(root.style.width, '');
  assert.equal(root.style.height, '');
  assert.equal(listeners.length, 2);
  assert.equal(listeners[1]?.once, true);

  const store = new Map<string, string>();
  const calibrated = fakeRoot();
  installEmbedCounterZoom({
    devicePixelRatio: 3,
    parent: {},
    location: { search: '?baseDpr=1.5' },
    localStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => { store.set(key, value); },
    },
    document: { documentElement: page },
  }, calibrated);
  assert.equal(store.get('baseDpr'), '1.5');
  assert.equal(calibrated.style.zoom, '0.5');
  assert.equal(calibrated.style.width, '');
});
