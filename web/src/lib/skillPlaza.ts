/** Plaza helpers. The catalog itself is `shared/skill-plaza/<id>/SKILL.md` on the install. */

export interface PlazaSkillView {
  id: string;
  title: string;
  description: string;
  body: string;
  version?: string;
  publishedAt?: string;
  changeNote?: string;
  previousVersion?: number;
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

/** Plaza only adds a skill. A newer plaza version is offered later in My skills. */
export function plazaCardAction(installed: boolean): 'add' | 'added' {
  return installed ? 'added' : 'add';
}

/** Version on the installed copy. The date is that same plaza release, not a newer one. */
export function installedSkillStamp(input: {
  installedVersion?: string;
  plazaVersion?: string;
  publishedAt?: string;
}): { version: string; publishedAt: string } {
  const version = (input.installedVersion ?? '').trim();
  const publishedAt = version && version === (input.plazaVersion ?? '').trim()
    ? (input.publishedAt ?? '').trim()
    : '';
  return { version, publishedAt };
}

/** A plaza copy can be refreshed by its owner when the plaza version differs. */
export function mineSkillUpdateAvailable(input: {
  fromPlaza: boolean;
  plazaVersion?: string;
  installedVersion?: string;
}): boolean {
  if (!input.fromPlaza) return false;
  return plazaUpdateAvailable(input.plazaVersion, input.installedVersion, true);
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

/** The one-line note shown on an update card and in the release list. */
export function releaseNoteText(note?: string): string {
  return (note ?? '').trim();
}

/** Map a publish rejection onto a workbench string. Other failures stay with the caller. */
export function publishFailureKey(message: string): string | null {
  if (message.includes('when to use this skill')) return 'workbench.skill_center_need_description';
  if (message.includes('one-line change note')) return 'workbench.skill_center_need_note';
  if (message.includes('contains a secret')) return 'workbench.skill_center_secret';
  if (message.includes('script-like files') || message.includes('blocked by skill security policy')) {
    return 'workbench.skill_center_script';
  }
  return null;
}

/** Roll back only when this plaza copy is already on the latest kept release. */
export function canRollBack(input: {
  fromPlaza: boolean;
  installedVersion?: string;
  plazaVersion?: string;
  previousVersion?: number;
}): boolean {
  if (!input.fromPlaza || !input.previousVersion) return false;
  const installed = (input.installedVersion ?? '').trim();
  const plaza = (input.plazaVersion ?? '').trim();
  return installed !== '' && installed === plaza;
}
