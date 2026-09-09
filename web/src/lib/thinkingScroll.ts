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
