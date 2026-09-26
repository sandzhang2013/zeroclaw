/** Sidebar badge. `0.6.2` is this commit count; each later commit adds 1 to the last number. */
export const WORKBENCH_VERSION_BASE = "0.6.2";
export const WORKBENCH_VERSION_BASE_COMMITS = 5140;

/** `commitCount` is `git rev-list --count HEAD`. Missing git stays on the base. */
export function workbenchVersionLabel(commitCount: number | null | undefined): string {
  const parts = WORKBENCH_VERSION_BASE.split(".");
  const major = parts[0];
  const minor = parts[1];
  const patch = Number(parts[2]);
  if (
    major === undefined ||
    minor === undefined ||
    !Number.isInteger(patch) ||
    commitCount == null ||
    !Number.isInteger(commitCount) ||
    commitCount < WORKBENCH_VERSION_BASE_COMMITS
  ) {
    return WORKBENCH_VERSION_BASE;
  }
  return `${major}.${minor}.${patch + (commitCount - WORKBENCH_VERSION_BASE_COMMITS)}`;
}
