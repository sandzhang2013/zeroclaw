/** Plaza helpers. The catalog itself is `shared/skill-plaza/<id>/SKILL.md` on the install. */

export interface PlazaSkillView {
  id: string;
  title: string;
  description: string;
  body: string;
  version?: string;
  publishedAt?: string;
  creatorId?: string;
  creatorName?: string;
}

export function filterPlazaSkills(skills: PlazaSkillView[], query: string): PlazaSkillView[] {
  const q = query.trim().toLowerCase();
  if (!q) return skills;
  return skills.filter((skill) => {
    const hay = [skill.id, skill.title, skill.description].join('\n').toLowerCase();
    return hay.includes(q);
  });
}

export function installedSkillNames(skills: { name: string }[]): Set<string> {
  return new Set(skills.map((skill) => skill.name));
}

export function isPlazaInstalled(id: string, installed: Set<string>): boolean {
  return installed.has(id);
}

/** Own working copies stay installed. Plaza installs can still take a newer version. */
export function plazaCardAction(input: {
  installed: boolean;
  ownCopy: boolean;
  plazaVersion?: string;
  installedVersion?: string;
}): 'add' | 'update' | 'added' {
  if (input.installed && input.ownCopy) return 'added';
  if (plazaUpdateAvailable(input.plazaVersion, input.installedVersion, input.installed)) {
    return 'update';
  }
  return input.installed ? 'added' : 'add';
}

/** A plaza version is newer than the installed copy. Empty versions do not prompt. */
export function plazaUpdateAvailable(
  plazaVersion: string | undefined,
  installedVersion: string | undefined,
  installed: boolean,
): boolean {
  if (!installed) return false;
  const next = (plazaVersion ?? '').trim();
  if (!next) return false;
  return next !== (installedVersion ?? '').trim();
}
