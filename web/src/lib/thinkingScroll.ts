/** Keep the live transcript open until the answer has visible text.
 *  A whitespace-only chunk would otherwise snap the panel shut and look frozen. */
export function thinkingPanelOpen(streamedAnswer: string): boolean {
  return streamedAnswer.trim().length === 0;
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
