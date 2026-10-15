/** localStorage key. A visit to `?baseDpr=1.5` remembers a non-100% system scale. */
export const EMBED_BASE_DPR_KEY = 'baseDpr';

/**
 * System scale, not the browser zoom at first paint.
 * `devicePixelRatio` is system scale times browser zoom, and the page cannot
 * split them. Priority: `?baseDpr=` , then localStorage, then 1 (100%).
 */
export function resolveEmbedBaseDpr(search: string, stored: string | null | undefined): number {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  const params = new URLSearchParams(raw);
  const fromQuery = Number(params.get('baseDpr'));
  if (params.has('baseDpr') && Number.isFinite(fromQuery) && fromQuery > 0) return fromQuery;
  const fromStore = Number(stored);
  if (stored != null && stored !== '' && Number.isFinite(fromStore) && fromStore > 0) return fromStore;
  return 1;
}

/**
 * Browser zoom relative to the system scale. 1 means the browser is at 100%.
 */
export function browserZoomFactor(currentDpr: number, baseDpr: number): number | null {
  if (!Number.isFinite(currentDpr) || !Number.isFinite(baseDpr) || currentDpr <= 0 || baseDpr <= 0) {
    return null;
  }
  return currentDpr / baseDpr;
}

/**
 * Counter-scale so text matches a 100% browser. The root stays 100% of the
 * parent; shrinking it by the zoom factor leaves an empty band, because
 * `zoom` does not grow the border box back to the viewport.
 */
export function embedZoomStyle(
  currentDpr: number,
  baseDpr: number,
): { zoom: string } | null {
  const z = browserZoomFactor(currentDpr, baseDpr);
  if (z == null) return null;
  return { zoom: String(1 / z) };
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
    height: string;
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

type ZoomStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

type ZoomWindow = {
  devicePixelRatio: number;
  parent?: unknown;
  opener?: unknown;
  location?: { search: string };
  localStorage?: ZoomStorage;
  matchMedia?: (query: string) => ResolutionQuery;
  document?: { documentElement: ZoomPage };
};

/** Same rule as `isEmbeddedFrame`: iframe or popup, not a top-level tab. */
function isEmbed(win: { parent?: unknown; opener?: unknown }): boolean {
  return win.parent !== win || Boolean(win.opener);
}

function storedBaseDpr(win: ZoomWindow): string | null {
  try {
    return win.localStorage?.getItem(EMBED_BASE_DPR_KEY) ?? null;
  } catch {
    return null;
  }
}

/** Cancel browser zoom inside an iframe or popup. Top-level pages are left alone. */
export function installEmbedCounterZoom(win: ZoomWindow, root: ZoomRoot): void {
  if (!isEmbed(win)) return;
  const search = win.location?.search ?? '';
  const baseDpr = resolveEmbedBaseDpr(search, storedBaseDpr(win));
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const fromQuery = Number(params.get('baseDpr'));
  if (params.has('baseDpr') && Number.isFinite(fromQuery) && fromQuery > 0) {
    try {
      win.localStorage?.setItem(EMBED_BASE_DPR_KEY, String(fromQuery));
    } catch { /* private mode */ }
  }
  const apply = () => {
    const style = embedZoomStyle(win.devicePixelRatio, baseDpr);
    if (!style) return;
    const page = win.document?.documentElement;
    if (page) {
      page.dataset.embedZoom = '1';
      page.style.removeProperty('--embed-layout-vh');
      page.style.removeProperty('--embed-layout-vw');
    }
    root.style.setProperty('zoom', style.zoom);
    root.style.width = '';
    root.style.height = '';
    root.style.minHeight = '';
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
