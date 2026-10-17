/** Keep the live transcript open until the answer has visible text.
 *  A whitespace-only chunk would otherwise snap the panel shut and look frozen. */
export function thinkingPanelOpen(streamedAnswer: string): boolean {
  return streamedAnswer.trim().length === 0;
}

/** Whole seconds a thinking stream has been open. At least 1 once it has started. */
export function elapsedThinkingSeconds(startedAtMs: number, endedAtMs: number): number {
  const span = Math.max(0, endedAtMs - startedAtMs);
  return Math.max(1, Math.ceil(span / 1000));
}

export interface ThinkingClock {
  startedAt: number | null;
  /** Frozen whole seconds. Absent while the clock is still running. */
  seconds?: number;
}

export const idleThinkingClock: ThinkingClock = { startedAt: null };

/** First thinking frame starts the clock. Later frames leave it alone. */
export function startThinkingClock(clock: ThinkingClock, now: number): ThinkingClock {
  if (clock.startedAt != null) return clock;
  return { startedAt: now };
}

/** Stop at the first visible answer, or when the turn ends with only reasoning. */
export function freezeThinkingClock(clock: ThinkingClock, now: number): ThinkingClock {
  if (clock.startedAt == null || clock.seconds != null) return clock;
  return {
    startedAt: clock.startedAt,
    seconds: elapsedThinkingSeconds(clock.startedAt, now),
  };
}

/** Pin to the newest thinking line unless the reader scrolled up. */
export function shouldFollowThinkingScroll(input: {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
  thresholdPx?: number;
}): boolean {
  const threshold = input.thresholdPx ?? 24;
  return input.scrollHeight - input.scrollTop - input.clientHeight <= threshold;
}
