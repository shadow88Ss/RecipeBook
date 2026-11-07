// Layer 13B — turning an ingredient line's amount into one the nutrition
// engine can calculate, using the chosen Food's own servings.
//
// Pure: no I/O. The Food's servings are its FoodServing rows (for USDA foods,
// USDA's own measured portions: "1 cup, chopped" = 30 g of spinach, "1 large"
// = 50 g of egg, "1 tbsp" = 13.5 g of olive oil). Those are ingredient-
// specific weights, not a generic density, which is what makes a cup of
// flour and a cup of spinach come out right.
//
//   "200 g", "1.5 kg", "2 lb"     -> quantity + unit, exactly as written;
//   "250 ml", "1 l"               -> the Food's volume serving, scaled by
//                                    exact US-customary factors (a USDA cup
//                                    is a US cup);
//   "2 cups", "1 tbsp", "1 tsp"   -> the Food's matching volume serving. The
//                                    measuring system is not stated, so the
//                                    US measure is assumed and recorded
//                                    (`us_measure`) for the user to check;
//   "2 eggs", "3 cloves garlic",
//   "1 large onion", "10 almonds" -> the Food's count serving of that word or
//                                    size; with no size given, medium is
//                                    assumed and recorded (`size_assumed`);
//   "1 (14 oz) can tomatoes"      -> the stated package size (14 oz each);
//   ranges, "to taste", "a pinch" -> nothing (the line stays uncounted).
//
// Nothing is guessed beyond those recorded assumptions; with no usable
// serving the line simply gets no amount.

import { resolveUnit, UNITS } from '../conversion/units';
import { readLeadingAmount } from './ingredientLine';
import { singular } from './foodMatch';

export interface ServingOption {
  id: string;
  serving_description: string;
  canonical_quantity: number;
  canonical_unit: string;
}

export type AmountAssumption =
  /** "cup"/"tbsp"/"tsp" read as US measures. */
  | 'us_measure'
  /** No size stated; the medium (or only) size was used. */
  | 'size_assumed'
  /** The Food has no serving of the line's measure; another volume measure
   * of the same Food was scaled to it. */
  | 'measure_converted';

export interface ProposedAmount {
  quantity: number;
  unit?: string;
  serving_id?: string;
  serving_description?: string;
  /** About how much this is, in grams, for display; null when unknown. */
  grams: number | null;
  method: 'stated_unit' | 'food_serving';
  assumptions: AmountAssumption[];
}

type Kind = 'mass' | 'volume' | 'count';

interface ServingShape {
  serving: ServingOption;
  amount: number;
  kind: Kind;
  /** For volume servings: the US unit code. */
  code: string | null;
  /** For count servings: the singular count word ("large", "clove", "almond"). */
  word: string;
  modifiers: string[];
}

const MEASURE_CODE: Record<string, string> = {
  cup: 'cup_us', cups: 'cup_us', c: 'cup_us',
  tbsp: 'tbsp_us', tbs: 'tbsp_us', tbl: 'tbsp_us', tablespoon: 'tbsp_us', tablespoons: 'tbsp_us',
  tsp: 'tsp_us', teaspoon: 'tsp_us', teaspoons: 'tsp_us',
  'fl oz': 'fl_oz_us', 'fluid ounce': 'fl_oz_us', 'fluid ounces': 'fl_oz_us', floz: 'fl_oz_us',
  pint: 'pint_us', pints: 'pint_us', pt: 'pint_us',
  quart: 'quart_us', quarts: 'quart_us', qt: 'quart_us',
  gallon: 'gallon_us', gallons: 'gallon_us', gal: 'gallon_us',
};

const SIZES = ['extra large', 'jumbo', 'large', 'medium', 'small'] as const;
const DEFAULT_SIZE_ORDER = ['medium', 'large', 'small'];
/** Recipes are written for large eggs (US, UK and Australian convention). */
const EGG_SIZE_ORDER = ['large', 'medium', 'small'];
/** Count words a recipe never means when it gives a bare number. */
const NOT_A_COUNT = new Set(['serving', 'nlea', 'package', 'container', 'oz', 'lb', 'g', 'portion']);

const factor = (code: string): number => Number(UNITS.get(code)?.factor ?? NaN);
const tidy = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\s-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** "1 cup, chopped" / "0.5 cup" / "1 large" / "1 medium (2-3/4" dia)" / "1 oz". */
export function servingShape(serving: ServingOption): ServingShape | null {
  const lead = readLeadingAmount(serving.serving_description);
  const amount = lead?.quantity ?? 1;
  const rest = (lead ? lead.rest : serving.serving_description).toLowerCase();
  const [main = '', ...after] = rest.split(',');
  const mainNoParens = main.replace(/\([^)]*\)/g, ' ').trim();
  const modifiers = words([...after].join(' '));
  const mainWords = words(mainNoParens);
  const two = mainWords.slice(0, 2).join(' ');
  const first = mainWords[0] ?? '';
  const code = MEASURE_CODE[two] ?? MEASURE_CODE[first] ?? null;
  if (code) return { serving, amount, kind: 'volume', code, word: '', modifiers: [...modifiers, ...mainWords.slice(two in MEASURE_CODE ? 2 : 1)] };
  const unit = resolveUnit(first);
  if (unit.ok) return { serving, amount, kind: unit.unit.dimension, code: unit.unit.code, word: '', modifiers };
  const size = SIZES.find((s) => mainNoParens.startsWith(s));
  if (size) return { serving, amount, kind: 'count', code: null, word: size, modifiers };
  if (!first) return null;
  return { serving, amount, kind: 'count', code: null, word: singular(first), modifiers: [...modifiers, ...mainWords.slice(1)] };
}

function grams(shape: ServingShape, servings: number): number | null {
  return shape.serving.canonical_unit === 'g' ? tidy(servings * shape.serving.canonical_quantity) : null;
}

function bestVolumeServing(shapes: readonly ServingShape[], code: string, lineWords: readonly string[]): ServingShape | null {
  const volumes = shapes.filter((s) => s.kind === 'volume' && s.code && s.serving.canonical_unit === 'g');
  let best: { shape: ServingShape; score: number } | null = null;
  for (const shape of volumes) {
    let score = shape.code === code ? 2 : 0;
    for (const m of shape.modifiers) score += lineWords.includes(m) ? 1 : -0.5;
    // On a tie, the larger reference measure (a cup over a teaspoon) is the more precise weight.
    const size = shape.amount * factor(shape.code!);
    if (!best || score > best.score || (score === best.score && size > best.shape.amount * factor(best.shape.code!))) best = { shape, score };
  }
  return best?.shape ?? null;
}

function fromVolume(ml: number, code: string, shapes: readonly ServingShape[], lineWords: readonly string[], assumptions: AmountAssumption[]): ProposedAmount | null {
  const shape = bestVolumeServing(shapes, code, lineWords);
  if (!shape?.code) return null;
  const servings = tidy(ml / (shape.amount * factor(shape.code)));
  if (!(servings > 0)) return null;
  const all = shape.code === code ? assumptions : [...assumptions, 'measure_converted' as const];
  return { quantity: servings, serving_id: shape.serving.id, serving_description: shape.serving.serving_description, grams: grams(shape, servings), method: 'food_serving', assumptions: all };
}

/** Words that name a measure: if the Food has no serving of it, the line is
 * not counted rather than read as some other size. */
const COUNT_MEASURES = new Set(['clove', 'slice', 'stalk', 'sprig', 'piece', 'head', 'bunch', 'stick', 'pat', 'leaf', 'can', 'tin', 'jar', 'packet', 'package', 'bag', 'box', 'handful', 'pinch', 'dash', 'knob', 'fillet', 'breast', 'thigh', 'drumstick', 'wedge', 'sheet', 'cube', 'strip', 'rasher', 'link']);
const GENERIC_COUNTS = new Set(['whole', 'fruit', 'item', 'unit']);

function fromCount(count: number, rest: string, shapes: readonly ServingShape[], sizeOrder: readonly string[]): ProposedAmount | null {
  const counts = shapes.filter((s) => s.kind === 'count' && !NOT_A_COUNT.has(s.word));
  if (!counts.length) return null;
  const restWords = words(rest.replace(/\([^)]*\)/g, ' '));
  const restText = ` ${restWords.join(' ')} `;
  const singulars = restWords.map(singular);
  const first = singulars[0] ?? '';
  const isSize = (w: string) => (SIZES as readonly string[]).includes(w);
  const pick = (shape: ServingShape, assumptions: AmountAssumption[]): ProposedAmount => {
    const servings = tidy(count / shape.amount);
    return { quantity: servings, serving_id: shape.serving.id, serving_description: shape.serving.serving_description, grams: grams(shape, servings), method: 'food_serving', assumptions };
  };

  const named = counts.find((s) => !isSize(s.word) && s.word === first);
  if (named) return pick(named, []);
  const statedSize = SIZES.find((size) => restText.includes(` ${size} `));
  if (statedSize) {
    const sized = counts.find((s) => s.word === statedSize);
    return sized ? pick(sized, []) : null;
  }
  if (COUNT_MEASURES.has(first)) return null;
  const sized = counts.filter((s) => isSize(s.word));
  if (sized.length) {
    const chosen = sizeOrder.map((size) => sized.find((s) => s.word === size)).find((s): s is ServingShape => !!s) ?? sized[0]!;
    return pick(chosen, sized.length > 1 ? ['size_assumed'] : []);
  }
  const mentioned = counts.find((s) => !isSize(s.word) && singulars.includes(s.word));
  if (mentioned) return pick(mentioned, []);
  const generic = counts.find((s) => GENERIC_COUNTS.has(s.word));
  return generic ? pick(generic, ['size_assumed']) : null;
}

/** `foodName` only picks the default size: recipes mean large eggs. */
export function proposeAmount(line: string, servings: readonly ServingOption[], foodName = ''): ProposedAmount | null {
  const lead = readLeadingAmount(line);
  if (!lead) return null;
  let quantity = lead.quantity;
  let rest = lead.rest;

  // "1 (14 oz) can tomatoes", "2 (400 g) tins": the stated package size.
  const pack = /^\(\s*(\d+(?:[.,]\d+)?)\s*-?\s*([a-zA-Z. ]+?)\s*\)\s*(.*)$/.exec(rest);
  if (pack?.[1] && pack[2]) {
    const unit = resolveUnit(pack[2].replace(/\.$/, '').trim());
    if (unit.ok) {
      quantity = tidy(quantity * Number(pack[1].replace(',', '.')));
      rest = `${unit.unit.code} ${pack[3] ?? ''}`;
    }
  }

  const shapes = servings.map(servingShape).filter((s): s is ServingShape => s !== null);
  const restWords = words(rest);
  const lineWords = words(line);
  const glued = /^([a-zA-Zµ]+)\b/.exec(rest)?.[1] ?? '';
  const candidates = [restWords.slice(0, 2).join(' '), restWords[0] ?? '', glued].filter(Boolean);

  for (const candidate of candidates) {
    const usCode = MEASURE_CODE[candidate];
    const resolution = resolveUnit(candidate.replace(/\.$/, ''));
    if (resolution.ok) {
      const unit = resolution.unit;
      if (unit.dimension === 'mass') {
        return { quantity: tidy(quantity), unit: unit.code, grams: tidy(quantity * factor(unit.code)), method: 'stated_unit', assumptions: [] };
      }
      const ml = quantity * factor(unit.code);
      // An exact metric volume: switching to the Food's cup or spoon is exact arithmetic, not an assumption.
      const viaServing = fromVolume(ml, unit.code, shapes, lineWords, []);
      if (viaServing) return { ...viaServing, assumptions: viaServing.assumptions.filter((a) => a !== 'measure_converted') };
      return { quantity: tidy(quantity), unit: unit.code, grams: null, method: 'stated_unit', assumptions: [] };
    }
    if (usCode) {
      return fromVolume(quantity * factor(usCode), usCode, shapes, lineWords, ['us_measure']);
    }
  }
  const sizeOrder = /^eggs?\b/i.test(foodName.trim()) ? EGG_SIZE_ORDER : DEFAULT_SIZE_ORDER;
  return fromCount(quantity, rest, shapes, sizeOrder);
}
