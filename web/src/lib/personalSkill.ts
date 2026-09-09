/** Personal-skill draft helpers. Writes go to POST /api/user/skills. */

export interface PersonalSkillDraft {
  name: string;
  description: string;
  body: string;
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

export function skillTitleFromAsk(userText: string): string {
  const first = userText.trim().split('\n')[0]?.trim() ?? '';
  return first.slice(0, 32) || '我的技能';
}

export function draftPersonalSkill(input: {
  userText: string;
  assistantText: string;
}): PersonalSkillDraft {
  const title = skillTitleFromAsk(input.userText);
  const name = skillSlug(title);
  const ask = input.userText.trim();
  const reply = input.assistantText.trim();
  const description = (ask.split('\n')[0]?.trim() || title).slice(0, 160);
  const body = [
    `# ${title}`,
    '',
    '## When to use',
    ask || title,
    '',
    '## How we did it',
    reply || title,
  ].join('\n');
  return { name, description, body };
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

export function shouldShowSaveSkillButton(input: {
  isAssistant: boolean;
  streaming: boolean;
  hasProse: boolean;
  content: string;
  isError?: boolean;
}): boolean {
  if (!input.isAssistant || input.streaming || !input.hasProse || input.isError) return false;
  return Boolean(input.content.trim());
}
