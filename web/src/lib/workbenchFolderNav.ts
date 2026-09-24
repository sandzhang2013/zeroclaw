import { workspaceStorageId } from './platformUser.ts';

/** Expand/collapse of the workbench folder list. Local UI state only. */
export const FOLDER_NAV_STORAGE_KEY = 'zeroclaw-workbench-folder-nav';

export interface FolderNavState {
  projectsOpen: boolean;
  tasksOpen: boolean;
  folderOpen: Record<string, boolean>;
}

export function folderNavStorageKey(userId?: string): string {
  return userId ? `${FOLDER_NAV_STORAGE_KEY}:${workspaceStorageId(userId)}` : FOLDER_NAV_STORAGE_KEY;
}

export function defaultFolderNav(): FolderNavState {
  return { projectsOpen: true, tasksOpen: true, folderOpen: {} };
}

export function parseFolderNav(raw: string | null | undefined): FolderNavState {
  const fallback = defaultFolderNav();
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
    const o = value as Record<string, unknown>;
    const folderOpen: Record<string, boolean> = {};
    if (o.folderOpen && typeof o.folderOpen === 'object' && !Array.isArray(o.folderOpen)) {
      for (const [id, open] of Object.entries(o.folderOpen as Record<string, unknown>)) {
        if (id && typeof open === 'boolean') folderOpen[id] = open;
      }
    }
    return {
      projectsOpen: typeof o.projectsOpen === 'boolean' ? o.projectsOpen : fallback.projectsOpen,
      tasksOpen: typeof o.tasksOpen === 'boolean' ? o.tasksOpen : fallback.tasksOpen,
      folderOpen,
    };
  } catch {
    return fallback;
  }
}

/** Missing keys stay expanded so first visits match the previous default. */
export function isFolderExpanded(folderOpen: Record<string, boolean>, folderId: string): boolean {
  return folderOpen[folderId] !== false;
}

export function readFolderNav(userId?: string): FolderNavState {
  if (typeof localStorage === 'undefined') return defaultFolderNav();
  try {
    return parseFolderNav(localStorage.getItem(folderNavStorageKey(userId)));
  } catch {
    return defaultFolderNav();
  }
}

export function writeFolderNav(userId: string | undefined, nav: FolderNavState): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(folderNavStorageKey(userId), JSON.stringify(nav));
  } catch { /* quota / private mode */ }
}
