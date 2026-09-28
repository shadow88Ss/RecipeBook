// Layer 8B — planned vs actual: the pure fulfillment read model.
//
// Only relationships are stored (planned_actual_link: same_item |
// substitution; planned_meal_item_skip). Everything here is DERIVED at read
// time from:
//   * the confirmed PlannedMealItem and its immutable nutrition_snapshot
//     (Layer 8A), and
//   * the ACTIVE MealItem of each linked Layer 7A correction chain and its
//     immutable nutrition_snapshot.
// Nothing is recalculated from Food/FoodNutrient/Recipe data, nothing is
// written, and there is no adherence score or percentage.
//
// A link keeps the MealItem id it was created with. It is read through the
// 7A correction chain (superseded_by_meal_item_id) to the active record, and
// is then checked again: a correction that changed the item's identity
// (Food A -> B, RecipeVersion A -> B) or its plan-local day is reported
// factually and does not contribute — it is never converted automatically.

import { add, fromNumber, mul, roundHalfUp, ZERO, type Rational } from '../conversion/decimal';
import { NUTRITION_DECIMAL_PLACES, roundValue, type AggregateNutrient, type Coverage } from '../nutrition/nutrition.engine';
import { toAggregateDto } from '../nutrition/nutrition.service';
import { projectAggregateSummary } from '../nutrition/nutritionSummary';
import { isActive, toMealItemDto, type MealItemRow } from '../meals/meal.dto';
import { aggregateSnapshots, readSnapshot, type MealItemSnapshot } from '../meals/meal.snapshot';
import { localDateOf } from '../meals/meal.time';
import type { PlannedItemRow } from './mealPlan.dto';

export const FULFILLMENT_RULES_VERSION = 'plan-fulfillment-8b.1';

export const PLANNED_ACTUAL_LINK_COLUMNS =
  'id, profile_id, planned_meal_item_id, meal_item_id, relationship_type, meal_item_chain_root_id, created_at, revoked_at';
export const PLANNED_ITEM_SKIP_COLUMNS = 'id, profile_id, planned_meal_item_id, reason, skipped_at, revoked_at';

export type RelationshipType = 'same_item' | 'substitution';

export type FulfillmentState =
  | 'unlinked'
  | 'partial'
  | 'fulfilled_exact'
  | 'above_planned_quantity'
  | 'fulfilled_with_substitution'
  | 'skipped'
  | 'quantity_not_comparable'
  | 'identity_changed_by_correction';

export const FULFILLMENT_STATES: readonly FulfillmentState[] = [
  'unlinked',
  'partial',
  'fulfilled_exact',
  'above_planned_quantity',
  'fulfilled_with_substitution',
  'skipped',
  'quantity_not_comparable',
  'identity_changed_by_correction',
];

/** Why an active link does or does not contribute. */
export type LinkState = 'valid' | 'identity_changed_by_correction' | 'consumed_date_changed_by_correction' | 'actual_not_active';

export interface LinkRow {
  id: string;
  profile_id: string;
  planned_meal_item_id: string;
  meal_item_id: string;
  relationship_type: RelationshipType;
  meal_item_chain_root_id: string;
  created_at: string;
  revoked_at: string | null;
}

export interface SkipRow {
  id: string;
  profile_id: string;
  planned_meal_item_id: string;
  reason: string | null;
  skipped_at: string;
  revoked_at: string | null;
}

/** The Layer 7A correction chains of the MealItems in view. */
export class MealItemChains {
  constructor(private readonly byId: ReadonlyMap<string, MealItemRow>) {}

  get(id: string): MealItemRow | undefined {
    return this.byId.get(id);
  }

  /** The chain's current record (followed through superseded_by). */
  head(id: string): MealItemRow | undefined {
    let item = this.byId.get(id);
    for (let guard = 0; item?.superseded_by_meal_item_id && guard < 1000; guard += 1) {
      const next = this.byId.get(item.superseded_by_meal_item_id);
      if (!next) return undefined;
      item = next;
    }
    return item;
  }

  /** The chain's original record (followed through corrects). */
  root(id: string): string {
    let item = this.byId.get(id);
    let root = id;
    for (let guard = 0; item?.corrects_meal_item_id && guard < 1000; guard += 1) {
      root = item.corrects_meal_item_id;
      item = this.byId.get(root);
    }
    return root;
  }

  /** Active (consumed, not superseded) records. */
  active(): MealItemRow[] {
    return [...this.byId.values()].filter(isActive);
  }
}

interface Identity {
  food_id: string | null;
  recipe_version_id: string | null;
}

export function sameIdentity(planned: Identity, actual: Identity): boolean {
  return (
    (planned.food_id !== null && planned.food_id === actual.food_id) ||
    (planned.recipe_version_id !== null && planned.recipe_version_id === actual.recipe_version_id)
  );
}

export interface ResolvedLink {
  link: LinkRow;
  head: MealItemRow | undefined;
  state: LinkState;
  /** False for a valid link whose active record another link already counts. */
  counted: boolean;
}

/** Re-checks an active link against the chain's CURRENT record. */
export function resolveLink(link: LinkRow, planned: Identity, planDate: string, timeZone: string, chains: MealItemChains): Omit<ResolvedLink, 'counted'> {
  const head = chains.head(link.meal_item_id);
  if (!head || !isActive(head) || !head.consumed_at) return { link, head, state: 'actual_not_active' };
  const same = sameIdentity(planned, head);
  if (link.relationship_type === 'same_item' ? !same : same) return { link, head, state: 'identity_changed_by_correction' };
  if (localDateOf(head.consumed_at, timeZone) !== planDate) return { link, head, state: 'consumed_date_changed_by_correction' };
  return { link, head, state: 'valid' };
}

/** Valid links counted once per active MealItem (earliest link wins). */
export function resolveLinks(links: readonly LinkRow[], planned: Identity, planDate: string, timeZone: string, chains: MealItemChains): ResolvedLink[] {
  const seen = new Set<string>();
  return [...links]
    .sort((a, b) => (a.created_at !== b.created_at ? (a.created_at < b.created_at ? -1 : 1) : a.id < b.id ? -1 : 1))
    .map((l) => {
      const r = resolveLink(l, planned, planDate, timeZone, chains);
      const counted = r.state === 'valid' && r.head !== undefined && !seen.has(r.head.id);
      if (counted && r.head) seen.add(r.head.id);
      return { ...r, counted };
    });
}

// ---------------------------------------------------------------------------
// Quantities — from the stored snapshot sources only.

type Amount =
  | { kind: 'servings'; value: Rational }
  | { kind: 'food'; declared: { value: Rational; unit: string } | null; normalized: { value: Rational; unit: string } | null };

function rational(value: unknown): Rational | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? fromNumber(n) : null;
}

/** Declared amount (quantity in its unit, or servings x the serving's
 * canonical amount) and the engine-normalized amount recorded in the
 * snapshot provenance. */
export function amountOf(snapshot: MealItemSnapshot): Amount {
  const s = snapshot.source;
  if (s.type === 'recipe') return { kind: 'servings', value: rational(s.servings_consumed) ?? ZERO };
  const quantity = rational(s.quantity);
  let declared: { value: Rational; unit: string } | null = null;
  if (quantity && s.serving) {
    const per = rational(s.serving.canonical_quantity);
    if (per) declared = { value: mul(quantity, per), unit: s.serving.canonical_unit };
  } else if (quantity && s.unit) {
    declared = { value: quantity, unit: s.unit };
  }
  const nq = (snapshot.provenance as { normalized_quantity?: { status?: unknown; quantity?: unknown; unit?: unknown } } | null)?.normalized_quantity;
  const normalizedValue = nq && nq.status === 'converted' && typeof nq.unit === 'string' ? rational(nq.quantity) : null;
  const normalized = normalizedValue && nq && typeof nq.unit === 'string' ? { value: normalizedValue, unit: nq.unit } : null;
  return { kind: 'food', declared, normalized };
}

export function compareRational(a: Rational, b: Rational): -1 | 0 | 1 {
  const x = a.n * b.d;
  const y = b.n * a.d;
  return x < y ? -1 : x > y ? 1 : 0;
}

function signedNumber(a: Rational, b: Rational): number {
  // a - b, rounded half-up (away from zero) at the output precision
  const n = a.n * b.d - b.n * a.d;
  const d = a.d * b.d;
  const magnitude = Number(roundHalfUp({ n: n < 0n ? -n : n, d }, NUTRITION_DECIMAL_PLACES));
  return n < 0n && magnitude !== 0 ? -magnitude : magnitude;
}

const num = (r: Rational) => Number(roundHalfUp(r, NUTRITION_DECIMAL_PLACES));

export type QuantityComparisonStatus = 'equal' | 'below_planned' | 'above_planned' | 'not_comparable';

export interface QuantityComparison {
  status: QuantityComparisonStatus;
  basis: 'recipe_servings' | 'declared_amount' | 'normalized_quantity' | null;
  unit: string | null;
  planned: number | null;
  actual: number | null;
  difference: number | null;
}

/** Planned amount vs the sum of the actual amounts, on the first basis all
 * of them share exactly: servings (recipes), the declared unit, or the
 * normalized g/ml quantity. Otherwise not comparable — never guessed. */
export function compareQuantities(planned: MealItemSnapshot, actuals: readonly MealItemSnapshot[]): QuantityComparison {
  const notComparable: QuantityComparison = { status: 'not_comparable', basis: null, unit: null, planned: null, actual: null, difference: null };
  const p = amountOf(planned);
  const a = actuals.map(amountOf);
  const result = (basis: QuantityComparison['basis'], unit: string | null, pv: Rational, values: Rational[]): QuantityComparison => {
    const total = values.reduce(add, ZERO);
    const c = compareRational(total, pv);
    return {
      status: c === 0 ? 'equal' : c < 0 ? 'below_planned' : 'above_planned',
      basis,
      unit,
      planned: num(pv),
      actual: num(total),
      difference: signedNumber(total, pv),
    };
  };
  if (!a.length) return notComparable;
  if (p.kind === 'servings') {
    if (!a.every((x) => x.kind === 'servings')) return notComparable;
    return result('recipe_servings', 'serving', p.value, a.map((x) => (x as { value: Rational }).value));
  }
  const foods = a.filter((x): x is Extract<Amount, { kind: 'food' }> => x.kind === 'food');
  if (foods.length !== a.length) return notComparable;
  for (const basis of ['declared', 'normalized'] as const) {
    const pa = p[basis];
    if (pa && foods.every((x) => x[basis]?.unit === pa.unit)) {
      return result(basis === 'declared' ? 'declared_amount' : 'normalized_quantity', pa.unit, pa.value, foods.map((x) => (x[basis] as { value: Rational }).value));
    }
  }
  return notComparable;
}

// ---------------------------------------------------------------------------
// Nutrition — stored planned snapshot vs recorded actual snapshots.

function aggregateView(snapshots: readonly MealItemSnapshot[]) {
  const aggregate = aggregateSnapshots(snapshots);
  const view = toAggregateDto(aggregate, snapshots.length);
  return { aggregate, summary: projectAggregateSummary(aggregate, snapshots.length), item_count: view.item_count, coverage_summary: view.coverage_summary };
}

const valueOf = (n: AggregateNutrient | undefined) => (n && n.value !== null ? roundValue(n.value).value : null);

/** Per-nutrient planned vs actual. A difference (actual - planned) is given
 * only when BOTH sides are complete; partial/unavailable data is never
 * treated as zero. */
export function compareNutrition(planned: MealItemSnapshot, actuals: readonly MealItemSnapshot[]) {
  const p = aggregateView([planned]);
  const a = aggregateView(actuals);
  const actualById = new Map(a.aggregate.map((n) => [n.nutrient.id, n]));
  const nutrients = p.aggregate.map((pn) => {
    const an = actualById.get(pn.nutrient.id);
    const actualCoverage: Coverage = an?.coverage ?? 'unavailable';
    const comparable = pn.coverage === 'complete' && actualCoverage === 'complete' && pn.value !== null && an?.value != null;
    return {
      nutrient_id: pn.nutrient.id,
      nutrient_key: pn.nutrient.canonical_key,
      unit: pn.nutrient.unit,
      planned_value: valueOf(pn),
      planned_coverage: pn.coverage,
      actual_value: valueOf(an),
      actual_coverage: actualCoverage,
      difference: comparable && pn.value && an?.value ? signedNumber(an.value, pn.value) : null,
      difference_status: comparable ? ('actual_minus_planned' as const) : ('not_comparable_incomplete_data' as const),
    };
  });
  const byKey = new Map(nutrients.map((n) => [n.nutrient_key, n]));
  const summaryDifference = Object.fromEntries(
    Object.entries(p.summary).map(([field, s]) => {
      const n = byKey.get(s.nutrient_key);
      return [field, { nutrient_key: s.nutrient_key, difference: n?.difference ?? null, difference_status: n?.difference_status ?? ('not_comparable_incomplete_data' as const) }];
    }),
  );
  return {
    basis: 'confirmed_planned_snapshot_vs_recorded_actual_snapshots' as const,
    planned: { summary: p.summary, coverage_summary: p.coverage_summary },
    actual: { summary: a.summary, item_count: a.item_count, coverage_summary: a.coverage_summary },
    summary_difference: summaryDifference,
    nutrients,
  };
}

// ---------------------------------------------------------------------------
// One planned item.

export interface PlannedItemContext {
  item: PlannedItemRow;
  plannedSnapshot: MealItemSnapshot;
  planDate: string;
  timeZone: string;
  mealType: string;
  links: readonly LinkRow[];
  skips: readonly SkipRow[];
  chains: MealItemChains;
}

function snapshotOfActual(item: MealItemRow): MealItemSnapshot {
  return readSnapshot(item.nutrition_snapshot);
}

function actualAmountDto(item: MealItemRow) {
  return item.recipe_version_id !== null
    ? { servings: item.quantity }
    : { quantity: item.quantity, unit: item.unit, serving_id: item.food_serving_id };
}

export function deriveItemFulfillment(ctx: PlannedItemContext) {
  const { item, plannedSnapshot, planDate, timeZone, chains } = ctx;
  const activeSkip = ctx.skips.find((s) => s.revoked_at === null) ?? null;
  const activeLinks = ctx.links.filter((l) => l.revoked_at === null);
  const resolved = resolveLinks(activeLinks, item, planDate, timeZone, chains);
  const counted = resolved.filter((r) => r.counted);
  const sameItem = counted.filter((r) => r.link.relationship_type === 'same_item');
  const substitution = counted.filter((r) => r.link.relationship_type === 'substitution');
  const headSnapshots = (rs: readonly ResolvedLink[]) => rs.map((r) => snapshotOfActual(r.head as MealItemRow));

  const quantity = sameItem.length ? compareQuantities(plannedSnapshot, headSnapshots(sameItem)) : null;
  let state: FulfillmentState;
  if (activeSkip) state = 'skipped';
  else if (resolved.some((r) => r.state === 'identity_changed_by_correction')) state = 'identity_changed_by_correction';
  else if (substitution.length) state = 'fulfilled_with_substitution';
  else if (quantity) {
    state =
      quantity.status === 'equal'
        ? 'fulfilled_exact'
        : quantity.status === 'below_planned'
          ? 'partial'
          : quantity.status === 'above_planned'
            ? 'above_planned_quantity'
            : 'quantity_not_comparable';
  } else state = 'unlinked';

  const breakdownOf = (rs: readonly ResolvedLink[]) => {
    const snaps = headSnapshots(rs);
    const view = snaps.length ? aggregateView(snaps) : null;
    return {
      link_count: rs.length,
      actual_meal_item_ids: rs.map((r) => (r.head as MealItemRow).id),
      actual_amounts: rs.map((r) => ({ meal_item_id: (r.head as MealItemRow).id, ...actualAmountDto(r.head as MealItemRow) })),
      actual_nutrition: view ? { summary: view.summary, item_count: view.item_count, coverage_summary: view.coverage_summary } : null,
    };
  };

  return {
    planned_meal_item_id: item.id,
    planned_meal_id: item.planned_meal_id,
    meal_type: ctx.mealType,
    plan_date: planDate,
    planned: {
      source_type: item.recipe_version_id !== null ? ('recipe' as const) : ('food' as const),
      food_id: item.food_id,
      recipe_id: item.recipe_id,
      recipe_version_id: item.recipe_version_id,
      amount: item.recipe_version_id !== null ? { servings: item.quantity } : { quantity: item.quantity, unit: item.unit, serving_id: item.food_serving_id },
      snapshot_version: plannedSnapshot.snapshot_version,
    },
    fulfillment_state: state,
    skip: activeSkip ? { id: activeSkip.id, reason: activeSkip.reason, skipped_at: activeSkip.skipped_at } : null,
    links: resolved.map((r) => ({
      id: r.link.id,
      relationship_type: r.link.relationship_type,
      linked_meal_item_id: r.link.meal_item_id,
      active_meal_item_id: r.head && isActive(r.head) ? r.head.id : null,
      link_state: r.state,
      counted: r.counted,
      created_at: r.link.created_at,
    })),
    breakdown: counted.length
      ? {
          same_item: { ...breakdownOf(sameItem), quantity_comparison: quantity },
          substitution: breakdownOf(substitution),
        }
      : null,
    nutrition_comparison: counted.length ? compareNutrition(plannedSnapshot, headSnapshots(counted)) : null,
    history: {
      revoked_links: ctx.links
        .filter((l) => l.revoked_at !== null)
        .map((l) => ({ id: l.id, relationship_type: l.relationship_type, linked_meal_item_id: l.meal_item_id, created_at: l.created_at, revoked_at: l.revoked_at })),
      revoked_skips: ctx.skips.filter((s) => s.revoked_at !== null).map((s) => ({ id: s.id, reason: s.reason, skipped_at: s.skipped_at, revoked_at: s.revoked_at })),
    },
  };
}

export type ItemFulfillment = ReturnType<typeof deriveItemFulfillment>;

export function countStates(items: readonly { fulfillment_state: FulfillmentState }[]): Record<FulfillmentState, number> {
  const counts = Object.fromEntries(FULFILLMENT_STATES.map((s) => [s, 0])) as Record<FulfillmentState, number>;
  for (const i of items) counts[i.fulfillment_state] += 1;
  return counts;
}

/** An active actual record with no active link to a CURRENT planned item. */
export function toUnplannedActualDto(item: MealItemRow, planLocalDate: string, mealType: string | null) {
  return { ...toMealItemDto(item), meal_type: mealType, plan_local_date: planLocalDate, classification: 'not_linked_to_current_planned_item' as const };
}
