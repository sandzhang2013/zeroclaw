/** Product URL prefix. Vite serve and production `gateway.path_prefix` share this. */
export const DEFAULT_WEB_PREFIX = "/hbcdcagent";

/** Normalize a public URL prefix: `/hbcdcagent`, no trailing slash. Empty means site root. */
export function normalizeWebPrefix(raw: string | undefined | null): string {
  if (raw == null) return "";
  let prefix = raw.trim();
  if (!prefix || prefix === "/") return "";
  if (!prefix.startsWith("/")) prefix = `/${prefix}`;
  return prefix.replace(/\/+$/, "");
}

/** Vite `base` is `/hbcdcagent/` in serve, `/_app/` in production builds. */
export function prefixFromViteBaseUrl(baseUrl: string | undefined): string {
  const prefix = normalizeWebPrefix(baseUrl);
  if (!prefix || prefix === "/_app") return "";
  return prefix;
}

export function stripWebPrefix(path: string, prefix: string): string {
  if (!prefix) return path;
  if (path === prefix) return "/";
  if (path.startsWith(`${prefix}/`)) {
    return path.slice(prefix.length) || "/";
  }
  return path;
}

/**
 * Gateway serves bundled files at `{prefix}/_app/logo.png`. Vite serve puts
 * `public/` files at `{prefix}/logo.png`. Map the gateway URL onto Vite's.
 */
export function rewriteDevAppAssetUrl(url: string, prefix: string): string {
  const qIndex = url.indexOf("?");
  const pathname = qIndex >= 0 ? url.slice(0, qIndex) : url;
  const search = qIndex >= 0 ? url.slice(qIndex) : "";
  const prefixedApp = prefix ? `${prefix}/_app/` : "/_app/";
  if (pathname.startsWith(prefixedApp)) {
    const rest = pathname.slice(prefixedApp.length);
    const dest = prefix ? `${prefix}/${rest}` : `/${rest}`;
    return `${dest}${search}`;
  }
  if (prefix && pathname.startsWith("/_app/")) {
    return `${prefix}/${pathname.slice("/_app/".length)}${search}`;
  }
  if (!prefix && pathname.startsWith("/_app/")) {
    return `/${pathname.slice("/_app/".length)}${search}`;
  }
  return url;
}
