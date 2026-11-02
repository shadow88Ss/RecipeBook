// Layer 13A.1 — suggesting a Food for each imported ingredient line.
//
// A suggestion is only a proposal. It is stored as `needs_confirmation`
// (never `matched`), so the nutrition engine does not count it
// (recipe.nutrition.ts: food_needs_confirmation) until the user confirms or
// replaces it (Master §18: low-confidence matches never count toward
// totals). Nothing here estimates a nutrient value.
//
// The search term is the ingredient line without its amount, unit,
// parenthetical notes, preparation words and anything after the first comma
// ("2 cups finely chopped fresh spinach, washed" -> "spinach"). The term goes
// through the same search_foods() the Food search uses, as the caller.

import type { ScopedDbClient } from '../../lib/scopedDb';
import { localeFallbackChain } from '../foods/locale';
import { normalizeSearchText } from '../recipes/recipe.schemas';

/** Recorded with the extraction so a suggestion can be traced to how it was made. */
export const FOOD_SUGGESTION_METHOD = 'search_foods_term_v1';

export interface FoodSuggestion {
  food_id: string;
  /** The Food's display name for the user, falling back to its canonical name. */
  name: string;
  match_kind: 'exact' | 'prefix' | 'contains';
  /** How closely the search term matched; never a claim the food is right. */
  confidence: number;
  /** The term that was searched, so the user can see why. */
  term: string;
}

const MEASURE_WORDS = new Set([
  'g', 'gram', 'grams', 'kg', 'kgs', 'kilogram', 'kilograms', 'mg', 'oz', 'ounce', 'ounces', 'lb', 'lbs', 'pound', 'pounds',
  'ml', 'millilitre', 'millilitres', 'milliliter', 'milliliters', 'l', 'litre', 'litres', 'liter', 'liters', 'cl', 'dl',
  'cup', 'cups', 'c', 'tbsp', 'tbs', 'tbl', 'tablespoon', 'tablespoons', 'tsp', 'teaspoon', 'teaspoons', 'fl', 'pint', 'pints', 'pt',
  'quart', 'quarts', 'qt', 'gallon', 'gallons', 'can', 'cans', 'tin', 'tins', 'jar', 'jars', 'packet', 'packets', 'package', 'packages',
  'pkg', 'bag', 'bags', 'box', 'boxes', 'bunch', 'bunches', 'clove', 'cloves', 'head', 'heads', 'stalk', 'stalks', 'sprig', 'sprigs',
  'slice', 'slices', 'piece', 'pieces', 'pinch', 'pinches', 'dash', 'dashes', 'handful', 'handfuls', 'stick', 'sticks', 'knob',
]);

const PREPARATION_WORDS = new Set([
  'a', 'an', 'of', 'the', 'about', 'approx', 'approximately', 'plus', 'extra', 'more', 'some', 'few', 'optional', 'heaped', 'heaping',
  'level', 'scant', 'generous', 'large', 'medium', 'small', 'big', 'fresh', 'freshly', 'chopped', 'finely', 'roughly', 'coarsely',
  'thinly', 'thickly', 'minced', 'diced', 'sliced', 'grated', 'shredded', 'crushed', 'peeled', 'trimmed', 'halved', 'quartered',
  'beaten', 'melted', 'softened', 'room', 'temperature', 'cold', 'warm', 'hot', 'packed', 'lightly', 'firmly', 'sifted', 'drained',
  'rinsed', 'washed', 'divided', 'to', 'taste', 'for', 'serving', 'garnish', 'and', 'or',
]);

/** The food part of an ingredient line, lower-cased; empty when nothing is left. */
export function foodSearchTerm(line: string): string {
  let text = normalizeSearchText(line).replace(/⁄/g, '/');
  text = text.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ');
  text = text.split(/[,;]| - | – /)[0] ?? '';
  const words = text
    .replace(/[^\p{L}\p{N}\s'/.-]/gu, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[.'-]+|[.'-]+$/g, ''))
    .filter(Boolean)
    // amounts glued or not: "200g", "1/2", "½", "1.5", "2-3", "x2"
    .filter((w) => !/^(?:x?\d+(?:[.,/-]\d+)*(?:[a-zµ]{1,3})?|[¼-¾⅐-⅞]+|x)$/u.test(w))
    .filter((w) => !MEASURE_WORDS.has(w) && !PREPARATION_WORDS.has(w));
  return words.join(' ').slice(0, 60).trim();
}

interface SearchRow {
  food_id: string;
  canonical_name: string;
  display_name: string | null;
  match_rank: number;
  matched_alias_source: string | null;
}

const KINDS = ['exact', 'prefix', 'contains'] as const;
const KIND_CONFIDENCE = { exact: 0.8, prefix: 0.6, contains: 0.45 } as const;
/** Searching only the last word ("chicken thighs" -> "thighs") is a weaker signal. */
const HEAD_WORD_FACTOR = 0.75;
/** An alias that was itself only AI-matched needs its own confirmation. */
const AI_ALIAS_FACTOR = 0.7;

export async function suggestFood(db: ScopedDbClient, line: string, locale = 'en'): Promise<FoodSuggestion | null> {
  const term = foodSearchTerm(line);
  if (term.length < 2) return null;
  const attempts: Array<{ query: string; factor: number }> = [{ query: term, factor: 1 }];
  const words = term.split(' ');
  if (words.length > 1) {
    const singular = (w: string) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
    attempts.push({ query: words.map(singular).join(' '), factor: 1 });
    attempts.push({ query: singular(words[words.length - 1] ?? ''), factor: HEAD_WORD_FACTOR });
  } else if (term.length > 3 && term.endsWith('s') && !term.endsWith('ss')) {
    attempts.push({ query: term.slice(0, -1), factor: 1 });
  }
  const tried = new Set<string>();
  for (const attempt of attempts) {
    if (attempt.query.length < 2 || tried.has(attempt.query)) continue;
    tried.add(attempt.query);
    const rows = await db.rpcRows<SearchRow>('search_foods', { p_query: attempt.query, p_locales: localeFallbackChain(locale), p_limit: 5 });
    const best = rows[0];
    if (!best) continue;
    const kind = KINDS[best.match_rank] ?? 'contains';
    const confidence = KIND_CONFIDENCE[kind] * attempt.factor * (best.matched_alias_source === 'ai_matched' ? AI_ALIAS_FACTOR : 1);
    return { food_id: best.food_id, name: best.display_name ?? best.canonical_name, match_kind: kind, confidence: Math.round(confidence * 100) / 100, term: attempt.query };
  }
  return null;
}

/** Suggestions for every line, a few searches at a time. A failed search
 * leaves that line without a suggestion; it never fails the import. */
export async function suggestFoods(db: ScopedDbClient, lines: readonly string[], concurrency = 4): Promise<Array<FoodSuggestion | null>> {
  const results: Array<FoodSuggestion | null> = new Array(lines.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < lines.length) {
      const index = next;
      next += 1;
      results[index] = await suggestFood(db, lines[index] ?? '').catch(() => null);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, lines.length) }, worker));
  return results;
}
