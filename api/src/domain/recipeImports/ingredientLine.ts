// Layer 13A — reading the amount at the start of an imported ingredient
// line ("1 1/2 cups flour", "200g butter", "2 eggs").
//
// Deterministic and conservative. The raw line is always kept as the
// ingredient text; this only fills quantity/unit when they are certain:
//   - a unit the registry resolves to exactly one code -> quantity + unit;
//   - an ambiguous measure (cup, tbsp, tsp, ...)        -> neither: "2" with
//     no unit would read as a count of 2, which is wrong. The user picks the
//     measurement system when reviewing (units.ts: ambiguous measures are
//     never resolved to a default);
//   - no unit word at all ("2 eggs", "3 cloves garlic") -> quantity only,
//     a count, kept for the record and never calculated (recipe.schemas.ts);
//   - a range ("2-3"), "a pinch", "to taste"              -> neither.

import { MAX_CONVERSION_QUANTITY } from '../conversion/conversion.schemas';
import { resolveUnit } from '../conversion/units';

export interface ParsedIngredientAmount {
  quantity?: number;
  unit?: string;
  /** Why quantity/unit were left empty when a number was present. */
  note?: 'ambiguous_unit' | 'range' | 'unparsed';
}

const UNICODE_FRACTIONS: Record<string, number> = {
  '½': 1 / 2, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 1 / 4, '¾': 3 / 4, '⅕': 1 / 5, '⅖': 2 / 5, '⅗': 3 / 5, '⅘': 4 / 5,
  '⅙': 1 / 6, '⅚': 5 / 6, '⅛': 1 / 8, '⅜': 3 / 8, '⅝': 5 / 8, '⅞': 7 / 8,
};
const FRACTION_CHARS = Object.keys(UNICODE_FRACTIONS).join('');

// whole [space] fraction | whole+unicode | fraction | unicode | decimal | whole
const NUMBER = `(?:\\d+\\s+\\d+\\s*/\\s*\\d+|\\d+\\s*[${FRACTION_CHARS}]|\\d+\\s*/\\s*\\d+|[${FRACTION_CHARS}]|\\d+(?:[.,]\\d+)?)`;
const LEADING_AMOUNT = new RegExp(`^(${NUMBER})(?:\\s*(?:-|–|—|to)\\s*(${NUMBER}))?\\s*(.*)$`, 'i');

export function parseNumber(text: string): number | null {
  const t = text.replace(/\s+/g, ' ').trim();
  const mixed = /^(\d+) (\d+) ?\/ ?(\d+)$/.exec(t);
  if (mixed) return fraction(Number(mixed[1]), Number(mixed[2]), Number(mixed[3]));
  const wholeUnicode = new RegExp(`^(\\d+) ?([${FRACTION_CHARS}])$`).exec(t);
  if (wholeUnicode?.[2]) return Number(wholeUnicode[1]) + (UNICODE_FRACTIONS[wholeUnicode[2]] ?? 0);
  const simple = /^(\d+) ?\/ ?(\d+)$/.exec(t);
  if (simple) return fraction(0, Number(simple[1]), Number(simple[2]));
  if (UNICODE_FRACTIONS[t] !== undefined) return UNICODE_FRACTIONS[t];
  if (/^\d+(?:[.,]\d+)?$/.test(t)) return Number(t.replace(',', '.'));
  return null;
}

function fraction(whole: number, numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return whole + numerator / denominator;
}

/** Rounds to 4 decimals so 1/3 is stored as 0.3333, not a float tail. */
function tidy(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function parseIngredientAmount(line: string): ParsedIngredientAmount {
  const text = line.normalize('NFKC').trim();
  // NFKC turns "½" into "1⁄2" (fraction slash); bring that back to "/".
  const normalized = text.replace(/⁄/g, '/');
  const match = LEADING_AMOUNT.exec(normalized);
  if (!match?.[1]) return {};
  const quantity = parseNumber(match[1]);
  if (quantity === null || !(quantity > 0) || quantity > MAX_CONVERSION_QUANTITY) return { note: 'unparsed' };
  if (match[2]) return { note: 'range' };

  const rest = (match[3] ?? '').replace(/^[(]/, '');
  // Two-word measures first ("fl oz", "fluid ounces"), then one word. The
  // word may be glued to the number ("200g") or end with a period ("tbsp.").
  const words = rest.split(/\s+/).filter(Boolean);
  const candidates = [words.slice(0, 2).join(' '), words[0] ?? ''].filter((w) => w.length > 0);
  for (const candidate of candidates) {
    const cleaned = candidate.replace(/[.,;:)]+$/, '');
    if (cleaned.length === 0) continue;
    const resolution = resolveUnit(cleaned);
    if (resolution.ok) return { quantity: tidy(quantity), unit: resolution.unit.code };
    if (resolution.reason === 'ambiguous_unit') return { note: 'ambiguous_unit' };
  }
  return { quantity: tidy(quantity) };
}
