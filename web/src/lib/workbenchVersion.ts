/** Sidebar badge. `web/WORKBENCH_VERSION` is the source of truth. */
export const WORKBENCH_VERSION_FALLBACK = "0.6.2";

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Keep a `MAJOR.MINOR.PATCH` string. Anything else falls back to `0.6.2`. */
export function workbenchVersionLabel(raw: string | null | undefined): string {
  const text = raw?.trim() ?? "";
  if (!VERSION_RE.test(text)) return WORKBENCH_VERSION_FALLBACK;
  return text;
}

/** Next patch, or null when `raw` is not `MAJOR.MINOR.PATCH`. */
export function bumpWorkbenchVersion(raw: string): string | null {
  const match = VERSION_RE.exec(raw.trim());
  if (!match) return null;
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}
