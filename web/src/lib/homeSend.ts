import type { Locale } from './locale.ts';
import { sanitizeSessionTitle, stripSessionTitleTimestamp } from './workbenchSession.ts';

/** Homepage catalog skill carried into a workbench session. */
export type HomeSkillRef = {
  id: string;
  label: string;
  kind?: string;
  icon?: string;
};

/** Compose a user message that still names the attached home skill for the model. */

export function composeHomeMessage(input: {
  userText: string;
  skill?: { label: string; kind?: string; prompts?: { text: string }[] } | null;
  locale?: Locale;
  /** First turn includes the catalog prompt; later turns only keep the skill tag. */
  includePrompt?: boolean;
}): string {
  const user = input.userText.trim();
  const skill = input.skill;
  if (!skill) return user;

  const locale = input.locale === 'en' ? 'en' : 'zh';
  const includePrompt = input.includePrompt !== false;
  const name = skill.label.trim();
  const prompts = (skill.prompts ?? []).map((prompt) => prompt.text.trim()).filter(Boolean);
  const outline = skill.kind === 'outline';
  const header = skillHeader(name, outline, locale);
  if (!includePrompt) {
    return user ? `${header}\n${user}` : header;
  }
  if (user && prompts.some((prompt) => user.includes(prompt))) {
    return `${header}\n${user}`;
  }

  const parts = [header];
  const lead = prompts[0];
  if (lead) parts.push(lead);
  if (user) parts.push(extraLine(user, locale));
  return parts.join('\n');
}

export function homeSessionTitle(input: {
  userText: string;
  skillLabel?: string;
}): string {
  return input.userText.trim().split('\n')[0] || input.skillLabel?.trim() || '';
}

/** Sidebar / heading title from a stored user turn — never the skill wrapper or a date prefix. */
export function titleFromUserMessage(raw: string, skillLabel?: string): string {
  const parsed = parseHomeSkillDisplay(raw);
  return homeSessionTitle({
    userText: parsed.visible,
    skillLabel: parsed.skillLabel ?? skillLabel,
  });
}

/** Keep a real stored name; replace a wrapper/empty title with visible text or the skill label. */
export function nextStoredSessionTitle(input: {
  stored?: string | null;
  preview?: string | null;
  skillLabel?: string;
}): string | undefined {
  const preview = sanitizeSessionTitle(input.preview);
  const skill = sanitizeSessionTitle(input.skillLabel);
  const stored = sanitizeSessionTitle(input.stored);
  if (stored) {
    const parsed = parseHomeSkillDisplay(stored);
    if (parsed.skillLabel && parsed.visible !== stored) {
      return sanitizeSessionTitle(parsed.visible) ?? preview ?? skill ?? stored;
    }
    if (preview && preview.startsWith(stored) && preview.length > stored.length) {
      return preview;
    }
    return stored;
  }
  return preview ?? skill ?? undefined;
}

export function canSubmitHomeMessage(input: {
  userText: string;
  hasAttachments: boolean;
  skill?: { label: string; kind?: string; prompts?: { text: string }[] } | null;
}): boolean {
  return Boolean(composeHomeMessage(input) || input.hasAttachments);
}

function skillHeader(name: string, outline: boolean, locale: Locale): string {
  if (locale === 'en') {
    return outline
      ? `Use the skill "${name}" for this task. Give an editable outline first, then write the body after confirmation.`
      : `Use the skill "${name}" for this task.`;
  }
  return outline
    ? `请使用技能「${name}」完成下面的任务。先给出可修改的提纲，确认后再写正文。`
    : `请使用技能「${name}」完成下面的任务。`;
}

function extraLine(user: string, locale: Locale): string {
  return locale === 'en' ? `Additional request: ${user}` : `补充要求：${user}`;
}

/** Bubble view of a home-page send: skill is a tag, not a prose prefix. */
export function parseHomeSkillDisplay(modelText: string): {
  skillLabel?: string;
  visible: string;
} {
  const text = stripSessionTitleTimestamp(modelText);
  if (!text) return { visible: '' };

  const zh = text.match(/^请使用技能「([^」]+)」完成下面的任务。(?:先给出可修改的提纲，确认后再写正文。)?/);
  const en = text.match(/^Use the skill "([^"]+)" for this task\.(?: Give an editable outline first, then write the body after confirmation\.)?/);
  const header = zh ?? en;
  if (!header || header.index !== 0) return { visible: text };

  const skillLabel = header[1]?.trim();
  const rest = text.slice(header[0].length).replace(/^\n+/, '');
  const extra = rest.match(/(?:^|\n)(?:补充要求：|Additional request: )([\s\S]+)$/);
  if (extra) return { skillLabel, visible: extra[1].trim() };
  return { skillLabel, visible: rest.trim() };
}

/** Recover the homepage skill tag from a stored user message (reopen / history). */
export function recoverHomeSkill(modelText: string): HomeSkillRef | undefined {
  const parsed = parseHomeSkillDisplay(modelText);
  if (!parsed.skillLabel) return undefined;
  const body = stripSessionTitleTimestamp(modelText);
  const outline = /先给出可修改的提纲|editable outline/i.test(body);
  return {
    id: parsed.skillLabel,
    label: parsed.skillLabel,
    kind: outline ? 'outline' : 'chat',
  };
}
