// Layer 13A.1 — suggesting a Food for each imported ingredient line.
// Layer 13B — the suggestion is now chosen by what the line says (food
// words, preparation state, qualifiers: foodMatch.ts) from a pool of
// search_foods() candidates, and carries a calculable amount built from the
// chosen Food's own servings (ingredientAmount.ts).
//
// A suggestion is only a proposal. It is stored as `needs_confirmation`
// (never `matched`), so the nutrition engine does not count it
// (recipe.nutrition.ts: food_needs_confirmation) until the user confirms or
// replaces it (Master §18: low-confidence matches never count toward
// totals). `auto` marks a clear match the review form may pre-link; saving
// the reviewed form is the user's confirmation, and the form shows that it
// was matched automatically. Nothing here estimates a nutrient value.
//
// The search term is the ingredient line without its amount, unit,
// parenthetical notes, preparation words and anything after the first comma
// ("2 cups finely chopped fresh spinach, washed" -> "spinach"). Every search
// goes through the same search_foods() the Food search uses, as the caller.

import type { ScopedDbClient } from '../../lib/scopedDb';
import { localeFallbackChain } from '../foods/locale';
import { normalizeSearchText } from '../recipes/recipe.schemas';
import { rankCandidates, termTokens, type MatchReason, type PrepState, type RankedCandidate } from './foodMatch';
import { proposeAmount, type ProposedAmount, type ServingOption } from './ingredientAmount';

/** Recorded with the extraction so a suggestion can be traced to how it was made. */
export const FOOD_SUGGESTION_METHOD = 'ranked_food_match_v2';

export interface SuggestedAlternative {
  food_id: string;
  name: string;
  state: PrepState | null;
  confidence: number;
  amount: ProposedAmount | null;
}

export interface FoodSuggestion {
  food_id: string;
  /** The Food's display name for the user, falling back to its canonical name. */
  name: string;
  match_kind: 'exact' | 'prefix' | 'contains';
  /** How well the Food fits the line (0-1); never a claim the food is right. */
  confidence: number;
  /** The term that was searched, so the user can see why. */
  term: string;
  /** Layer 13B — clear enough to pre-link for review (no blocking reason). */
  auto: boolean;
  /** Why the match is not certain (see foodMatch.ts MatchReason). */
  reasons: MatchReason[];
  /** The state the line asks for, and the chosen Food's state. */
  state: { line: PrepState | null; food: PrepState | null };
  /** A calculable amount from this Food's servings; null when none fits. */
  amount: ProposedAmount | null;
  /** Other close Foods (other states or kinds), best first. */
  alternatives: SuggestedAlternative[];
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

interface ServingRow extends ServingOption {
  food_id: string;
}

const SEARCH_LIMIT = 25;
const MAX_SEARCHES = 5;

export async function suggestFood(db: ScopedDbClient, line: string, locale = 'en'): Promise<FoodSuggestion | null> {
  const term = foodSearchTerm(line);
  if (term.length < 2) return null;
  const tokens = termTokens(term);
  const queries = [...new Set([term, tokens.join(' '), ...[...tokens].sort((a, b) => b.length - a.length)])].filter((q) => q.length >= 3 || q === term).slice(0, MAX_SEARCHES);

  const pool: SearchRow[] = [];
  for (const query of queries) {
    pool.push(...(await db.rpcRows<SearchRow>('search_foods', { p_query: query, p_locales: localeFallbackChain(locale), p_limit: SEARCH_LIMIT })));
  }
  const decision = rankCandidates(
    line,
    term,
    pool.map((row) => ({ food_id: row.food_id, name: row.display_name ?? row.canonical_name, matched_alias_source: row.matched_alias_source })),
  );
  if (!decision) return null;

  const chosen: RankedCandidate[] = [decision.best, ...decision.alternatives];
  const servings = await db.select<ServingRow>('food_serving', {
    columns: 'id, food_id, serving_description, canonical_quantity, canonical_unit',
    in: { food_id: chosen.map((c) => c.food_id) },
  });
  const amountFor = (candidate: RankedCandidate) =>
    proposeAmount(
      line,
      servings.filter((s) => s.food_id === candidate.food_id).map((s) => ({ ...s, canonical_quantity: Number(s.canonical_quantity) })),
      candidate.name,
    );

  return {
    food_id: decision.best.food_id,
    name: decision.best.name,
    match_kind: decision.match_kind,
    confidence: decision.confidence,
    term: tokens.join(' ') || term,
    auto: decision.auto,
    reasons: decision.reasons,
    state: { line: decision.line_state, food: decision.best.state },
    amount: amountFor(decision.best),
    alternatives: decision.alternatives.map((a) => ({ food_id: a.food_id, name: a.name, state: a.state, confidence: a.score, amount: amountFor(a) })),
  };
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
