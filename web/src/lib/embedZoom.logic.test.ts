import assert from 'node:assert/strict';
import test from 'node:test';

import { installEmbedCounterZoom } from './embedZoom.ts';

function fakeRoot() {
  const style = {
    zoom: '0.5',
    width: '200%',
    height: '200%',
    minHeight: '200vh',
    setProperty(name: string, value: string) {
      if (name === 'zoom') style.zoom = value;
    },
  };
  return { style };
}

test('install leaves a top-level page untouched', () => {
  const root = fakeRoot();
  const win = { parent: undefined as unknown, opener: undefined };
  win.parent = win;
  installEmbedCounterZoom(win, root);
  assert.equal(root.style.zoom, '0.5');
  assert.equal(root.style.width, '200%');
});

test('install clears a counter zoom inside an iframe', () => {
  const root = fakeRoot();
  const page = {
    dataset: { embedZoom: '1' } as { embedZoom?: string },
    style: {
      props: { '--embed-layout-vh': '200vh' } as Record<string, string>,
      removeProperty(name: string) { delete this.props[name]; },
    },
  };
  installEmbedCounterZoom({
    parent: {},
    document: { documentElement: page },
  }, root);
  assert.equal(root.style.zoom, '');
  assert.equal(root.style.width, '');
  assert.equal(root.style.height, '');
  assert.equal(root.style.minHeight, '');
  assert.equal(page.dataset.embedZoom, undefined);
  assert.equal(page.style.props['--embed-layout-vh'], undefined);
});
