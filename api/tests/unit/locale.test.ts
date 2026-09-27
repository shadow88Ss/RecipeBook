import { describe, expect, it } from 'vitest';
import {
  canonicalizeLocale,
  canonicalizeRegion,
  localeFallbackChain,
  localeRank,
  normalizeSearchTerm,
  regionOfLocale,
} from '../../src/domain/foods/locale';

describe('canonicalizeLocale', () => {
  it('canonicalizes BCP 47 casing', () => {
    expect(canonicalizeLocale('EN')).toBe('en');
    expect(canonicalizeLocale('ar-ae')).toBe('ar-AE');
    expect(canonicalizeLocale('zh-hant-tw')).toBe('zh-Hant-TW');
    expect(canonicalizeLocale('es-419')).toBe('es-419');
  });

  it('rejects malformed tags and unsupported extensions', () => {
    for (const bad of ['', 'e', 'english', 'en_US', 'en-US-x-private', 'en--US', '12']) {
      expect(canonicalizeLocale(bad)).toBeNull();
    }
  });
});

describe('localeFallbackChain', () => {
  it('truncates subtags then falls back to en', () => {
    expect(localeFallbackChain('ar-AE')).toEqual(['ar-AE', 'ar', 'en']);
    expect(localeFallbackChain('zh-Hant-TW')).toEqual(['zh-Hant-TW', 'zh-Hant', 'zh', 'en']);
    expect(localeFallbackChain('en-AE')).toEqual(['en-AE', 'en']);
    expect(localeFallbackChain('en')).toEqual(['en']);
  });
});

describe('localeRank', () => {
  const chain = ['ar-AE', 'ar', 'en'];
  it('ranks the chain in order, then same language, then anything else', () => {
    expect(localeRank('ar-AE', chain)).toBe(1);
    expect(localeRank('ar', chain)).toBe(2);
    expect(localeRank('en', chain)).toBe(3);
    expect(localeRank('ar-SA', chain)).toBe(4);
    expect(localeRank('fr', chain)).toBe(5);
    expect(localeRank('AR-ae', chain)).toBe(1);
  });
});

describe('region helpers', () => {
  it('derives the region subtag from a locale', () => {
    expect(regionOfLocale('ar-AE')).toBe('AE');
    expect(regionOfLocale('es-419')).toBe('419');
    expect(regionOfLocale('zh-Hant')).toBeNull();
    expect(regionOfLocale('en')).toBeNull();
  });

  it('validates region codes', () => {
    expect(canonicalizeRegion('us')).toBe('US');
    expect(canonicalizeRegion('USA')).toBeNull();
  });
});

describe('normalizeSearchTerm', () => {
  it('applies NFKC, trims, collapses whitespace and lower-cases', () => {
    expect(normalizeSearchTerm('  Brown   RICE ')).toBe('brown rice');
    expect(normalizeSearchTerm('ＲＩＣＥ')).toBe('rice');
    expect(normalizeSearchTerm('\t\n')).toBe('');
  });
});
