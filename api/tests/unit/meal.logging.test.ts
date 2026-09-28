// Layer 7A unit tests — time semantics, snapshots and snapshot aggregation.
// TEST FIXTURES ONLY — illustrative values, not real nutrition data.
import { describe, expect, it } from 'vitest';
import { parseFraction, roundHalfUp, toFractionString, type Rational } from '../../src/domain/conversion/decimal';
import {
  aggregateCoverage,
  aggregateNutrients,
  calculateItem,
  multiplyAggregate,
  type FoodNutritionData,
  type NutrientDefinition,
} from '../../src/domain/nutrition/nutrition.engine';
import { projectAggregateSummary } from '../../src/domain/nutrition/nutritionSummary';
import type { FoodNutrientRecord } from '../../src/domain/nutrition/sourceResolution';
import { calculateRecipeNutrition } from '../../src/domain/recipes/recipe.nutrition';
import { mealCreateSchema, mealItemCorrectSchema, mealItemInputSchema } from '../../src/domain/meals/meal.schemas';
import { aggregateSnapshots, buildFoodSnapshot, buildRecipeSnapshot, readSnapshot } from '../../src/domain/meals/meal.snapshot';
import { isInFuture, isValidTimeZone, localDateOf } from '../../src/domain/meals/meal.time';

const N = {
  energy: { id: 'n-energy', canonical_key: 'energy', unit: 'kcal', role: 'energy' },
  protein: { id: 'n-protein', canonical_key: 'protein', unit: 'g', role: 'macronutrient' },
  iron: { id: 'n-iron', canonical_key: 'iron', unit: 'mg', role: 'micronutrient' },
  vitaminD: { id: 'n-vitamin-d', canonical_key: 'vitamin_d', unit: 'mcg', role: 'micronutrient' },
} satisfies Record<string, NutrientDefinition>;
const VOCAB: NutrientDefinition[] = Object.values(N);

let seq = 0;
const fn = (nutrient: NutrientDefinition, amount: number): FoodNutrientRecord => ({
  id: `fn-${++seq}`,
  nutrient_id: nutrient.id,
  amount,
  basis_quantity: 100,
  basis_unit: 'g',
  source: 'trusted_database',
});
const food = (id: string, nutrients: FoodNutrientRecord[]): FoodNutritionData => ({ food_id: id, canonical_name: `fixture_${id}`, density: null, servings: [], nutrients });

const chicken = food('chicken', [fn(N.energy, 165), fn(N.protein, 31), fn(N.iron, 1), fn(N.vitaminD, 0)]);
const spinach = food('spinach', [fn(N.protein, 2.9), fn(N.iron, 2.7)]);
const num = (v: Rational | null) => (v === null ? null : Number(roundHalfUp(v, 6)));
const find = (agg: ReturnType<typeof aggregateSnapshots>, n: NutrientDefinition) => {
  const e = agg.find((a) => a.nutrient.id === n.id);
  if (!e) throw new Error('missing');
  return e;
};

const foodSnapshot = (f: FoodNutritionData, grams: number) =>
  buildFoodSnapshot(calculateItem(0, { food: f, quantity: grams, amount: { unit: 'g' } }, VOCAB), {
    type: 'food',
    food_id: f.food_id,
    canonical_name: f.canonical_name,
    quantity: grams,
    unit: 'g',
    serving: null,
  });

describe('time semantics', () => {
  it('accepts IANA identifiers and rejects offsets, abbreviations and unknown zones', () => {
    for (const tz of ['Asia/Dubai', 'Europe/London', 'America/New_York', 'America/Argentina/Buenos_Aires', 'UTC']) expect(isValidTimeZone(tz)).toBe(true);
    for (const tz of ['+04:00', 'GMT+4', 'EST', 'Mars/Olympus', '', 'asia dubai']) expect(isValidTimeZone(tz)).toBe(false);
  });

  it('computes the local calendar day of an instant in a zone', () => {
    expect(localDateOf('2026-09-20T22:30:00Z', 'Asia/Dubai')).toBe('2026-09-21');
    expect(localDateOf('2026-09-20T22:30:00Z', 'America/New_York')).toBe('2026-09-20');
    expect(localDateOf('2026-09-20T22:30:00+04:00', 'Asia/Dubai')).toBe('2026-09-20');
  });

  it('treats consumed_at more than the tolerance ahead as future', () => {
    const now = Date.parse('2026-09-20T12:00:00Z');
    expect(isInFuture('2026-09-20T12:04:00Z', now)).toBe(false);
    expect(isInFuture('2026-09-20T12:06:00Z', now)).toBe(true);
  });
});

describe('snapshots', () => {
  it('a food snapshot records source, exact values, completeness, versions and 5B provenance', () => {
    const s = foodSnapshot(chicken, 150);
    expect(s).toMatchObject({ snapshot_version: 'meal-item-snapshot-7a.1', calculation_version: 'nutrition-calculation-5b.1', conversion_version: 'conversion-5a.1' });
    expect(s.source).toMatchObject({ type: 'food', food_id: 'chicken', quantity: 150, unit: 'g' });
    const protein = s.nutrients.find((n) => n.nutrient_key === 'protein');
    expect(protein).toMatchObject({ coverage: 'complete', status: 'resolved', value_exact: '93/2' }); // 46.5 g exactly
    expect(s.nutrients.find((n) => n.nutrient_key === 'vitamin_d')).toMatchObject({ coverage: 'complete', value_exact: '0/1' });
    expect(s.provenance).toMatchObject({ normalized_quantity: { status: 'converted', quantity: 150, unit: 'g' } });
    // survives a JSON round trip (what the database stores)
    expect(readSnapshot(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it('exact fractions round-trip losslessly', () => {
    const third = parseFraction('1/3');
    expect(toFractionString(third)).toBe('1/3');
    expect(() => parseFraction('0.5')).toThrow();
  });

  it('a recipe snapshot = Layer 6A per serving x servings, keeping the recipe completeness', () => {
    const foods = new Map([chicken, spinach].map((f) => [f.food_id, f]));
    const recipe = calculateRecipeNutrition(
      [
        { id: 'i1', sort_order: 1, food_id: 'chicken', food_serving_id: null, quantity: 200, unit: 'g', match_status: 'matched' },
        { id: 'i2', sort_order: 2, food_id: 'spinach', food_serving_id: null, quantity: 100, unit: 'g', match_status: 'matched' },
      ],
      foods,
      VOCAB,
      4,
    );
    const s = buildRecipeSnapshot(recipe, { type: 'recipe', recipe_id: 'r', recipe_version_id: 'v1', version_number: 1, title: 'x', yield_servings: 4, servings_consumed: 1.5 });
    const expected = multiplyAggregate(recipe.per_serving ?? [], 1.5);
    const protein = s.nutrients.find((n) => n.nutrient_key === 'protein');
    // (62 + 2.9) / 4 x 1.5 = 24.3375
    expect(protein).toMatchObject({ coverage: 'complete', value_exact: toFractionString(expected.find((a) => a.nutrient.id === N.protein.id)?.value ?? parseFraction('0/1')) });
    expect(num(parseFraction(protein?.value_exact ?? '0/1'))).toBe(24.3375);
    // energy is known for chicken only -> the recipe item is partial
    expect(s.nutrients.find((n) => n.nutrient_key === 'energy')).toMatchObject({ coverage: 'partial' });
    // vitamin D: chicken 0, spinach unknown -> partial known zero lower bound
    expect(s.nutrients.find((n) => n.nutrient_key === 'vitamin_d')).toMatchObject({ coverage: 'partial', value_exact: '0/1' });
  });

  it('rejects a malformed snapshot instead of treating it as zero', () => {
    expect(() => readSnapshot(null)).toThrow();
    expect(() => readSnapshot({ source: {}, nutrients: [{ nutrient_id: 'x', nutrient_key: 'x', unit: 'g', coverage: 'complete', value_exact: null }] })).toThrow();
  });
});

describe('snapshot aggregation (engine aggregateCoverage)', () => {
  it('sums exact recorded values; complete stays complete', () => {
    const agg = aggregateSnapshots([foodSnapshot(chicken, 150), foodSnapshot(chicken, 50)]);
    expect(find(agg, N.protein)).toMatchObject({ coverage: 'complete', resolved_item_count: 2 });
    expect(num(find(agg, N.protein).value)).toBe(62);
  });

  it('unknown stays unknown (partial / unavailable), never 0; known zero stays zero', () => {
    const agg = aggregateSnapshots([foodSnapshot(chicken, 100), foodSnapshot(spinach, 100)]);
    expect(find(agg, N.energy)).toMatchObject({ coverage: 'partial', missing: [{ index: 1, status: 'no_data' }] });
    expect(num(find(agg, N.energy).value)).toBe(165);
    const spinachOnly = aggregateSnapshots([foodSnapshot(spinach, 100)]);
    expect(find(spinachOnly, N.energy)).toMatchObject({ coverage: 'unavailable', value: null });
    expect(find(aggregateSnapshots([foodSnapshot(chicken, 100)]), N.vitaminD).value?.n).toBe(0n);
  });

  it('a partial item keeps the total partial even when every item has a value', () => {
    const agg = aggregateCoverage(VOCAB, [
      { index: 0, nutrients: [{ nutrient_id: N.energy.id, coverage: 'complete', status: 'resolved', value: parseFraction('100/1'), unit: 'kcal' }] },
      { index: 1, nutrients: [{ nutrient_id: N.energy.id, coverage: 'partial', status: 'resolved', value: parseFraction('50/1'), unit: 'kcal' }] },
    ]);
    const energy = agg.find((a) => a.nutrient.id === N.energy.id);
    expect(energy).toMatchObject({ coverage: 'partial', resolved_item_count: 1, missing: [{ index: 1, status: 'partial_contribution' }] });
    expect(num(energy?.value ?? null)).toBe(150);
  });

  it('matches aggregateNutrients when every item is complete or unavailable', () => {
    const items = [calculateItem(0, { food: chicken, quantity: 120, amount: { unit: 'g' } }, VOCAB), calculateItem(1, { food: spinach, quantity: 80, amount: { unit: 'g' } }, VOCAB)];
    const direct = aggregateNutrients(
      VOCAB,
      items.map((i) => ({ index: i.index, nutrients: i.nutrients.map((n) => ({ nutrient_id: n.nutrient.id, status: n.status, value: n.value, unit: n.unit })) })),
    );
    const viaSnapshots = aggregateSnapshots([foodSnapshot(chicken, 120), foodSnapshot(spinach, 80)]);
    for (const n of VOCAB) {
      const a = direct.find((x) => x.nutrient.id === n.id);
      const b = viaSnapshots.find((x) => x.nutrient.id === n.id);
      expect([b?.coverage, num(b?.value ?? null), b?.resolved_item_count]).toEqual([a?.coverage, num(a?.value ?? null), a?.resolved_item_count]);
    }
  });

  it('never adds incompatible units (kcal vs kJ)', () => {
    const agg = aggregateCoverage(VOCAB, [
      { index: 0, nutrients: [{ nutrient_id: N.energy.id, coverage: 'complete', status: 'resolved', value: parseFraction('100/1'), unit: 'kcal' }] },
      { index: 1, nutrients: [{ nutrient_id: N.energy.id, coverage: 'complete', status: 'resolved', value: parseFraction('400/1'), unit: 'kJ' }] },
    ]);
    expect(agg.find((a) => a.nutrient.id === N.energy.id)).toMatchObject({ coverage: 'partial', missing: [{ index: 1, status: 'incompatible_unit' }] });
  });

  it('the Layer 5C summary projects the snapshot aggregate', () => {
    const agg = aggregateSnapshots([foodSnapshot(chicken, 150)]);
    expect(projectAggregateSummary(agg, 1).protein_g).toMatchObject({ value: 46.5, coverage: 'complete' });
  });
});

describe('request validation', () => {
  const foodItem = { type: 'food', food_id: '00000000-0000-4000-8000-000000000001', quantity: 125, unit: 'g' };

  it('a food item needs exactly one of unit or serving_id; quantity is finite and positive', () => {
    expect(mealItemInputSchema.safeParse(foodItem).success).toBe(true);
    expect(mealItemInputSchema.safeParse({ ...foodItem, unit: undefined }).success).toBe(false);
    expect(mealItemInputSchema.safeParse({ ...foodItem, serving_id: '00000000-0000-4000-8000-000000000002' }).success).toBe(false);
    for (const quantity of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(mealItemInputSchema.safeParse({ ...foodItem, quantity }).success).toBe(false);
    expect(mealItemInputSchema.safeParse({ ...foodItem, unit: 'cup' }).success).toBe(false);
  });

  it('a recipe item needs recipe and version ids and positive servings', () => {
    const recipe = { type: 'recipe', recipe_id: '00000000-0000-4000-8000-000000000001', recipe_version_id: '00000000-0000-4000-8000-000000000002', servings: 1.5 };
    expect(mealItemInputSchema.safeParse(recipe).success).toBe(true);
    expect(mealItemInputSchema.safeParse({ ...recipe, servings: 0 }).success).toBe(false);
    expect(mealItemInputSchema.safeParse({ ...recipe, recipe_version_id: undefined }).success).toBe(false);
  });

  it('meal fields: meal_type enum, calendar date, IANA zone, notes length, timestamps with offset', () => {
    const meal = { meal_type: 'breakfast', logged_date: '2026-09-20', local_timezone: 'Asia/Dubai' };
    expect(mealCreateSchema.safeParse(meal).success).toBe(true);
    expect(mealCreateSchema.safeParse({ ...meal, meal_type: 'pre_workout' }).success).toBe(false);
    expect(mealCreateSchema.safeParse({ ...meal, logged_date: '2026-02-30' }).success).toBe(false);
    expect(mealCreateSchema.safeParse({ ...meal, local_timezone: '+04:00' }).success).toBe(false);
    expect(mealCreateSchema.safeParse({ ...meal, notes: 'x'.repeat(2001) }).success).toBe(false);
    expect(mealCreateSchema.safeParse({ ...meal, consumed_at: '2026-09-20T08:00:00' }).success).toBe(false); // no offset
    expect(mealCreateSchema.parse({ ...meal, notes: '   ' }).notes).toBeNull();
  });

  it('a correction needs a non-blank reason', () => {
    expect(mealItemCorrectSchema.safeParse({ correction_reason: '  ', item: foodItem }).success).toBe(false);
    expect(mealItemCorrectSchema.safeParse({ item: foodItem }).success).toBe(false);
    expect(mealItemCorrectSchema.safeParse({ correction_reason: 'weighed again', item: foodItem }).success).toBe(true);
  });
});
