// Runtime base path injected by the Rust gateway into index.html.
// Allows the SPA to work under a reverse-proxy path prefix.
// When running inside Tauri, the frontend is served from disk so basePath is
// empty and API calls target the gateway URL directly.
// Vite `npm run dev` uses `base: '/hbcdcagent/'`; BASE_URL then supplies the same
// prefix so `/api` and `/ws` match the address bar.

import { isTauri, tauriGatewayUrl } from './tauri';
import { prefixFromViteBaseUrl } from './webPrefix';

declare global {
  interface Window {
    __ZEROCLAW_BASE__?: string;
  }
}

function resolvedBasePath(): string {
  if (isTauri()) return '';
  if (typeof window !== 'undefined' && window.__ZEROCLAW_BASE__ != null) {
    return window.__ZEROCLAW_BASE__.replace(/\/+$/, '');
  }
  const env = import.meta.env as { DEV?: boolean; BASE_URL?: string } | undefined;
  if (env?.DEV) {
    return prefixFromViteBaseUrl(env.BASE_URL);
  }
  return '';
}

/** Public path prefix (e.g. "/hbcdcagent"), or empty string when served at root. */
export const basePath: string = resolvedBasePath();

/** Full origin for API requests. Empty when served by the gateway (same-origin). */
export const apiOrigin: string = isTauri() ? tauriGatewayUrl() : '';

/** Same-origin gateway path, including the public prefix. */
export function gatewayUrl(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${apiOrigin}${basePath}${normalized}`;
}
