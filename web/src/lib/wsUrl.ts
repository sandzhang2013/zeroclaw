/**
 * WebSocket URL for a same-origin path. `new WebSocket('/path')` is invalid
 * in browsers, so this resolves the path against the current page (pass
 * `window.location.href`, or the Tauri gateway origin) and only then
 * switches http(s) → ws(s). Never bake a host into the bundle.
 */
export function sameOriginWebSocketUrl(pathAndQuery: string, pageHref: string): string {
  const path = pathAndQuery.startsWith('/') ? pathAndQuery : `/${pathAndQuery}`;
  const url = new URL(path, pageHref);
  if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  } else if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  } else {
    throw new Error('WebSocket URL must resolve against an http(s) page');
  }
  return url.href;
}
