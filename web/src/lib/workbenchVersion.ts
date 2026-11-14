/** Sidebar badge. `web/WORKBENCH_VERSION` is the source of truth. */
export const WORKBENCH_VERSION_FALLBACK = "0.9.000";

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** Keep a `MAJOR.MINOR.PATCH` string. Anything else falls back. */
export function workbenchVersionLabel(raw: string | null | undefined): string {
  const text = raw?.trim() ?? "";
  if (!VERSION_RE.test(text)) return WORKBENCH_VERSION_FALLBACK;
  return text;
}

/**
 * Next badge from the kernel version in `Cargo.toml` `[workspace.package]`.
 * Kernel `A.B.C` owns the band `A.B.(C*100)` through `A.B.(C*100+99)`.
 * Inside that band the patch grows by one. A different line starts at `C*100`.
 * Returns null when either string is not `MAJOR.MINOR.PATCH`.
 */
export function bumpWorkbenchVersion(raw: string, kernel: string): string | null {
  const current = VERSION_RE.exec(raw.trim());
  const kernelMatch = VERSION_RE.exec(kernel.trim());
  if (!current || !kernelMatch) return null;
  const floor = Number(kernelMatch[3]) * 100;
  const patch = Number(current[3]);
  const sameLine = current[1] === kernelMatch[1] && current[2] === kernelMatch[2];
  const inBand = patch >= floor && patch < floor + 100;
  const nextPatch = sameLine && inBand ? patch + 1 : floor;
  return `${kernelMatch[1]}.${kernelMatch[2]}.${nextPatch}`;
}
