// Layer 5A — locale handling for FoodAlias (Master §13.2, Data Model §13).
//
// Accepts the BCP 47 subset the food data uses: language[-Script][-REGION]
// ("en", "ar-AE", "zh-Hant-TW", "es-419"). Extensions/private-use subtags
// are rejected rather than silently dropped. Lookup follows BCP 47 / RFC
// 4647 "lookup" truncation, then falls back to the platform default 'en':
//   ar-AE      -> ar-AE, ar, en
//   zh-Hant-TW -> zh-Hant-TW, zh-Hant, zh, en

export const DEFAULT_LOCALE = 'en';

const LOCALE_PATTERN = /^([A-Za-z]{2,3})(?:-([A-Za-z]{4}))?(?:-([A-Za-z]{2}|\d{3}))?$/;
const REGION_PATTERN = /^(?:[A-Za-z]{2}|\d{3})$/;

/** Canonical casing ("EN-ae" -> "en-AE"), or null if not a supported tag. */
export function canonicalizeLocale(input: string): string | null {
  const match = LOCALE_PATTERN.exec(input.trim());
  if (!match) return null;
  const [, language = '', script, region] = match;
  let tag = language.toLowerCase();
  if (script) tag += `-${script[0]?.toUpperCase()}${script.slice(1).toLowerCase()}`;
  if (region) tag += `-${region.toUpperCase()}`;
  return tag;
}

export function localeFallbackChain(canonicalLocale: string): string[] {
  const parts = canonicalLocale.split('-');
  const chain: string[] = [];
  for (let i = parts.length; i > 0; i -= 1) {
    chain.push(parts.slice(0, i).join('-'));
  }
  if (!chain.includes(DEFAULT_LOCALE)) chain.push(DEFAULT_LOCALE);
  return chain;
}

/** The region subtag of a canonical locale ("ar-AE" -> "AE"), if any. */
export function regionOfLocale(canonicalLocale: string): string | null {
  const last = canonicalLocale.split('-').slice(1).pop();
  return last && REGION_PATTERN.test(last) ? last.toUpperCase() : null;
}

export function canonicalizeRegion(input: string): string | null {
  const trimmed = input.trim();
  return REGION_PATTERN.test(trimmed) ? trimmed.toUpperCase() : null;
}

/** Rank of a stored alias locale against a caller's chain: position in the
 * chain, then same-language-other-region, then anything else. Mirrors the
 * ranking inside the search_foods() SQL function so list and detail
 * endpoints order aliases identically. */
export function localeRank(aliasLocale: string, chain: readonly string[]): number {
  const lowerChain = chain.map((l) => l.toLowerCase());
  const index = lowerChain.indexOf(aliasLocale.toLowerCase());
  if (index !== -1) return index + 1;
  const language = (chain[0] ?? DEFAULT_LOCALE).split('-')[0]?.toLowerCase();
  return aliasLocale.split('-')[0]?.toLowerCase() === language ? chain.length + 1 : chain.length + 2;
}

/** Search-term normalization applied before the term reaches SQL:
 * Unicode NFKC (so full-width/compatibility forms match), trimmed,
 * internal whitespace collapsed, lower-cased. */
export function normalizeSearchTerm(input: string): string {
  return input.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}
