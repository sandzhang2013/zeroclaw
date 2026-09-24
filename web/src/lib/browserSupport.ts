/** Feature checks for the dashboard boot banner in `web/index.html`. Keep in sync. */

export function cssSupportsColorMix(
  supports: ((conditionOrProperty: string, value?: string) => boolean) | undefined,
): boolean {
  if (typeof supports !== 'function') return false;
  try {
    return (
      supports('color: color-mix(in srgb, #f00 50%, #00f)') ||
      supports('color', 'color-mix(in srgb, #f00 50%, #00f)') ||
      supports('color: color-mix(in srgb, red 50%, blue)') ||
      supports('color', 'color-mix(in srgb, red 50%, blue)')
    );
  } catch {
    return false;
  }
}

export function installStructuredClonePolyfill(target: {
  structuredClone?: unknown;
  JSON: { parse: (text: string) => unknown; stringify: (value: unknown) => string };
}): boolean {
  if (typeof target.structuredClone === 'function') return true;
  try {
    target.structuredClone = (value: unknown) => target.JSON.parse(target.JSON.stringify(value));
    return typeof target.structuredClone === 'function';
  } catch {
    return false;
  }
}
