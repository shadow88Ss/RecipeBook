// Layer 12A §34–35 — localization and RTL readiness.
//
// Only English ships in the alpha. `t` looks strings up by key with {{param}}
// interpolation, and numbers are formatted for the device locale. Screens use
// start/end (never left/right) spacing so an RTL language can be added later.

import { getLocales } from 'expo-localization';

import { en, type MessageKey } from './en';

export type { MessageKey } from './en';

const catalogues: Record<string, Partial<Record<MessageKey, string>>> = { en };

function deviceLocale(): { tag: string; language: string; rtl: boolean } {
  try {
    const [first] = getLocales();
    return { tag: first.languageTag, language: first.languageCode ?? 'en', rtl: first.textDirection === 'rtl' };
  } catch {
    return { tag: 'en', language: 'en', rtl: false };
  }
}

const locale = deviceLocale();

export function t(key: MessageKey, params: Record<string, string | number> = {}): string {
  const template = catalogues[locale.language]?.[key] ?? en[key];
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => (name in params ? String(params[name]) : `{{${name}}}`));
}

/** Plural-aware lookup: `<base>.one` / `<base>.other` by the locale's plural rules (with `count`). */
export function tp(base: string, count: number, params: Record<string, string | number> = {}): string {
  let category = 'other';
  try {
    category = new Intl.PluralRules(locale.tag).select(count);
  } catch {
    category = count === 1 ? 'one' : 'other';
  }
  const key = (`${base}.${category}` in en ? `${base}.${category}` : `${base}.other`) as MessageKey;
  return t(key, { count, ...params });
}

/** Formats a server-provided number for display; never changes its value beyond display rounding. */
export function formatNumber(value: number, maximumFractionDigits = 1): string {
  try {
    return new Intl.NumberFormat(locale.tag, { maximumFractionDigits }).format(value);
  } catch {
    return String(value);
  }
}

export function isRTL(): boolean {
  return locale.rtl;
}
