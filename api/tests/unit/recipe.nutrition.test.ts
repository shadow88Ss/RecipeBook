// Layer 6A unit tests — recipe nutrition through the Layer 5B engine, and
// recipe request validation. TEST FIXTURES ONLY — illustrative values, not
// real nutrition data.
import { describe, expect, it } from 'vitest';
import { roundHalfUp, type Rational } from '../../src/domain/conversion/decimal';
import {
  aggregateNutrients,
  calculateItem,
  type FoodNutritionData,
  type NutrientDefinition,
} from '../../src/domain/nutrition/nutrition.engine';
import { projectAggregateSummary } from '../../src/domain/nutrition/nutritionSummary';
import type { FoodNutrientRecord } from '../../src/domain/nutrition/sourceResolution';
import { calculateRecipeNutrition, type IngredientForNutrition } from '../../src/domain/recipes/recipe.nutrition';
import { recipeCreateSchema, recipeIngredientInputSchema, recipePatchSchema } from '../../src/domain/recipes/recipe.schemas';

const N = {
  energy: { id: 'n-energy', canonical_key: 'energy', unit: 'kcal', role: 'energy' },
  protein: { id: 'n-protein', canonical_key: 'protein', unit: 'g', role: 'macronutrient' },
  carbohydrate: { id: 'n-carbohydrate', canonical_key: 'carbohydrate', unit: 'g', role: 'macronutrient' },
  fat: { id: 'n-fat', canonical_key: 'fat', unit: 'g', role: 'macronutrient' },
  fiber: { id: 'n-fiber', canonical_key: 'fiber', unit: 'g', role: 'fiber' },
  iron: { id: 'n-iron', canonical_key: 'iron', unit: 'mg', role: 'micronutrient' },
  vitaminD: { id: 'n-vitamin-d', canonical_key: 'vitamin_d', unit: 'mcg', role: 'micronutrient' },
} satisfies Record<string, NutrientDefinition>;
const VOCAB: NutrientDefinition[] = Object.values(N);

let seq = 0;
const fn = (nutrient: NutrientDefinition, amount: number, basis = 100): FoodNutrientRecord => ({
  id: `fn-${++seq}`,
  nutrient_id: nutrient.id,
  amount,
  basis_quantity: basis,
  basis_unit: 'g',
  source: 'trusted_database',
});
const food = (id: string, nutrients: FoodNutrientRecord[], extra: Partial<FoodNutritionData> = {}): FoodNutritionData => ({
  food_id: id,
  canonical_name: `fixture_${id}`,
  density: null,
  servings: [],
  nutrients,
  ...extra,
});

// 4 foods: protein known for all, iron for 3, vitamin D for none.
const chicken = food('chicken', [fn(N.energy, 165), fn(N.protein, 31), fn(N.fat, 3.6), fn(N.carbohydrate, 0), fn(N.fiber, 0), fn(N.iron, 1)]);
const rice = food('rice', [fn(N.energy, 130), fn(N.protein, 2.7), fn(N.fat, 0.3), fn(N.carbohydrate, 28.2), fn(N.fiber, 0.4), fn(N.iron, 1.2)]);
const broccoli = food('broccoli', [fn(N.energy, 34), fn(N.protein, 2.8), fn(N.fat, 0.4), fn(N.carbohydrate, 6.6), fn(N.fiber, 2.6), fn(N.iron, 0.7)]);
const oil = food('oil', [fn(N.energy, 884), fn(N.protein, 0), fn(N.fat, 100), fn(N.carbohydrate, 0), fn(N.fiber, 0)], {
  servings: [{ id: 'oil-tbsp', serving_description: '1 tbsp', region: null, canonical_quantity: 13.5, canonical_unit: 'g', source: 'trusted_database' }],
});
const macrosOnly = food('macros-only', [fn(N.protein, 10), fn(N.carbohydrate, 20), fn(N.fat, 5)]);
const FOODS = new Map([chicken, rice, broccoli, oil, macrosOnly].map((f) => [f.food_id, f]));

let ing = 0;
const ingredient = (partial: Partial<IngredientForNutrition>): IngredientForNutrition => ({
  id: `ing-${++ing}`,
  sort_order: ing,
  food_id: null,
  food_serving_id: null,
  quantity: null,
  unit: null,
  match_status: 'unmatched',
  ...partial,
});
const matched = (foodId: string, quantity: number, unit: string | null, extra: Partial<IngredientForNutrition> = {}) =>
  ingredient({ food_id: foodId, quantity, unit, match_status: 'matched', ...extra });

const num = (value: Rational | null) => (value === null ? null : Number(roundHalfUp(value, 6)));
const find = (aggregate: ReturnType<typeof calculateRecipeNutrition>['whole_recipe'], n: NutrientDefinition) => {
  const entry = aggregate.find((a) => a.nutrient.id === n.id);
  if (!entry) throw new Error('missing');
  return entry;
};

const stirFry = () => [
  matched('chicken', 125, 'g'),
  matched('rice', 200, 'g'),
  matched('broccoli', 150, 'g'),
  matched('oil', 1, null, { food_serving_id: 'oil-tbsp' }),
];

describe('E/F: whole-recipe and per-serving nutrition', () => {
  it('E: whole-recipe values are the Layer 5B aggregate of the ingredients, deterministically', () => {
    const a = calculateRecipeNutrition(stirFry(), FOODS, VOCAB, 4);
    const b = calculateRecipeNutrition(stirFry(), FOODS, VOCAB, 4);
    // 125 g chicken 206.25 + 200 g rice 260 + 150 g broccoli 51 + 13.5 g oil 119.34
    expect(num(find(a.whole_recipe, N.energy).value)).toBe(636.59);
    expect(num(find(a.whole_recipe, N.protein).value)).toBe(48.35);
    expect(a.whole_recipe.map((n) => num(n.value))).toEqual(b.whole_recipe.map((n) => num(n.value)));
  });

  it('E: is exactly what the engine gives for the same items (no recipe-specific arithmetic)', () => {
    const recipe = calculateRecipeNutrition(stirFry(), FOODS, VOCAB, 4);
    const items = [
      calculateItem(0, { food: chicken, quantity: 125, amount: { unit: 'g' } }, VOCAB),
      calculateItem(1, { food: rice, quantity: 200, amount: { unit: 'g' } }, VOCAB),
      calculateItem(2, { food: broccoli, quantity: 150, amount: { unit: 'g' } }, VOCAB),
      calculateItem(3, { food: oil, quantity: 1, amount: { serving_id: 'oil-tbsp' } }, VOCAB),
    ];
    const engine = aggregateNutrients(
      VOCAB,
      items.map((i) => ({ index: i.index, nutrients: i.nutrients.map((n) => ({ nutrient_id: n.nutrient.id, status: n.status, value: n.value, unit: n.unit })) })),
    );
    expect(recipe.whole_recipe).toEqual(engine);
  });

  it('F: per serving = whole recipe / yield, exactly, for every nutrient', () => {
    const r = calculateRecipeNutrition(stirFry(), FOODS, VOCAB, 4);
    expect(num(find(r.per_serving ?? [], N.energy).value)).toBe(159.1475);
    expect(num(find(r.per_serving ?? [], N.iron).value)).toBe(1.175); // micronutrients use the same division
    const three = calculateRecipeNutrition([matched('chicken', 100, 'g')], FOODS, VOCAB, 3);
    // 31 / 3 = 10.333... exact until output rounding
    expect(num(find(three.per_serving ?? [], N.protein).value)).toBe(10.333333);
  });

  it('F: a one-serving recipe is not assumed — yield is read from the version', () => {
    const r = calculateRecipeNutrition(stirFry(), FOODS, VOCAB, 2.5);
    expect(num(find(r.per_serving ?? [], N.energy).value)).toBe(254.636);
  });

  it('F: no yield -> per-serving is unavailable, whole recipe still reported', () => {
    const r = calculateRecipeNutrition(stirFry(), FOODS, VOCAB, null);
    expect(r.per_serving).toBeNull();
    expect(num(find(r.whole_recipe, N.energy).value)).toBe(636.59);
  });
});

describe('G/H/I/J: completeness, summary and micronutrients', () => {
  it('complete / partial / unavailable per nutrient (protein 4/4, iron 3/4, vitamin D 0/4)', () => {
    const r = calculateRecipeNutrition(stirFry(), FOODS, VOCAB, 4);
    expect(find(r.whole_recipe, N.protein).coverage).toBe('complete');
    expect(find(r.whole_recipe, N.iron)).toMatchObject({ coverage: 'partial', resolved_item_count: 3, item_count: 4 });
    expect(num(find(r.whole_recipe, N.iron).value)).toBe(4.7); // lower bound: 1.25 + 2.4 + 1.05
    expect(find(r.whole_recipe, N.vitaminD)).toMatchObject({ coverage: 'unavailable', value: null });
    // per serving keeps the same coverage
    expect(find(r.per_serving ?? [], N.iron).coverage).toBe('partial');
    expect(find(r.per_serving ?? [], N.vitaminD)).toMatchObject({ coverage: 'unavailable', value: null });
  });

  it('I: an unresolved ingredient keeps totals partial rather than disappearing', () => {
    const r = calculateRecipeNutrition([matched('chicken', 125, 'g'), ingredient({ quantity: 1, unit: 'g' })], FOODS, VOCAB, 2);
    expect(r.ingredients.map((i) => i.status)).toEqual(['calculated', 'food_unmatched']);
    const protein = find(r.whole_recipe, N.protein);
    expect(protein).toMatchObject({ coverage: 'partial', resolved_item_count: 1, item_count: 2 });
    expect(protein.missing).toEqual([{ index: 1, status: 'item_unresolved' }]);
  });

  it('I: only unresolved ingredients -> every nutrient unavailable, null (not 0)', () => {
    const r = calculateRecipeNutrition([ingredient({}), ingredient({ food_id: 'chicken', match_status: 'needs_confirmation', quantity: 1, unit: 'g' })], FOODS, VOCAB, 1);
    expect(r.ingredients.map((i) => i.status)).toEqual(['food_unmatched', 'food_needs_confirmation']);
    for (const n of r.whole_recipe) expect(n).toMatchObject({ coverage: 'unavailable', value: null });
  });

  it('I: every non-calculable ingredient form is reported with its reason', () => {
    const r = calculateRecipeNutrition(
      [
        ingredient({ food_id: 'chicken', match_status: 'matched' }), // "chicken, to taste"
        matched('chicken', 2, null), // "2 chicken" — count without unit/serving
        matched('not-readable', 10, 'g'),
      ],
      FOODS,
      VOCAB,
      1,
    );
    expect(r.ingredients.map((i) => i.status)).toEqual(['quantity_missing', 'unit_missing', 'food_unavailable']);
  });

  it('J: a known zero stays a known zero (not unknown), through per-serving too', () => {
    const r = calculateRecipeNutrition([matched('chicken', 125, 'g'), matched('oil', 10, 'g')], FOODS, VOCAB, 2);
    const carbs = find(r.per_serving ?? [], N.carbohydrate);
    expect(carbs.coverage).toBe('complete');
    expect(carbs.value?.n).toBe(0n);
  });

  it('G: the Layer 5C summary projects the recipe aggregates without recalculating', () => {
    const r = calculateRecipeNutrition(stirFry(), FOODS, VOCAB, 4);
    const whole = projectAggregateSummary(r.whole_recipe, 4);
    const perServing = projectAggregateSummary(r.per_serving ?? [], 4);
    expect(whole.energy_kcal).toMatchObject({ value: 636.59, coverage: 'complete' });
    expect(perServing.energy_kcal).toMatchObject({ value: 159.1475, coverage: 'complete' });
    expect(perServing.fiber_g.value).toBe(num(find(r.per_serving ?? [], N.fiber).value));
  });

  it('no 4/4/9: energy stays unavailable when only macros are known', () => {
    const r = calculateRecipeNutrition([matched('macros-only', 100, 'g')], FOODS, VOCAB, 1);
    expect(find(r.whole_recipe, N.energy)).toMatchObject({ coverage: 'unavailable', value: null });
    expect(num(find(r.whole_recipe, N.protein).value)).toBe(10);
  });

  it('ingredient order follows sort_order, not input order', () => {
    const [first, second] = [matched('chicken', 100, 'g', { sort_order: 2 }), matched('rice', 100, 'g', { sort_order: 1 })];
    const r = calculateRecipeNutrition([first, second], FOODS, VOCAB, 1);
    expect(r.ingredients.map((i) => i.ingredient_id)).toEqual([second.id, first.id]);
  });
});

describe('U/S/R: request validation', () => {
  const base = { title: 'Stir fry', servings: 4, ingredients: [{ text: '125 g chicken', food_id: '00000000-0000-4000-8000-000000000001', quantity: 125, unit: 'g' }] };

  it('S: rejects zero, negative, NaN and Infinity yields', () => {
    for (const servings of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(recipeCreateSchema.safeParse({ ...base, servings }).success).toBe(false);
    }
    expect(recipeCreateSchema.safeParse({ ...base, servings: undefined }).success).toBe(false);
    expect(recipeCreateSchema.safeParse({ ...base, servings: 2.5 }).success).toBe(true);
  });

  it('rejects NaN/Infinity/zero/negative ingredient quantities and unknown or ambiguous units', () => {
    for (const quantity of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(recipeIngredientInputSchema.safeParse({ text: 'x', food_id: base.ingredients[0]?.food_id, quantity, unit: 'g' }).success).toBe(false);
    }
    for (const unit of ['grams', 'cup', 'handful']) {
      expect(recipeIngredientInputSchema.safeParse({ text: 'x', quantity: 1, unit }).success).toBe(false);
    }
    expect(recipeIngredientInputSchema.safeParse({ text: 'x', quantity: 1, unit: 'cup_us' }).success).toBe(true);
  });

  it('amount form rules: unit xor serving, serving needs a food, unit/serving need a quantity', () => {
    const foodId = '00000000-0000-4000-8000-000000000001';
    const servingId = '00000000-0000-4000-8000-000000000002';
    expect(recipeIngredientInputSchema.safeParse({ text: 'x', food_id: foodId, serving_id: servingId, unit: 'g', quantity: 1 }).success).toBe(false);
    expect(recipeIngredientInputSchema.safeParse({ text: 'x', serving_id: servingId, quantity: 1 }).success).toBe(false);
    expect(recipeIngredientInputSchema.safeParse({ text: 'x', unit: 'g' }).success).toBe(false);
    expect(recipeIngredientInputSchema.safeParse({ text: 'salt to taste' }).success).toBe(true);
    expect(recipeIngredientInputSchema.safeParse({ text: '2 eggs', quantity: 2 }).success).toBe(true);
    expect(recipeIngredientInputSchema.safeParse({ text: ' ' }).success).toBe(false);
  });

  it('title, ingredient count and instruction text are validated; server-owned fields are stripped', () => {
    expect(recipeCreateSchema.safeParse({ ...base, title: '  ' }).success).toBe(false);
    expect(recipeCreateSchema.safeParse({ ...base, ingredients: [] }).success).toBe(false);
    expect(recipeCreateSchema.safeParse({ ...base, instructions: [''] }).success).toBe(false);
    const parsed = recipeCreateSchema.parse({ ...base, visibility: 'shared_library', ingredients: [{ ...base.ingredients[0], match_status: 'matched', sort_order: 9 }] });
    expect(parsed).not.toHaveProperty('visibility');
    expect(parsed.ingredients[0]).not.toHaveProperty('match_status');
    expect(parsed.ingredients[0]).not.toHaveProperty('sort_order');
    expect(parsed.instructions).toEqual([]);
  });

  it('PATCH needs at least one content field', () => {
    expect(recipePatchSchema.safeParse({}).success).toBe(false);
    expect(recipePatchSchema.safeParse({ expected_current_version_id: '00000000-0000-4000-8000-000000000001' }).success).toBe(false);
    expect(recipePatchSchema.safeParse({ servings: 6 }).success).toBe(true);
    expect(recipePatchSchema.safeParse({ servings: 0 }).success).toBe(false);
  });
});
