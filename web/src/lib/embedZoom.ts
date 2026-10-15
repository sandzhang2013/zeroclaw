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
    removeProperty: (name: string) => void;
  };
};

type ZoomWindow = {
  parent?: unknown;
  opener?: unknown;
  document?: { documentElement: ZoomPage };
};

/** Same rule as `isEmbeddedFrame`: iframe or popup, not a top-level tab. */
function isEmbed(win: { parent?: unknown; opener?: unknown }): boolean {
  return win.parent !== win || Boolean(win.opener);
}

/**
 * Leave an embedded page at the browser's own zoom.
 * `devicePixelRatio` already includes the system scale, so countering it
 * shrinks the page on open and then cancels later browser zoom.
 */
export function installEmbedCounterZoom(win: ZoomWindow, root: ZoomRoot): void {
  if (!isEmbed(win)) return;
  const page = win.document?.documentElement;
  if (page) {
    delete page.dataset.embedZoom;
    page.style.removeProperty('--embed-layout-vh');
    page.style.removeProperty('--embed-layout-vw');
  }
  root.style.setProperty('zoom', '');
  root.style.width = '';
  root.style.height = '';
  root.style.minHeight = '';
}
