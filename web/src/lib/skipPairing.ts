import { parsePlatformPayload } from './platformUser.ts';
import { DEFAULT_WEB_PREFIX, stripWebPrefix } from './webPrefix.ts';

/** True for `/workbench` with or without the product prefix (basename missing). */
export function isWorkbenchPath(pathname: string): boolean {
  const stripped = stripWebPrefix(pathname, DEFAULT_WEB_PREFIX);
  return stripped === '/workbench' || stripped.startsWith('/workbench/');
}

/**
 * Device pairing is for the daemon dashboard. BFF identity and the
 * workbench route use `X-User-*` instead. Also skip in Vite (`dev`).
 */
export function shouldSkipPairing(input: {
  dev?: boolean;
  pathname: string;
  platformUser?: unknown;
}): boolean {
  if (input.dev) return true;
  if (parsePlatformPayload(input.platformUser)) return true;
  if (isWorkbenchPath(input.pathname)) return true;
  // BFF (path_prefix=/hbcdcagent) uses X-User-* instead of device pairing,
  // including /dashboard. Direct daemon at site root still pairs.
  const stripped = stripWebPrefix(input.pathname, DEFAULT_WEB_PREFIX);
  return stripped !== input.pathname;
}
