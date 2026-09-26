/// <reference types="vite/client" />

declare module "virtual:workbench-version" {
  /** `git rev-list --count HEAD`. Null when git is unavailable. */
  export const workbenchCommitCount: number | null;
}
