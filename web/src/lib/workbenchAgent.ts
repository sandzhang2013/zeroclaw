/** Map a workbench URL segment onto a configured agent alias.
 *
 * `/workbench/deepseek` is a product path, not a second agent. Config
 * `[agents.*]` stays the source of truth: use the requested name when it
 * exists, otherwise `default`, otherwise the first configured alias.
 */
export const WORKBENCH_DEFAULT_AGENT = 'default';

export function resolveWorkbenchAgentAlias(
  requested: string | undefined,
  configured: readonly string[],
): string {
  const want = requested?.trim();
  if (want && configured.includes(want)) return want;
  if (configured.includes(WORKBENCH_DEFAULT_AGENT)) return WORKBENCH_DEFAULT_AGENT;
  if (configured[0]) return configured[0];
  return want || WORKBENCH_DEFAULT_AGENT;
}
