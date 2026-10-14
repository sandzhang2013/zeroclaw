/** Workbench maps to the runtime `AutonomyLevel` wire form. */

export type WorkbenchAutonomy = 'readonly' | 'supervised' | 'full';

export const WORKBENCH_AUTONOMY_LEVELS: WorkbenchAutonomy[] = [
  'readonly',
  'supervised',
  'full',
];

export const DEFAULT_WORKBENCH_AUTONOMY: WorkbenchAutonomy = 'full';

const RANK: Record<WorkbenchAutonomy, number> = {
  readonly: 0,
  supervised: 1,
  full: 2,
};

/** Role does not cap the selector. Ordinary users and admins may both pick
 * `full`; the server still applies the agent config ceiling. The workbench
 * starts in autonomous mode until the user changes it. */
export function maxAutonomyForRole(_role?: string): WorkbenchAutonomy {
  return 'full';
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
