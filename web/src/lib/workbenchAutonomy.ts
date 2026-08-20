/** Workbench maps to the runtime `AutonomyLevel` wire form. */

import { normalizeRole } from './platformUser.ts';

export type WorkbenchAutonomy = 'readonly' | 'supervised' | 'full';

export const WORKBENCH_AUTONOMY_LEVELS: WorkbenchAutonomy[] = [
  'readonly',
  'supervised',
  'full',
];

export const DEFAULT_WORKBENCH_AUTONOMY: WorkbenchAutonomy = 'supervised';

const RANK: Record<WorkbenchAutonomy, number> = {
  readonly: 0,
  supervised: 1,
  full: 2,
};

/** Ordinary users cannot skip tool approval. Advanced/ops may use `full`
 * only when the agent config ceiling also allows it (enforced server-side).
 * Missing role (legacy dashboard) applies no extra cap. */
export function maxAutonomyForRole(role?: string): WorkbenchAutonomy {
  if (role == null || role.trim() === '') return 'full';
  const canonical = normalizeRole(role);
  if (canonical === '高级用户' || canonical === '运维') return 'full';
  return 'supervised';
}

export function clampWorkbenchAutonomy(
  level: WorkbenchAutonomy,
  max: WorkbenchAutonomy,
): WorkbenchAutonomy {
  return RANK[level] <= RANK[max] ? level : max;
}

export function autonomyLevelsUpTo(max: WorkbenchAutonomy): WorkbenchAutonomy[] {
  return WORKBENCH_AUTONOMY_LEVELS.filter((level) => RANK[level] <= RANK[max]);
}

const STORAGE_PREFIX = 'zeroclaw-workbench-autonomy';

export function parseWorkbenchAutonomy(raw: unknown): WorkbenchAutonomy {
  if (raw === 'readonly' || raw === 'supervised' || raw === 'full') return raw;
  return DEFAULT_WORKBENCH_AUTONOMY;
}

export function autonomyLabelKey(
  level: WorkbenchAutonomy,
): 'workbench.mode_readonly' | 'workbench.mode_supervised' | 'workbench.mode_full' {
  if (level === 'readonly') return 'workbench.mode_readonly';
  if (level === 'full') return 'workbench.mode_full';
  return 'workbench.mode_supervised';
}

export function autonomyStorageKey(scope: string): string {
  const cleaned = scope.replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 128);
  return `${STORAGE_PREFIX}:${cleaned || 'default'}`;
}

export function loadWorkbenchAutonomy(scope: string): WorkbenchAutonomy {
  try {
    return parseWorkbenchAutonomy(localStorage.getItem(autonomyStorageKey(scope)));
  } catch {
    return DEFAULT_WORKBENCH_AUTONOMY;
  }
}

export function saveWorkbenchAutonomy(scope: string, level: WorkbenchAutonomy): void {
  try {
    localStorage.setItem(autonomyStorageKey(scope), level);
  } catch {
    /* quota / private mode */
  }
}
