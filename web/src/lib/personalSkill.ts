/** Personal skill ids and list filters. Writes go to POST /api/user/skills. */

/** Plaza and skill-center ids from POST /api/skill-ids. */
export function isIssuedSkillId(raw: string): boolean {
  return /^sk\d{4,}$/.test(raw.trim());
}

/** Personal ids from POST /api/skill-ids?scope=personal. */
export function isPersonalSkillId(raw: string): boolean {
  return /^ps\d{4,}$/.test(raw.trim());
}

/** Directory slug: no path separators, no `..`, length-capped. */
export function skillSlug(raw: string): string {
  const collapsed = raw
    .trim()
    .replace(/[/\\]/g, '-')
    .replace(/\.\./g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return collapsed.slice(0, 64) || 'my-skill';
}

export function isPersonalSkillEnabled(skill: { enabled?: boolean }): boolean {
  return skill.enabled !== false;
}

export function filterPersonalSkills<T extends { name: string; title?: string; description?: string }>(
  skills: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return skills;
  return skills.filter((skill) => {
    const hay = [skill.name, skill.title ?? '', skill.description ?? ''].join('\n').toLowerCase();
    return hay.includes(q);
  });
}

export function skillIdTakenKey(message: string): string | null {
  if (message.includes('you already have this skill id')) return 'workbench.skill_id_taken_self';
  if (
    message.includes('skill id is already used')
    || message.includes('skill already exists')
    || message.includes('already on the skill plaza')
  ) {
    return 'workbench.skill_id_taken';
  }
  return null;
}
