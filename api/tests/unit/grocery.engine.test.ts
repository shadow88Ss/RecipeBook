// Layer 9A unit tests — the pure grocery derivation and source fingerprint.
import { describe, expect, it } from 'vitest';
import {
  deriveGroceryRequirements,
  GROCERY_CALCULATION_VERSION,
  sourceFingerprint,
  type GroceryFood,
  type PlannedSource,
  type RecipeVersionData,
} from '../../src/domain/groceries/grocery.engine';
import { groceryGenerateSchema } from '../../src/domain/groceries/grocery.schemas';

const food = (id: string, extra: Partial<GroceryFood> = {}): GroceryFood => ({ food_id: id, canonical_name: `food_${id}`, density: null, servings: [], ...extra });
let seq = 0;
const src = (partial: Partial<PlannedSource>): PlannedSource => {
  seq += 1;
  return {
    meal_plan_id: 'plan',
    meal_plan_day_id: 'day',
    planned_meal_id: 'meal',
    planned_meal_item_id: `item-${String(seq).padStart(3, '0')}`,
    plan_date: '2026-11-02',
    meal_type: 'lunch',
    meal_position: 0,
    item_position: seq,
    item_created_at: '2026-11-01T00:00:00Z',
    food_id: 'f',
    food_serving_id: null,
    unit: 'g',
    recipe_id: null,
    recipe_version_id: null,
    quantity: 100,
    ...partial,
  };
};
const derive = (sources: PlannedSource[], foods: GroceryFood[], versions: RecipeVersionData[] = []) =>
  deriveGroceryRequirements({ sources, foods: new Map(foods.map((f) => [f.food_id, f])), recipeVersions: new Map(versions.map((v) => [v.id, v])) });

const version = (servings: number | null, ingredients: RecipeVersionData['ingredients']): RecipeVersionData => ({ id: 'v1', recipe_id: 'r1', title: 't', version_number: 1, servings, ingredients });
const ing = (partial: Partial<RecipeVersionData['ingredients'][number]>): RecipeVersionData['ingredients'][number] => ({
  id: `ing-${partial.sort_order ?? 1}`,
  food_id: 'f',
  food_serving_id: null,
  raw_ingredient_text: 'x',
  quantity: 100,
  unit: 'g',
  match_status: 'matched',
  sort_order: 1,
  ...partial,
});

describe('normalization and aggregation', () => {
  it('g + kg + lb aggregate exactly in g', () => {
    const r = derive([src({ quantity: 250 }), src({ quantity: 0.75, unit: 'kg' }), src({ quantity: 1, unit: 'lb' })], [food('f')]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ quantity: '1453.59237', unit: 'g', resolution_status: 'resolved' });
    expect(r.calculation_version).toBe(GROCERY_CALCULATION_VERSION);
  });

  it('recipe scaling is exact: 100 g x 1 serving / 3 yield, rounded once at output', () => {
    const r = derive([src({ food_id: null, unit: null, recipe_id: 'r1', recipe_version_id: 'v1', quantity: 1 })], [food('f')], [version(3, [ing({})])]);
    expect(r.items[0]).toMatchObject({ quantity_exact: '100/3', quantity: '33.333333' });
    expect(r.items[0]?.sources[0]).toMatchObject({ scale_factor_exact: '1/3', scaled_quantity_exact: '100/3', planned_servings: 1, recipe_yield: 3 });
  });

  it('density that is not global reference authority is never used; count never merges', () => {
    const f = food('f', { density: { g_per_ml: 1, source: 'user_entered' } });
    const r = derive([src({ quantity: 100 }), src({ quantity: 100, unit: 'ml' })], [f]);
    expect(r.items.map((i) => [i.dimension, i.resolution_status, i.unresolved_reason])).toEqual([
      ['mass', 'incompatible_units', 'mass_volume_density_not_trusted_reference'],
      ['volume', 'incompatible_units', 'mass_volume_density_not_trusted_reference'],
    ]);
    const trusted = derive([src({ quantity: 100 }), src({ quantity: 100, unit: 'ml' })], [food('f', { density: { g_per_ml: 0.5, source: 'trusted_database' } })]);
    expect(trusted.items).toEqual([expect.objectContaining({ dimension: 'mass', quantity: '150', resolution_status: 'resolved' })]);
  });

  it('a serving that is not trusted reference data is unresolved, not converted', () => {
    const f = food('f', { servings: [{ id: 's1', serving_description: '1 piece', region: null, canonical_quantity: 40, canonical_unit: 'g', source: 'ai_matched' }] });
    const r = derive([src({ unit: null, food_serving_id: 's1', quantity: 2 })], [f]);
    expect(r.items[0]).toMatchObject({ resolution_status: 'unresolved_conversion', unresolved_reason: 'serving_not_trusted_reference', quantity: null, food_id: 'f' });
  });

  it('ingredient identity: only matched + readable Food resolves; the text is kept otherwise', () => {
    const v = version(1, [
      ing({ sort_order: 1, match_status: 'needs_confirmation', raw_ingredient_text: 'maybe f' }),
      ing({ sort_order: 2, match_status: 'unmatched', food_id: null, raw_ingredient_text: 'mystery' }),
      ing({ sort_order: 3, food_id: 'gone', raw_ingredient_text: 'deleted food' }),
      ing({ sort_order: 4, quantity: null, unit: null, raw_ingredient_text: 'f to taste' }),
    ]);
    const r = derive([src({ food_id: null, unit: null, recipe_id: 'r1', recipe_version_id: 'v1', quantity: 1 })], [food('f')], [v]);
    expect(r.items.map((i) => [i.display_name, i.resolution_status, i.unresolved_reason])).toEqual([
      ['maybe f', 'unresolved_food', 'ingredient_needs_confirmation'],
      ['mystery', 'unresolved_food', 'ingredient_unmatched'],
      ['deleted food', 'unresolved_food', 'food_reference_missing'],
      ['food_f', 'unresolved_quantity', 'no_quantity'],
    ]);
    expect(r.summary).toMatchObject({ unresolved_item_count: 4, resolved_item_count: 0 });
  });

  it('output is independent of input order (deterministic)', () => {
    const a = src({ quantity: 1, unit: 'kg', plan_date: '2026-11-03' });
    const b = src({ quantity: 5, unit: null, plan_date: '2026-11-02' });
    const c = src({ quantity: 2, unit: 'l', food_id: 'g' });
    const foods = [food('f'), food('g')];
    expect(derive([a, b, c], foods)).toEqual(derive([c, b, a], foods));
  });
});

describe('source fingerprint', () => {
  const s1 = src({ planned_meal_item_id: 'p1', quantity: 150 });
  const s2 = src({ planned_meal_item_id: 'p2', food_id: null, unit: null, recipe_id: 'r1', recipe_version_id: 'v1', quantity: 2 });
  const v = new Map([['v1', version(4, [ing({})])]]);

  it('is order-independent and stable', () => {
    expect(sourceFingerprint([s1, s2], v)).toBe(sourceFingerprint([s2, s1], v));
    expect(sourceFingerprint([s1, s2], v)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes with quantity, unit, membership, servings and ingredient facts', () => {
    const base = sourceFingerprint([s1, s2], v);
    expect(sourceFingerprint([{ ...s1, quantity: 151 }, s2], v)).not.toBe(base);
    expect(sourceFingerprint([{ ...s1, unit: 'kg' }, s2], v)).not.toBe(base);
    expect(sourceFingerprint([s2], v)).not.toBe(base);
    expect(sourceFingerprint([s1, { ...s2, quantity: 3 }], v)).not.toBe(base);
    expect(sourceFingerprint([s1, s2], new Map([['v1', version(4, [ing({ quantity: 101 })])]]))).not.toBe(base);
  });

  it('ignores display-only text (ingredient text, recipe title, meal type, positions)', () => {
    const base = sourceFingerprint([s1, s2], v);
    const renamed = new Map([['v1', { ...version(4, [ing({ raw_ingredient_text: 'renamed' })]), title: 'other title' }]]);
    expect(sourceFingerprint([{ ...s1, meal_type: 'dinner', item_position: 9 }, s2], renamed)).toBe(base);
  });
});

describe('request contract', () => {
  it('generation accepts no client-supplied grocery data (stripped)', () => {
    expect(groceryGenerateSchema.parse({ items: [{ quantity: 1 }], source_fingerprint: 'x' })).toEqual({});
  });
});
