/**
 * Browser zoom relative to the DPR captured when the embed loaded.
 * System DPI is in both numbers, so it cancels. 1 means unchanged since load.
 */
export function browserZoomFactor(currentDpr: number, baseDpr: number): number | null {
  if (!Number.isFinite(currentDpr) || !Number.isFinite(baseDpr) || currentDpr <= 0 || baseDpr <= 0) {
    return null;
  }
  return currentDpr / baseDpr;
}

/** Counter-scale so an embedded page keeps the size it had when it opened. */
export function embedZoomStyle(
  currentDpr: number,
  baseDpr: number,
): { zoom: string; width: string; minHeight: string } | null {
  const z = browserZoomFactor(currentDpr, baseDpr);
  if (z == null) return null;
  return {
    zoom: String(1 / z),
    width: `${100 * z}%`,
    minHeight: `${100 * z}vh`,
  };
}

/**
 * Layout length for one visual viewport after `zoom: 1/z`.
 * `100vh` inside the zoomed tree paints shorter than the iframe, which leaves
 * the empty band under the workbench. Empty string means keep normal viewport units.
 */
export function embedLayoutLength(currentDpr: number, baseDpr: number): string {
  const z = browserZoomFactor(currentDpr, baseDpr);
  if (z == null || Math.abs(z - 1) < 0.01) return '';
  return `${100 * z}vh`;
}

export function embedLayoutWidth(currentDpr: number, baseDpr: number): string {
  const z = browserZoomFactor(currentDpr, baseDpr);
  if (z == null || Math.abs(z - 1) < 0.01) return '';
  return `${100 * z}vw`;
}

type ResolutionQuery = {
  addEventListener: (
    type: 'change',
    listener: () => void,
    options?: { once?: boolean },
  ) => void;
};

type ZoomRoot = {
  style: {
    setProperty: (name: string, value: string) => void;
    width: string;
    minHeight: string;
  };
};

type ZoomPage = {
  dataset: { embedZoom?: string };
  style: {
    setProperty: (name: string, value: string) => void;
    removeProperty: (name: string) => void;
  };
};

type ZoomWindow = {
  devicePixelRatio: number;
  parent?: unknown;
  opener?: unknown;
  matchMedia?: (query: string) => ResolutionQuery;
  document?: { documentElement: ZoomPage };
};

/** Same rule as `isEmbeddedFrame`: iframe or popup, not a top-level tab. */
function isEmbed(win: { parent?: unknown; opener?: unknown }): boolean {
  return win.parent !== win || Boolean(win.opener);
}

/** Cancel browser zoom inside an iframe or popup. Top-level pages are left alone. */
export function installEmbedCounterZoom(win: ZoomWindow, root: ZoomRoot): void {
  if (!isEmbed(win)) return;
  const baseDpr = win.devicePixelRatio;
  const apply = () => {
    const style = embedZoomStyle(win.devicePixelRatio, baseDpr);
    if (!style) return;
    root.style.setProperty('zoom', style.zoom);
    root.style.width = style.width;
    root.style.minHeight = style.minHeight;
    const page = win.document?.documentElement;
    if (!page) return;
    const height = embedLayoutLength(win.devicePixelRatio, baseDpr);
    const width = embedLayoutWidth(win.devicePixelRatio, baseDpr);
    if (!height || !width) {
      delete page.dataset.embedZoom;
      page.style.removeProperty('--embed-layout-vh');
      page.style.removeProperty('--embed-layout-vw');
      return;
    }
    page.dataset.embedZoom = '1';
    page.style.setProperty('--embed-layout-vh', height);
    page.style.setProperty('--embed-layout-vw', width);
  };
  const watch = () => {
    const mq = win.matchMedia?.(`(resolution: ${win.devicePixelRatio}dppx)`);
    mq?.addEventListener('change', () => {
      apply();
      watch();
    }, { once: true });
  };
  apply();
  watch();
}
