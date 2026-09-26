import { stripProvideData } from './iframeAsk.ts';
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
  skill?: { id?: string; label: string; kind?: string; prompts?: { text: string }[] } | null;
  locale?: Locale;
  /** First turn includes the catalog prompt; later turns only keep the skill tag. */
  includePrompt?: boolean;
}): string {
  const user = input.userText.trim();
  const skill = input.skill;
  if (!skill) return user;

  const locale = input.locale === 'en' ? 'en' : 'zh';
  const includePrompt = input.includePrompt !== false;
  const title = skill.label.trim();
  const id = skill.id?.trim() || title;
  const prompts = (skill.prompts ?? []).map((prompt) => prompt.text.trim()).filter(Boolean);
  const outline = skill.kind === 'outline';
  const header = skillHeader(id, title, outline, locale);
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
  const parsed = parseHomeSkillDisplay(stripProvideData(raw));
  return homeSessionTitle({
    userText: parsed.visible,
    skillLabel: parsed.skillLabel ?? skillLabel,
  });
}

/** First real user turn in a transcript, for sidebar recovery. */
export function titleFromTranscript(
  messages: Array<{ role?: string; content?: string }>,
  skillLabel?: string,
): string | undefined {
  const first = messages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.trim());
  if (!first?.content) return sanitizeSessionTitle(skillLabel) ?? undefined;
  return sanitizeSessionTitle(titleFromUserMessage(first.content, skillLabel)) ?? undefined;
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

/**
 * Homepage chip. An installed skill is invoked by its directory id.
 * A chip that is not an installed skill sends the example text only.
 */
export function composeHomeCapMessage(input: {
  userText: string;
  cap?: { id: string; label: string; kind?: string; prompts?: { text: string }[] } | null;
  installed: boolean;
  locale?: Locale;
}): string {
  const cap = input.cap;
  const user = input.userText.trim();
  if (!cap) return user;
  if (input.installed && cap.id.trim()) {
    return composeHomeMessage({
      userText: user,
      skill: { id: cap.id.trim(), label: cap.label, kind: cap.kind, prompts: cap.prompts },
      locale: input.locale,
    });
  }
  const locale = input.locale === 'en' ? 'en' : 'zh';
  const lead = (cap.prompts ?? []).map((prompt) => prompt.text.trim()).filter(Boolean)[0] ?? '';
  if (user && lead && user.includes(lead)) return user;
  if (user && lead) return `${lead}\n${extraLine(user, locale)}`;
  return user || lead;
}

/** Name one installed skill on this turn, without a homepage catalog prompt. */
export function composeInstalledSkillMessage(input: {
  userText: string;
  skill?: { id: string; title?: string } | null;
  locale?: Locale;
}): string {
  const id = input.skill?.id.trim() ?? '';
  if (!id) return input.userText.trim();
  return composeHomeMessage({
    userText: input.userText,
    skill: { id, label: input.skill?.title?.trim() || id },
    locale: input.locale,
    includePrompt: false,
  });
}

export function canSubmitHomeMessage(input: {
  userText: string;
  hasAttachments: boolean;
  skill?: { label: string; kind?: string; prompts?: { text: string }[] } | null;
}): boolean {
  return Boolean(composeHomeMessage(input) || input.hasAttachments);
}

function skillHeader(id: string, title: string, outline: boolean, locale: Locale): string {
  const zhName = title && title !== id ? `「${id}」（${title}）` : `「${id}」`;
  const enName = title && title !== id ? `"${id}" (${title})` : `"${id}"`;
  if (locale === 'en') {
    return outline
      ? `Use the skill ${enName} for this task. Give an editable outline first, then write the body after confirmation.`
      : `Use the skill ${enName} for this task.`;
  }
  return outline
    ? `请使用技能${zhName}完成下面的任务。先给出可修改的提纲，确认后再写正文。`
    : `请使用技能${zhName}完成下面的任务。`;
}

function extraLine(user: string, locale: Locale): string {
  return locale === 'en' ? `Additional request: ${user}` : `补充要求：${user}`;
}

/** Bubble view of a home-page send: skill is a tag, not a prose prefix. */
export function parseHomeSkillDisplay(modelText: string): {
  /** Directory id, present when the header also carries a display title. */
  skillId?: string;
  skillLabel?: string;
  visible: string;
} {
  const text = stripSessionTitleTimestamp(modelText);
  if (!text) return { visible: '' };

  const zh = text.match(/^请使用技能「([^」]+)」(?:（([^）]+)）)?完成下面的任务。(?:先给出可修改的提纲，确认后再写正文。)?/);
  const en = text.match(/^Use the skill "([^"]+)"(?: \(([^)]+)\))? for this task\.(?: Give an editable outline first, then write the body after confirmation\.)?/);
  const header = zh ?? en;
  if (!header || header.index !== 0) return { visible: text };

  const quoted = header[1]?.trim();
  const skillLabel = header[2]?.trim() || quoted;
  const skillId = quoted && skillLabel && quoted !== skillLabel ? quoted : undefined;
  const rest = text.slice(header[0].length).replace(/^\n+/, '');
  const extra = rest.match(/(?:^|\n)(?:补充要求：|Additional request: )([\s\S]+)$/);
  const visible = extra ? (extra[1]?.trim() ?? '') : rest.trim();
  return skillId ? { skillId, skillLabel, visible } : { skillLabel, visible };
}

/** Recover the homepage skill tag from a stored user message (reopen / history). */
export function recoverHomeSkill(modelText: string): HomeSkillRef | undefined {
  const parsed = parseHomeSkillDisplay(modelText);
  if (!parsed.skillLabel) return undefined;
  const body = stripSessionTitleTimestamp(modelText);
  const outline = /先给出可修改的提纲|editable outline/i.test(body);
  return {
    id: parsed.skillId ?? parsed.skillLabel,
    label: parsed.skillLabel,
    kind: outline ? 'outline' : 'chat',
  };
}
