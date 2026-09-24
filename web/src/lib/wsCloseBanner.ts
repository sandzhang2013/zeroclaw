/** Copy for an unexpected WebSocket drop. Keep the scary config hint off the
 * auto-reconnect path — production idle timeouts arrive as close 1006. */

export const WS_RECONNECT_GIVE_UP_MS = 20_000;

export function isNormalWsClose(code: number): boolean {
  return code === 1000 || code === 1001;
}

export function wsDropBanner(
  code: number,
  phase: 'reconnect' | 'failed',
  t: (key: string) => string,
): string {
  if (isNormalWsClose(code)) return '';
  if (phase === 'reconnect') return t('agent.connection_error');
  return t('agent.reconnect_failed');
}
