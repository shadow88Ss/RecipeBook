// Layer 9B unit tests — the pure shopping read model.
import { describe, expect, it } from 'vitest';
import type { FoodConversionData } from '../../src/domain/conversion/conversion.engine';
import { itemShopping, manualShopping, normalizeOwn, normalizeTo, type PurchaseRecord, type StateRecord } from '../../src/domain/groceries/shopping.engine';
import { manualItemSchema, purchaseSchema, userQuantitySchema } from '../../src/domain/groceries/shopping.schemas';

const item = (quantity_exact: string | null, dimension: 'mass' | 'volume' | 'count' | null = 'mass') => ({
  id: 'i1',
  position: 0,
  food_id: quantity_exact ? 'f' : null,
  display_name: 'thing',
  dimension: quantity_exact ? dimension : null,
  quantity_exact,
  resolution_status: quantity_exact ? 'resolved' : 'unresolved_food',
  unresolved_reason: quantity_exact ? null : 'ingredient_unmatched',
});
let n = 0;
const state = (quantity: number, unit: string, revoked = false): StateRecord => ({ id: `s${(n += 1)}`, quantity, unit, note: null, created_at: `2026-11-01T00:00:0${n % 10}Z`, revoked_at: revoked ? 'x' : null });
const buy = (quantity: number | null, unit: string | null, revoked = false): PurchaseRecord => ({ id: `p${(n += 1)}`, quantity, unit, note: null, created_at: 'x', revoked_at: revoked ? 'x' : null });
const noState = { alreadyHave: [], adjustments: [], purchases: [] };
const milk: FoodConversionData = { food_id: 'f', density: { g_per_ml: 1.03, source: 'trusted_database' }, servings: [] };

describe('normalization (Layer 5A)', () => {
  it('units convert exactly within a dimension; count is its own dimension', () => {
    expect(normalizeOwn({ quantity: 0.4, unit: 'kg' })).toMatchObject({ status: 'converted', dimension: 'mass', value: { n: 400n, d: 1n } });
    expect(normalizeOwn({ quantity: 3, unit: 'count' })).toMatchObject({ status: 'converted', dimension: 'count' });
    expect(normalizeOwn({ quantity: 1, unit: 'cup' })).toMatchObject({ status: 'unresolved', reason: 'ambiguous_unit:cup_us|cup_metric|cup_us_legal' });
  });

  it('mass <-> volume only through trusted density; never count <-> mass', () => {
    expect(normalizeTo({ quantity: 103, unit: 'g' }, 'volume', milk)).toMatchObject({ status: 'converted', value: { n: 100n, d: 1n } });
    expect(normalizeTo({ quantity: 103, unit: 'g' }, 'volume', { ...milk, density: { g_per_ml: 1, source: 'user_entered' } })).toMatchObject({ reason: 'density_not_trusted_reference' });
    expect(normalizeTo({ quantity: 103, unit: 'g' }, 'volume', null)).toMatchObject({ status: 'unresolved' });
    expect(normalizeTo({ quantity: 2, unit: 'count' }, 'mass', milk)).toMatchObject({ reason: 'count_not_convertible_to_mass_or_volume' });
  });
});

describe('generated item', () => {
  it('need = generated - already-have; surplus when above; never negative', () => {
    const v = itemShopping(item('500/1'), { ...noState, alreadyHave: [state(700, 'g')] }, null);
    expect(v).toMatchObject({ derived_need: { quantity: 0 }, already_have_surplus: { quantity: 200 }, remaining_to_purchase: { quantity: 0 }, status: 'already_have_sufficient' });
    expect(v.generated_quantity).toMatchObject({ quantity: 500 });
  });

  it('only the active already-have counts (revoked history is kept)', () => {
    const v = itemShopping(item('1200/1'), { ...noState, alreadyHave: [state(1000, 'g', true), state(400, 'g')] }, null);
    expect(v.derived_need).toMatchObject({ quantity: 800 });
    expect(v.history.already_have).toHaveLength(2);
  });

  it('an adjustment is the target (user_adjusted); zero means no purchase needed', () => {
    expect(itemShopping(item('800/1'), { ...noState, adjustments: [state(1, 'kg')] }, null)).toMatchObject({ shopping_target: { quantity: 1000 }, shopping_target_source: 'user_adjusted' });
    expect(itemShopping(item('800/1'), { ...noState, adjustments: [state(0, 'g')] }, null)).toMatchObject({ status: 'no_purchase_needed' });
  });

  it('purchases: partial, full, over; incompatible units and check-offs are never counted', () => {
    const s = (purchases: PurchaseRecord[]) => itemShopping(item('800/1'), { ...noState, purchases }, null);
    expect(s([buy(300, 'g')])).toMatchObject({ status: 'partially_purchased', remaining_to_purchase: { quantity: 500 } });
    expect(s([buy(0.8, 'kg')])).toMatchObject({ status: 'purchased', over_purchased: null });
    expect(s([buy(1, 'kg')])).toMatchObject({ status: 'purchased', remaining_to_purchase: { quantity: 0 }, over_purchased: { quantity: 200 } });
    expect(s([buy(1, 'kg', true)])).toMatchObject({ status: 'need_to_buy' });
    const odd = s([buy(1, 'l'), buy(null, null)]);
    expect(odd).toMatchObject({ status: 'need_to_buy', purchased: { quantity: 0 } });
    expect(odd.purchased.not_counted.map((x) => x.reason)).toEqual(['incompatible_dimensions', 'check_off_not_counted_for_quantity_target']);
  });

  it('an incomparable already-have makes the item comparison_unresolved (no fabricated need)', () => {
    const v = itemShopping(item('800/1'), { ...noState, alreadyHave: [state(2, 'count')], purchases: [buy(800, 'g')] }, null);
    expect(v).toMatchObject({ derived_need: null, shopping_target: null, status: 'comparison_unresolved', purchase_mode: 'quantity' });
  });

  it('an unresolved generated item is a check-off target; checking it off marks it purchased', () => {
    expect(itemShopping(item(null), noState, null)).toMatchObject({ status: 'comparison_unresolved', purchase_mode: 'check_off' });
    expect(itemShopping(item(null), { ...noState, purchases: [buy(null, null)] }, null)).toMatchObject({ status: 'purchased', purchased: { checked_off: true } });
  });
});

describe('manual item', () => {
  const manual = (quantity: number | null, unit: string | null) => ({ id: 'm1', name: 'Coffee', quantity, unit, food_id: null, notes: null, created_at: 'x', revoked_at: null });
  it('with a quantity: quantity-aware; without: a check-off that starts as need_to_buy', () => {
    expect(manualShopping(manual(250, 'g'), [buy(100, 'g')], null, null)).toMatchObject({ source: 'manual', status: 'partially_purchased', remaining_to_purchase: { quantity: 150 } });
    expect(manualShopping(manual(null, null), [], null, null)).toMatchObject({ status: 'need_to_buy', purchase_mode: 'check_off' });
    expect(manualShopping(manual(null, null), [buy(null, null)], null, null)).toMatchObject({ status: 'purchased' });
  });
});

describe('request contracts', () => {
  it('only user facts are accepted; units are exact codes or count', () => {
    expect(userQuantitySchema.parse({ quantity: 1, unit: 'kg', generated_quantity: 9, grocery_list_item_id: 'x' })).toEqual({ quantity: 1, unit: 'kg' });
    expect(userQuantitySchema.safeParse({ quantity: 1, unit: 'cup' }).success).toBe(false);
    expect(userQuantitySchema.safeParse({ quantity: -1, unit: 'g' }).success).toBe(false);
    expect(purchaseSchema.safeParse({ quantity: 1 }).success).toBe(false);
    expect(purchaseSchema.safeParse({}).success).toBe(true);
    expect(manualItemSchema.safeParse({ name: ' ' }).success).toBe(false);
    expect(manualItemSchema.safeParse({ name: 'Towels', unit: 'count' }).success).toBe(false);
  });
});
