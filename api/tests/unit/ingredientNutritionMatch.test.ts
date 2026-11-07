// Layer 13B — choosing Foods and amounts for imported ingredient lines.
// Candidate names are real USDA SR Legacy descriptions (the DEV catalog);
// serving weights are USDA SR Legacy portions for those foods.

import { describe, expect, it } from 'vitest';
import { lineState, rankCandidates, singular, termTokens } from '../../src/domain/recipeImports/foodMatch';
import { foodSearchTerm } from '../../src/domain/recipeImports/foodSuggestion';
import { proposeAmount, servingShape, type ServingOption } from '../../src/domain/recipeImports/ingredientAmount';

const NAMES = [
  'Egg, whole, raw, fresh',
  'Egg, white, raw, fresh',
  'Egg, yolk, raw, fresh',
  'Egg, whole, cooked, fried',
  'Egg, whole, cooked, hard-boiled',
  'Rice, white, long-grain, regular, raw, enriched',
  'Rice, white, long-grain, regular, cooked, enriched, with salt',
  "Rice, brown, long-grain, cooked (Includes foods for USDA's Food Distribution Program)",
  'Quinoa, uncooked',
  'Quinoa, cooked',
  'Spinach, raw',
  'Spinach, cooked, boiled, drained, without salt',
  'Oil, olive, salad or cooking',
  'Oil, canola',
  'Tortillas, ready-to-bake or -fry, flour, refrigerated',
  'Wheat flour, white, all-purpose, enriched, bleached',
  'Salt, table',
  'Butter, without salt',
  'Butter, salted',
  'Peanut butter, smooth style, without salt',
  'Spices, pepper, black',
  'Peppers, sweet, red, raw',
  'Peppers, sweet, green, raw',
  'Chickpeas (garbanzo beans, bengal gram), mature seeds, raw',
  'Chickpeas (garbanzo beans, bengal gram), mature seeds, cooked, boiled, without salt',
  'Chickpeas (garbanzo beans, bengal gram), mature seeds, canned, solids and liquids',
  'Nuts, almonds',
  'Nuts, almonds, dry roasted, without salt added',
  'Chicken, broiler or fryers, breast, skinless, boneless, meat only, raw',
  'Chicken, broilers or fryers, breast, meat and skin, raw',
  'Chicken, broilers or fryers, breast, meat only, cooked, roasted',
  'Coriander (cilantro) leaves, raw',
  'Onions, raw',
  'Onions, spring or scallions (includes tops and bulb), raw',
  'Potatoes, flesh and skin, raw',
  "Sweet potato, raw, unprepared (Includes foods for USDA's Food Distribution Program)",
  'Sugars, granulated',
  'Sugars, brown',
  'Spices, oregano, dried',
  'Spices, ginger, ground',
  'Ginger root, raw',
];
const CANDIDATES = NAMES.map((name, i) => ({ food_id: `food-${i}`, name, matched_alias_source: 'trusted_database' }));

function match(line: string) {
  const term = foodSearchTerm(line);
  const tokens = termTokens(term);
  // Roughly what the search pool would contain: any name sharing a word.
  const pool = CANDIDATES.filter((c) => tokens.some((t) => c.name.toLowerCase().includes(t)));
  return rankCandidates(line, term, pool);
}

describe('food matching by food words, state and qualifiers', () => {
  it.each([
    ['2 cups finely chopped fresh spinach, washed', 'Spinach, raw', true],
    ['2 eggs', 'Egg, whole, raw, fresh', true],
    ['2 large egg whites', 'Egg, white, raw, fresh', true],
    ['2 tbsp extra-virgin olive oil', 'Oil, olive, salad or cooking', true],
    ['2 cups all-purpose flour', 'Wheat flour, white, all-purpose, enriched, bleached', true],
    ['1 tsp salt', 'Salt, table', true],
    ['1/2 tsp freshly ground black pepper', 'Spices, pepper, black', true],
    ['1 cup cooked quinoa', 'Quinoa, cooked', true],
    ['1 cup quinoa', 'Quinoa, uncooked', true],
    ['1 can chickpeas, drained', 'Chickpeas (garbanzo beans, bengal gram), mature seeds, canned, solids and liquids', true],
    ['1 cup roasted almonds', 'Nuts, almonds, dry roasted, without salt added', true],
    ['1 cup almonds', 'Nuts, almonds', true],
    ['1 lb boneless skinless chicken breast', 'Chicken, broiler or fryers, breast, skinless, boneless, meat only, raw', true],
    ['1/4 cup fresh cilantro', 'Coriander (cilantro) leaves, raw', true],
    ['2 green onions, sliced', 'Onions, spring or scallions (includes tops and bulb), raw', true],
    ['1/2 cup unsalted butter, melted', 'Butter, without salt', true],
    ['1 cup sugar', 'Sugars, granulated', true],
    ['1/2 cup packed brown sugar', 'Sugars, brown', true],
    ['2 potatoes', 'Potatoes, flesh and skin, raw', true],
    ['1 sweet potato', "Sweet potato, raw, unprepared (Includes foods for USDA's Food Distribution Program)", true],
    ['1 tsp dried oregano', 'Spices, oregano, dried', true],
    ['1 tbsp grated fresh ginger', 'Ginger root, raw', true],
    ['1 tsp ground ginger', 'Spices, ginger, ground', true],
  ])('%s -> %s', (line, name, auto) => {
    const decision = match(line);
    expect(decision?.best.name).toBe(name);
    expect(decision?.auto).toBe(auto);
  });

  it('never picks a food whose head noun the line does not name', () => {
    expect(match('2 cups flour')?.best.name).toBe('Wheat flour, white, all-purpose, enriched, bleached');
    expect(match('1 egg')?.best.name).not.toMatch(/yolk|white/);
    expect(match('2 tbsp olive oil')?.best.name).not.toBe('Oil, canola');
  });

  it('honours the stated preparation state', () => {
    const cooked = match('200 g cooked rice')!;
    expect(cooked.line_state).toBe('cooked');
    expect(cooked.best.state).toBe('cooked');
    // White or brown is not stated: flagged for review, not auto-linked.
    expect(cooked.auto).toBe(false);
    expect(cooked.reasons).toContain('ambiguous');
    expect(match('1 cup cooked chickpeas')?.best.state).toBe('cooked');
  });

  it('records the as-bought assumption when the line names no state', () => {
    const egg = match('2 eggs')!;
    expect(egg.best.state).toBe('raw');
    expect(egg.reasons).toContain('state_assumed');
  });

  it('holds genuinely ambiguous lines for review', () => {
    expect(match('1 cup butter')).toMatchObject({ auto: false, reasons: expect.arrayContaining(['ambiguous']) });
    expect(match('1 red bell pepper')?.best.name).toBe('Peppers, sweet, red, raw');
    expect(match('salt and pepper to taste')?.auto).toBe(false);
  });

  it('flags optional and garnish lines instead of auto-linking them', () => {
    expect(match('1 tsp salt, optional')).toMatchObject({ auto: false, reasons: expect.arrayContaining(['optional_line']) });
  });

  it('gives no suggestion for a food that is not in the catalog', () => {
    expect(match('1 cup water')).toBeNull();
  });

  it('reads states and plurals', () => {
    expect(lineState('1 (14 oz) can diced tomatoes')).toBe('canned');
    expect(lineState('2 cups spinach, washed')).toBeNull();
    expect(lineState('1 cup dry roasted peanuts')).toBe('cooked');
    expect(['tomatoes', 'cherries', 'cloves', 'leaves', 'eggs', 'glass'].map(singular)).toEqual(['tomato', 'cherry', 'clove', 'leaf', 'egg', 'glass']);
  });
});

const s = (id: string, serving_description: string, grams: number): ServingOption => ({ id, serving_description, canonical_quantity: grams, canonical_unit: 'g' });
const SPINACH = [s('sp-cup', '1 cup', 30), s('sp-bunch', '1 bunch', 340), s('sp-leaf', '1 leaf', 10)];
const EGG = [s('e-l', '1 large', 50), s('e-xl', '1 extra large', 56), s('e-m', '1 medium', 44), s('e-s', '1 small', 38), s('e-cup', '1 cup (4.86 large eggs)', 243)];
const OIL = [s('o-tbsp', '1 tbsp', 13.5), s('o-cup', '1 cup', 216), s('o-tsp', '1 tsp', 4.5)];
const ONION = [s('n-l', '1 large', 150), s('n-m', '1 medium (2-1/2" dia)', 110), s('n-s', '1 small', 70), s('n-cup', '1 cup, chopped', 160), s('n-cs', '1 cup, sliced', 115), s('n-slice', '1 slice, large (1/4" thick)', 38)];
const GARLIC = [s('g-cup', '1 cup', 136), s('g-tsp', '1 tsp', 2.8), s('g-clove', '1 clove', 3)];

describe('amounts from the Food’s own servings', () => {
  it('reads USDA serving descriptions', () => {
    expect(servingShape(s('x', '0.5 cup, sliced', 60))).toMatchObject({ amount: 0.5, kind: 'volume', code: 'cup_us', modifiers: ['sliced'] });
    expect(servingShape(s('x', '1 medium (2-1/2" dia)', 110))).toMatchObject({ amount: 1, kind: 'count', word: 'medium' });
    expect(servingShape(s('x', '1 clove', 3))).toMatchObject({ kind: 'count', word: 'clove' });
  });

  it('cups and spoons use the food-specific USDA weight (US measure, recorded)', () => {
    expect(proposeAmount('2 cups finely chopped fresh spinach, washed', SPINACH)).toMatchObject({ quantity: 2, serving_id: 'sp-cup', grams: 60, assumptions: ['us_measure'] });
    expect(proposeAmount('2 tbsp olive oil', OIL)).toMatchObject({ quantity: 2, serving_id: 'o-tbsp', grams: 27 });
    expect(proposeAmount('1/4 cup olive oil', OIL)).toMatchObject({ quantity: 0.25, serving_id: 'o-cup', grams: 54 });
    // A modifier that matches the line wins ("chopped" onion vs "sliced").
    expect(proposeAmount('1 cup chopped onion', ONION)).toMatchObject({ serving_id: 'n-cup', grams: 160 });
  });

  it('a spoon measure the food lacks is scaled from another volume serving', () => {
    expect(proposeAmount('2 tbsp spinach', SPINACH)).toMatchObject({ serving_id: 'sp-cup', quantity: 0.125, grams: 3.75, assumptions: ['us_measure', 'measure_converted'] });
  });

  it('metric volumes convert exactly through a volume serving', () => {
    const result = proposeAmount('250 ml olive oil', OIL)!;
    expect(result).toMatchObject({ serving_id: 'o-cup', assumptions: [] });
    expect(result.grams).toBeCloseTo(228.24, 1);
  });

  it('masses are kept as written', () => {
    expect(proposeAmount('200g butter', [])).toMatchObject({ quantity: 200, unit: 'g', grams: 200, method: 'stated_unit' });
    expect(proposeAmount('1 lb onions', ONION)).toMatchObject({ quantity: 1, unit: 'lb' });
    expect(proposeAmount('1 (14 oz) can diced tomatoes', [])).toMatchObject({ quantity: 14, unit: 'oz' });
    expect(proposeAmount('2 (400 g) tins tomatoes', [])).toMatchObject({ quantity: 800, unit: 'g' });
  });

  it('counts use the named measure or size; a missing size is recorded', () => {
    expect(proposeAmount('3 cloves garlic, minced', GARLIC)).toMatchObject({ quantity: 3, serving_id: 'g-clove', grams: 9, assumptions: [] });
    expect(proposeAmount('1 large onion, diced', ONION)).toMatchObject({ serving_id: 'n-l', grams: 150, assumptions: [] });
    expect(proposeAmount('1 onion', ONION)).toMatchObject({ serving_id: 'n-m', grams: 110, assumptions: ['size_assumed'] });
    expect(proposeAmount('2 eggs', EGG, 'Egg, whole, raw, fresh')).toMatchObject({ serving_id: 'e-l', grams: 100, assumptions: ['size_assumed'] });
    expect(proposeAmount('2 slices onion', ONION)).toMatchObject({ serving_id: 'n-slice', grams: 76 });
  });

  it('leaves the amount empty rather than guessing', () => {
    expect(proposeAmount('salt to taste', OIL)).toBeNull();
    expect(proposeAmount('2-3 eggs', EGG)).toBeNull();
    expect(proposeAmount('2 cloves spinach', SPINACH)).toBeNull();
    expect(proposeAmount('2 cups flour', [])).toBeNull();
  });
});
