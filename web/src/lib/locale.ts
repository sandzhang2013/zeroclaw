/** UI locales exposed in the dashboard language picker. */
export type Locale = 'zh' | 'en';

/** Unsupported or empty values fall back to Chinese. */
export function resolveStoredLocale(value: string | null | undefined): Locale {
  return value === 'en' || value === 'zh' ? value : 'zh';
}
