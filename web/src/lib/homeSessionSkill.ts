import { recoverHomeSkill, type HomeSkillRef } from './homeSend.ts';

export type HomeSkillMessage = {
  role: string;
  content: string;
  ephemeral?: boolean;
  notice?: boolean;
};

/** First real user turn that still names a homepage skill. */
export function inferHomeSkillFromMessages(messages: HomeSkillMessage[]): HomeSkillRef | undefined {
  for (const msg of messages) {
    if (msg.role !== 'user' || msg.ephemeral || msg.notice) continue;
    const recovered = recoverHomeSkill(msg.content);
    if (recovered) return recovered;
  }
  return undefined;
}

/** Composer / follow-up tag: session wins, then history; dismiss hides it. */
export function resolveActiveHomeSkill(input: {
  sessionSkill?: HomeSkillRef;
  inferredSkill?: HomeSkillRef;
  dismissed: boolean;
}): HomeSkillRef | undefined {
  if (input.dismissed) return undefined;
  return input.sessionSkill ?? input.inferredSkill;
}

/** Persist an inferred tag only when the session never stored one. */
export function shouldRestoreHomeSkill(input: {
  dismissed: boolean;
  sessionSkill?: HomeSkillRef;
  inferredSkill?: HomeSkillRef;
}): HomeSkillRef | undefined {
  if (input.dismissed || input.sessionSkill || !input.inferredSkill) return undefined;
  return input.inferredSkill;
}

export function clearSessionHomeSkill<T extends { id: string; homeSkill?: HomeSkillRef }>(
  sessions: T[],
  sessionId: string,
): T[] {
  return sessions.map((item) => (
    item.id === sessionId ? { ...item, homeSkill: undefined } : item
  ));
}

export function restoreSessionHomeSkill<T extends { id: string; homeSkill?: HomeSkillRef }>(
  sessions: T[],
  sessionId: string,
  skill: HomeSkillRef,
): T[] {
  return sessions.map((item) => (
    item.id === sessionId && !item.homeSkill ? { ...item, homeSkill: skill } : item
  ));
}
