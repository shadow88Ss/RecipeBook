// Layer 9B — the deterministic shopping read model.
//
// Pure functions (no I/O). Combines an IMMUTABLE Layer 9A generated item
// with the user's shopping facts — already-have, an optional shopping
// quantity adjustment, purchase events — without ever changing the
// generated requirement:
//
//   derived_need     = max(generated - already_have, 0)      (surplus kept)
//   shopping_target  = adjustment, if active; else derived_need
//   remaining        = max(shopping_target - purchased, 0)   (over-purchase kept)
//
// Every user quantity is stored as entered (quantity + unit) and normalized
// here with the Layer 5A engine into the item's canonical grocery base
// (g, ml, count). mass <-> volume only through the Food's trusted density;
// count never converts to mass/volume; ambiguous units never resolve. A
// quantity that cannot be normalized is shown but never counted — the item
// is then `comparison_unresolved` rather than a fabricated number.

import { convertExact, type FoodConversionData } from '../conversion/conversion.engine';
import { add, fromNumber, mul, parseFraction, roundHalfUp, ZERO, type Rational } from '../conversion/decimal';
import { BASE_UNIT, resolveUnit } from '../conversion/units';
import { GROCERY_DECIMAL_PLACES, type GroceryDimension, type GroceryUnit } from './grocery.engine';

export const SHOPPING_RULES_VERSION = 'grocery-shopping-9b.1';
export const COUNT_UNIT = 'count';

const UNIT_OF: Record<GroceryDimension, GroceryUnit> = { mass: 'g', volume: 'ml', count: 'count' };

export type ShoppingStatus = 'need_to_buy' | 'partially_purchased' | 'purchased' | 'already_have_sufficient' | 'no_purchase_needed' | 'comparison_unresolved';

export interface UserQuantity {
  quantity: number;
  unit: string;
}

export interface StateRecord {
  id: string;
  quantity: number;
  unit: string;
  note: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface PurchaseRecord {
  id: string;
  quantity: number | null;
  unit: string | null;
  note: string | null;
  created_at: string;
  revoked_at: string | null;
}

export type Normalized = { status: 'converted'; value: Rational; dimension: GroceryDimension } | { status: 'unresolved'; reason: string };

const toNumber = (r: Rational) => Number(roundHalfUp(r, GROCERY_DECIMAL_PLACES));
const sub = (a: Rational, b: Rational): Rational => {
  // a - b for a >= b (callers check), exact
  const n = a.n * b.d - b.n * a.d;
  return { n: n < 0n ? 0n : n, d: a.d * b.d };
};
const cmp = (a: Rational, b: Rational) => {
  const x = a.n * b.d;
  const y = b.n * a.d;
  return x < y ? -1 : x > y ? 1 : 0;
};
const isZero = (r: Rational) => r.n === 0n;

/** A user amount in its own canonical dimension (Layer 5A definitions only). */
export function normalizeOwn(input: UserQuantity): Normalized {
  const value = Number(input.quantity);
  if (!Number.isFinite(value) || value < 0) return { status: 'unresolved', reason: 'invalid_quantity' };
  if (input.unit === COUNT_UNIT) return { status: 'converted', value: fromNumber(value), dimension: 'count' };
  const resolution = resolveUnit(input.unit);
  if (!resolution.ok) return { status: 'unresolved', reason: resolution.reason === 'ambiguous_unit' ? `ambiguous_unit:${resolution.candidates.join('|')}` : 'unknown_unit' };
  const per = convertExact({ quantity: 1, from: { unit: resolution.unit.code }, to: { unit: BASE_UNIT[resolution.unit.dimension] } }, null);
  if (per.status === 'unresolved') return { status: 'unresolved', reason: per.reason };
  return { status: 'converted', value: mul(fromNumber(value), per.value), dimension: resolution.unit.dimension };
}

/** A user amount in a target dimension: same dimension directly; mass <->
 * volume only through the Food's trusted (global-reference) density. */
export function normalizeTo(input: UserQuantity, target: GroceryDimension, food: FoodConversionData | null): Normalized {
  const own = normalizeOwn(input);
  if (own.status === 'unresolved' || own.dimension === target) return own;
  if (own.dimension === 'count' || target === 'count') return { status: 'unresolved', reason: 'count_not_convertible_to_mass_or_volume' };
  if (!food) return { status: 'unresolved', reason: 'incompatible_dimensions' };
  const factor = convertExact({ quantity: 1, from: { unit: UNIT_OF[own.dimension] }, to: { unit: UNIT_OF[target] } }, food);
  if (factor.status === 'unresolved') return { status: 'unresolved', reason: factor.reason };
  if (!factor.authoritative) return { status: 'unresolved', reason: 'density_not_trusted_reference' };
  return { status: 'converted', value: mul(own.value, factor.value), dimension: target };
}

const inputDto = (r: { quantity: number | null; unit: string | null }) => ({ quantity: r.quantity === null ? null : Number(r.quantity), unit: r.unit });

function stateDto(record: StateRecord | null, normalized: Normalized | null) {
  if (!record) return null;
  return {
    id: record.id,
    input: inputDto(record),
    normalized_quantity: normalized?.status === 'converted' ? toNumber(normalized.value) : null,
    normalized_unit: normalized?.status === 'converted' ? UNIT_OF[normalized.dimension] : null,
    comparison: normalized?.status === 'converted' ? ('comparable' as const) : ('unresolved' as const),
    unresolved_reason: normalized?.status === 'unresolved' ? normalized.reason : null,
    note: record.note,
    recorded_at: record.created_at,
  };
}

interface Target {
  value: Rational;
  dimension: GroceryDimension;
  source: 'generated' | 'user_adjusted' | 'manual';
}

/** Purchases against a target: quantities in the target's dimension are
 * summed; others are listed and never counted; check-offs count only for a
 * target with no quantity. */
function purchaseState(purchases: readonly PurchaseRecord[], target: Target | null, food: FoodConversionData | null, mode: PurchaseMode) {
  const active = purchases.filter((p) => p.revoked_at === null);
  let total = ZERO;
  const counted: string[] = [];
  const notCounted: Array<{ id: string; quantity: number | null; unit: string | null; reason: string }> = [];
  for (const p of active) {
    if (p.quantity === null || p.unit === null) {
      if (mode !== 'check_off') notCounted.push({ id: p.id, quantity: null, unit: null, reason: 'check_off_not_counted_for_quantity_target' });
      continue;
    }
    if (!target) {
      notCounted.push({ id: p.id, ...inputDto(p), reason: 'no_comparable_shopping_target' });
      continue;
    }
    const n = normalizeTo({ quantity: p.quantity, unit: p.unit }, target.dimension, food);
    if (n.status === 'unresolved') {
      notCounted.push({ id: p.id, ...inputDto(p), reason: n.reason });
      continue;
    }
    total = add(total, n.value);
    counted.push(p.id);
  }
  const checkedOff = mode === 'check_off' && active.some((p) => p.quantity === null);
  return { active, total, counted, notCounted, checkedOff };
}

/** `quantity`: purchases must carry a quantity (a comparable target exists,
 * or should exist but cannot be compared yet); `check_off`: the target has
 * no quantity at all (an unresolved generated requirement, or a manual item
 * without an amount), so a purchase is a plain check-off. */
export type PurchaseMode = 'quantity' | 'check_off';

function statusFor(target: Target | null, mode: PurchaseMode, purchased: Rational, checkedOff: boolean, alreadyHaveCovers: boolean, noTarget: ShoppingStatus): ShoppingStatus {
  if (!target) return mode === 'check_off' && checkedOff ? 'purchased' : mode === 'check_off' ? noTarget : 'comparison_unresolved';
  if (isZero(target.value)) return alreadyHaveCovers ? 'already_have_sufficient' : 'no_purchase_needed';
  if (cmp(purchased, target.value) >= 0) return 'purchased';
  if (!isZero(purchased)) return 'partially_purchased';
  return 'need_to_buy';
}

function progressDto(target: Target | null, p: ReturnType<typeof purchaseState>) {
  const unit = target ? UNIT_OF[target.dimension] : null;
  return {
    purchased: {
      quantity: target ? toNumber(p.total) : null,
      unit,
      counted_purchase_ids: p.counted,
      not_counted: p.notCounted,
      checked_off: p.checkedOff,
    },
    remaining_to_purchase: target ? { quantity: toNumber(cmp(p.total, target.value) >= 0 ? ZERO : sub(target.value, p.total)), unit } : null,
    over_purchased: target && cmp(p.total, target.value) > 0 ? { quantity: toNumber(sub(p.total, target.value)), unit } : null,
  };
}

export interface GeneratedItemInput {
  id: string;
  position: number;
  food_id: string | null;
  display_name: string;
  dimension: GroceryDimension | null;
  quantity_exact: string | null;
  resolution_status: string;
  unresolved_reason: string | null;
}

export function itemShopping(
  item: GeneratedItemInput,
  state: { alreadyHave: readonly StateRecord[]; adjustments: readonly StateRecord[]; purchases: readonly PurchaseRecord[] },
  food: FoodConversionData | null,
) {
  const generated = item.quantity_exact !== null && item.dimension !== null ? { value: parseFraction(item.quantity_exact), dimension: item.dimension } : null;
  const have = state.alreadyHave.find((r) => r.revoked_at === null) ?? null;
  const adjustment = state.adjustments.find((r) => r.revoked_at === null) ?? null;

  const haveN = have ? (generated ? normalizeTo(have, generated.dimension, food) : ({ status: 'unresolved', reason: 'generated_quantity_unresolved' } as Normalized)) : null;
  let derivedNeed: Rational | null = generated ? generated.value : null;
  let surplus: Rational | null = null;
  let alreadyHaveCovers = false;
  if (generated && haveN) {
    if (haveN.status === 'converted') {
      const c = cmp(haveN.value, generated.value);
      derivedNeed = c >= 0 ? ZERO : sub(generated.value, haveN.value);
      surplus = c > 0 ? sub(haveN.value, generated.value) : null;
      alreadyHaveCovers = c >= 0;
    } else {
      derivedNeed = null; // never fabricated
    }
  }

  const adjN = adjustment ? (generated ? normalizeTo(adjustment, generated.dimension, food) : normalizeOwn(adjustment)) : null;
  let target: Target | null = null;
  if (adjustment) {
    target = adjN?.status === 'converted' ? { value: adjN.value, dimension: adjN.dimension, source: 'user_adjusted' } : null;
  } else if (generated && derivedNeed) {
    target = { value: derivedNeed, dimension: generated.dimension, source: 'generated' };
  }
  const mode: PurchaseMode = target || generated || adjustment ? 'quantity' : 'check_off';
  const p = purchaseState(state.purchases, target, food, mode);
  const unit = generated ? UNIT_OF[generated.dimension] : null;
  return {
    grocery_list_item_id: item.id,
    position: item.position,
    food: item.food_id ? { food_id: item.food_id, canonical_name: item.display_name } : null,
    display_name: item.display_name,
    generation_resolution_status: item.resolution_status,
    generation_unresolved_reason: item.unresolved_reason,
    generated_quantity: generated ? { quantity: toNumber(generated.value), quantity_exact: item.quantity_exact, unit } : null,
    already_have: stateDto(have, haveN),
    derived_need: derivedNeed ? { quantity: toNumber(derivedNeed), unit } : null,
    already_have_surplus: surplus ? { quantity: toNumber(surplus), unit } : null,
    shopping_adjustment: stateDto(adjustment, adjN),
    shopping_target: target ? { quantity: toNumber(target.value), unit: UNIT_OF[target.dimension] } : null,
    shopping_target_source: target?.source ?? null,
    ...progressDto(target, p),
    status: statusFor(target, mode, p.total, p.checkedOff, alreadyHaveCovers && !adjustment, 'comparison_unresolved'),
    purchase_mode: mode,
    history: history(state),
  };
}

export interface ManualItemInput {
  id: string;
  name: string;
  quantity: number | null;
  unit: string | null;
  food_id: string | null;
  notes: string | null;
  created_at: string;
  revoked_at: string | null;
}

export function manualShopping(item: ManualItemInput, purchases: readonly PurchaseRecord[], food: FoodConversionData | null, foodName: string | null) {
  const own = item.quantity !== null && item.unit !== null ? normalizeOwn({ quantity: item.quantity, unit: item.unit }) : null;
  const target: Target | null = own?.status === 'converted' ? { value: own.value, dimension: own.dimension, source: 'manual' } : null;
  const mode: PurchaseMode = own === null ? 'check_off' : 'quantity';
  const p = purchaseState(purchases, target, food, mode);
  return {
    grocery_manual_item_id: item.id,
    source: 'manual' as const,
    name: item.name,
    food: item.food_id ? { food_id: item.food_id, canonical_name: foodName } : null,
    notes: item.notes,
    input: inputDto(item),
    quantity_unresolved_reason: own?.status === 'unresolved' ? own.reason : null,
    shopping_target: target ? { quantity: toNumber(target.value), unit: UNIT_OF[target.dimension] } : null,
    shopping_target_source: target ? ('manual' as const) : null,
    ...progressDto(target, p),
    status: statusFor(target, mode, p.total, p.checkedOff, false, 'need_to_buy'),
    purchase_mode: mode,
    created_at: item.created_at,
    revoked_at: item.revoked_at,
    purchases: purchases.map((x) => ({ id: x.id, ...inputDto(x), note: x.note, recorded_at: x.created_at, revoked_at: x.revoked_at })),
  };
}

function history(state: { alreadyHave: readonly StateRecord[]; adjustments: readonly StateRecord[]; purchases: readonly PurchaseRecord[] }) {
  const rec = (r: StateRecord | PurchaseRecord) => ({ id: r.id, ...inputDto(r), note: r.note, recorded_at: r.created_at, revoked_at: r.revoked_at });
  return {
    already_have: state.alreadyHave.map(rec),
    shopping_adjustments: state.adjustments.map(rec),
    purchases: state.purchases.map(rec),
  };
}
