// Layer 8B unit tests — the pure fulfillment derivation (no database).
import { describe, expect, it } from 'vitest';
import type { MealItemRow } from '../../src/domain/meals/meal.dto';
import type { MealItemSnapshot, SnapshotNutrient } from '../../src/domain/meals/meal.snapshot';
import type { PlannedItemRow } from '../../src/domain/mealPlans/mealPlan.dto';
import {
  compareNutrition,
  compareQuantities,
  countStates,
  deriveItemFulfillment,
  MealItemChains,
  resolveLinks,
  type LinkRow,
  type SkipRow,
} from '../../src/domain/mealPlans/planFulfillment';
import { actualLinkCreateSchema, skipCreateSchema } from '../../src/domain/mealPlans/planFulfillment.schemas';

const FOOD_A = 'food-a';
const FOOD_B = 'food-b';
const TZ = 'Asia/Dubai';
const DATE = '2026-09-10';

const nutrient = (key: string, value: string | null, coverage: SnapshotNutrient['coverage'] = value === null ? 'unavailable' : 'complete'): SnapshotNutrient => ({
  nutrient_id: `n-${key}`,
  nutrient_key: key,
  nutrient_role: 'other',
  unit: 'g',
  coverage,
  status: value === null ? 'no_data' : 'resolved',
  value_exact: value,
});

const foodSnap = (food_id: string, quantity: number, unit: string | null, nutrients: SnapshotNutrient[], extra: Partial<MealItemSnapshot> = {}): MealItemSnapshot => ({
  snapshot_version: 't',
  calculation_version: 't',
  conversion_version: 't',
  source: { type: 'food', food_id, canonical_name: food_id, quantity, unit, serving: null },
  nutrients,
  provenance: { normalized_quantity: { status: 'converted', quantity: unit === 'kg' ? quantity * 1000 : quantity, unit: unit === 'kg' ? 'g' : unit } },
  ...extra,
});

const planned = (partial: Partial<PlannedItemRow> = {}): PlannedItemRow => ({
  id: 'p1',
  planned_meal_id: 'm1',
  profile_id: 'pr',
  food_id: FOOD_A,
  food_serving_id: null,
  unit: 'g',
  recipe_id: null,
  recipe_version_id: null,
  quantity: 100,
  position: 0,
  status: 'confirmed',
  confirmed_at: '2026-09-01T00:00:00Z',
  supersedes_planned_meal_item_id: null,
  superseded_by_planned_meal_item_id: null,
  nutrition_snapshot: null,
  nutrition_calculation_version: 't',
  nutrition_calculated_at: '2026-09-01T00:00:00Z',
  created_at: '2026-09-01T00:00:00Z',
  ...partial,
});

const actual = (id: string, partial: Partial<MealItemRow> & { snapshot?: MealItemSnapshot } = {}): MealItemRow => {
  const { snapshot, ...rest } = partial;
  return {
    id,
    meal_log_id: 'log',
    profile_id: 'pr',
    food_id: FOOD_A,
    food_serving_id: null,
    unit: 'g',
    recipe_version_id: null,
    product_id: null,
    product_label_version_id: null,
    product_serving_id: null,
    logged_via_barcode_id: null,
    quantity: 100,
    status: 'consumed',
    consumed_at: '2026-09-10T08:00:00Z', // 12:00 in Dubai
    status_changed_by_actor_type: 'account',
    corrects_meal_item_id: null,
    superseded_by_meal_item_id: null,
    correction_reason: null,
    nutrition_snapshot: snapshot ?? foodSnap(rest.food_id ?? FOOD_A, rest.quantity ?? 100, 'g', [nutrient('protein', '3/1')]),
    nutrition_calculation_version: 't',
    nutrition_calculated_at: '2026-09-10T08:00:00Z',
    created_at: '2026-09-10T08:00:00Z',
    ...rest,
  };
};

const linkRow = (id: string, meal_item_id: string, relationship_type: LinkRow['relationship_type'] = 'same_item', revoked_at: string | null = null): LinkRow => ({
  id,
  profile_id: 'pr',
  planned_meal_item_id: 'p1',
  meal_item_id,
  relationship_type,
  meal_item_chain_root_id: meal_item_id,
  created_at: `2026-09-10T09:00:0${id.length % 10}Z`,
  revoked_at,
});

const derive = (items: MealItemRow[], links: LinkRow[], skips: SkipRow[] = [], p = planned()) =>
  deriveItemFulfillment({
    item: p,
    plannedSnapshot: foodSnap(FOOD_A, 100, 'g', [nutrient('protein', '3/1'), nutrient('fiber', null)]),
    planDate: DATE,
    timeZone: TZ,
    mealType: 'lunch',
    links,
    skips,
    chains: new MealItemChains(new Map(items.map((i) => [i.id, i]))),
  });

describe('derived fulfillment state', () => {
  it('no links -> unlinked; nothing is compared', () => {
    const f = derive([], []);
    expect(f).toMatchObject({ fulfillment_state: 'unlinked', breakdown: null, nutrition_comparison: null });
  });

  it('an active skip wins; a revoked skip is history only', () => {
    const skip: SkipRow = { id: 's', profile_id: 'pr', planned_meal_item_id: 'p1', reason: null, skipped_at: 'x', revoked_at: null };
    expect(derive([], [], [skip]).fulfillment_state).toBe('skipped');
    const revoked = derive([], [], [{ ...skip, revoked_at: 'y' }]);
    expect(revoked.fulfillment_state).toBe('unlinked');
    expect(revoked.history.revoked_skips).toHaveLength(1);
  });

  it('exact / partial / above on the declared amount', () => {
    expect(derive([actual('a')], [linkRow('l1', 'a')]).fulfillment_state).toBe('fulfilled_exact');
    expect(derive([actual('a', { quantity: 40 })], [linkRow('l1', 'a')]).fulfillment_state).toBe('partial');
    expect(derive([actual('a', { quantity: 60 }), actual('b', { quantity: 60 })], [linkRow('l1', 'a'), linkRow('l22', 'b')]).fulfillment_state).toBe('above_planned_quantity');
  });

  it('revoked links do not contribute', () => {
    const f = derive([actual('a')], [linkRow('l1', 'a', 'same_item', '2026-09-10T10:00:00Z')]);
    expect(f.fulfillment_state).toBe('unlinked');
    expect(f.history.revoked_links).toHaveLength(1);
  });

  it('follows the correction chain to the active record; two links resolving to one record count once', () => {
    const original = actual('a', { superseded_by_meal_item_id: 'b', quantity: 100 });
    const corrected = actual('b', { corrects_meal_item_id: 'a', quantity: 100 });
    const f = derive([original, corrected], [linkRow('l1', 'a'), linkRow('l22', 'b')]);
    expect(f.fulfillment_state).toBe('fulfilled_exact'); // 100, not 200
    expect(f.links.map((l) => [l.active_meal_item_id, l.counted])).toEqual([
      ['b', true],
      ['b', false],
    ]);
  });

  it('identity change by correction is reported and excluded, never converted', () => {
    const original = actual('a', { superseded_by_meal_item_id: 'b' });
    const corrected = actual('b', { corrects_meal_item_id: 'a', food_id: FOOD_B });
    const f = derive([original, corrected], [linkRow('l1', 'a')]);
    expect(f.fulfillment_state).toBe('identity_changed_by_correction');
    expect(f.links[0]).toMatchObject({ relationship_type: 'same_item', link_state: 'identity_changed_by_correction', counted: false });
    expect(f.nutrition_comparison).toBeNull();
  });

  it('a correction that moves consumption to another plan-local day no longer counts', () => {
    const original = actual('a', { superseded_by_meal_item_id: 'b' });
    const corrected = actual('b', { corrects_meal_item_id: 'a', consumed_at: '2026-09-10T21:00:00Z' }); // 01:00 on the 11th in Dubai
    const f = derive([original, corrected], [linkRow('l1', 'a')]);
    expect(f.fulfillment_state).toBe('unlinked');
    expect(f.links[0]?.link_state).toBe('consumed_date_changed_by_correction');
  });

  it('mixed same_item + substitution -> fulfilled_with_substitution with separate breakdowns', () => {
    const f = derive([actual('a', { quantity: 50 }), actual('b', { food_id: FOOD_B, quantity: 80 })], [linkRow('l1', 'a'), linkRow('l22', 'b', 'substitution')]);
    expect(f.fulfillment_state).toBe('fulfilled_with_substitution');
    expect(f.breakdown?.same_item).toMatchObject({ link_count: 1, quantity_comparison: { status: 'below_planned', planned: 100, actual: 50 } });
    expect(f.breakdown?.substitution).toMatchObject({ link_count: 1, actual_meal_item_ids: ['b'] });
  });

  it('countStates covers every state', () => {
    expect(Object.keys(countStates([]))).toHaveLength(8);
  });
});

describe('quantities', () => {
  it('falls back to the normalized quantity when declared units differ, else not comparable', () => {
    const p = foodSnap(FOOD_A, 0.1, 'kg', []);
    expect(compareQuantities(p, [foodSnap(FOOD_A, 100, 'g', [])])).toMatchObject({ status: 'equal', basis: 'normalized_quantity', unit: 'g' });
    const ml = foodSnap(FOOD_A, 100, 'ml', []);
    expect(compareQuantities(p, [ml]).status).toBe('not_comparable');
  });

  it('servings for recipes, exactly (0.1 + 0.2 = 0.3)', () => {
    const recipe = (servings: number): MealItemSnapshot => ({
      ...foodSnap(FOOD_A, 1, 'g', []),
      source: { type: 'recipe', recipe_id: 'r', recipe_version_id: 'v', version_number: 1, title: 't', yield_servings: 4, servings_consumed: servings },
    });
    expect(compareQuantities(recipe(0.3), [recipe(0.1), recipe(0.2)])).toMatchObject({ status: 'equal', basis: 'recipe_servings', actual: 0.3 });
  });
});

describe('nutrition comparison', () => {
  it('signed differences from snapshot values; incomplete data is never a difference', () => {
    const p = foodSnap(FOOD_A, 100, 'g', [nutrient('protein', '3/1'), nutrient('fat', '1/1', 'partial'), nutrient('fiber', null)]);
    const a = foodSnap(FOOD_A, 50, 'g', [nutrient('protein', '3/2'), nutrient('fat', '1/2'), nutrient('fiber', '1/1')]);
    const c = compareNutrition(p, [a]);
    const by = (k: string) => c.nutrients.find((n) => n.nutrient_key === k);
    expect(by('protein')).toMatchObject({ planned_value: 3, actual_value: 1.5, difference: -1.5, difference_status: 'actual_minus_planned' });
    expect(by('fat')).toMatchObject({ difference: null, difference_status: 'not_comparable_incomplete_data' });
    expect(by('fiber')).toMatchObject({ planned_value: null, difference: null });
  });

  it('dedupes links by active record in resolveLinks (earliest link counted)', () => {
    const chains = new MealItemChains(new Map([['a', actual('a')]]));
    const r = resolveLinks([linkRow('l22', 'a'), linkRow('l1', 'a')], planned(), DATE, TZ, chains);
    expect(r.filter((x) => x.counted)).toHaveLength(1);
  });
});

describe('request validation', () => {
  it('only the relationship is accepted; server-derived fields are stripped', () => {
    const parsed = actualLinkCreateSchema.parse({ meal_item_id: '00000000-0000-4000-8000-000000000001', relationship_type: 'same_item', fulfillment_state: 'fulfilled_exact', profile_id: 'x' });
    expect(parsed).toEqual({ meal_item_id: '00000000-0000-4000-8000-000000000001', relationship_type: 'same_item' });
    expect(actualLinkCreateSchema.safeParse({ meal_item_id: '00000000-0000-4000-8000-000000000001', relationship_type: 'exact' }).success).toBe(false);
    expect(skipCreateSchema.safeParse({ reason: 'x'.repeat(501) }).success).toBe(false);
    expect(skipCreateSchema.parse({ reason: '  ' })).toEqual({ reason: null });
  });
});
