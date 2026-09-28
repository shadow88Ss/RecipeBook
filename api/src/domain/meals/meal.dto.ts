// Layer 7A — meal row shapes and response DTOs. No raw rows are returned;
// actor account ids stay in the database (audit), not in ordinary DTOs.
// Every nutrition figure here is derived from stored snapshots only.

import { CONVERSION_VERSION, ROUNDING_MODE } from '../conversion/conversion.engine';
import { NUTRITION_DECIMAL_PLACES } from '../nutrition/nutrition.engine';
import { toAggregateDto } from '../nutrition/nutrition.service';
import { projectAggregateSummary } from '../nutrition/nutritionSummary';
import { aggregateSnapshots, readSnapshot, type MealItemSnapshot } from './meal.snapshot';

export const MEAL_LOG_COLUMNS = 'id, profile_id, meal_type, logged_date, local_timezone, notes, created_at, updated_at';
export const MEAL_ITEM_COLUMNS =
  'id, meal_log_id, profile_id, food_id, food_serving_id, unit, recipe_version_id, quantity, status, consumed_at, ' +
  'status_changed_by_actor_type, corrects_meal_item_id, superseded_by_meal_item_id, correction_reason, ' +
  'nutrition_snapshot, nutrition_calculation_version, nutrition_calculated_at, created_at';

export interface MealLogRow {
  id: string;
  profile_id: string;
  meal_type: string;
  logged_date: string;
  local_timezone: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface MealItemRow {
  id: string;
  meal_log_id: string;
  profile_id: string;
  food_id: string | null;
  food_serving_id: string | null;
  unit: string | null;
  recipe_version_id: string | null;
  quantity: number;
  status: string;
  consumed_at: string | null;
  status_changed_by_actor_type: string;
  corrects_meal_item_id: string | null;
  superseded_by_meal_item_id: string | null;
  correction_reason: string | null;
  nutrition_snapshot: unknown;
  nutrition_calculation_version: string | null;
  nutrition_calculated_at: string | null;
  created_at: string;
}

/** Counted in meal totals: consumed and not superseded by a correction. */
export function isActive(item: MealItemRow): boolean {
  return item.status === 'consumed' && item.superseded_by_meal_item_id === null;
}

function snapshotOf(item: MealItemRow): MealItemSnapshot | null {
  return item.nutrition_snapshot === null || item.nutrition_snapshot === undefined ? null : readSnapshot(item.nutrition_snapshot);
}

function itemNutrition(item: MealItemRow, snapshot: MealItemSnapshot | null, detail: boolean) {
  if (!snapshot) return null;
  const aggregate = aggregateSnapshots([snapshot]);
  const view = toAggregateDto(aggregate, 1);
  return {
    basis: 'recorded_snapshot' as const,
    snapshot_version: snapshot.snapshot_version,
    calculation_version: item.nutrition_calculation_version,
    conversion_version: snapshot.conversion_version,
    calculated_at: item.nutrition_calculated_at,
    summary: projectAggregateSummary(aggregate, 1),
    coverage_summary: view.coverage_summary,
    ...(detail ? { nutrients: view.nutrients, provenance: snapshot.provenance } : {}),
  };
}

export function toMealItemDto(item: MealItemRow, options: { detail: boolean } = { detail: false }) {
  const snapshot = snapshotOf(item);
  const source = snapshot?.source;
  return {
    id: item.id,
    meal_log_id: item.meal_log_id,
    source_type: item.recipe_version_id !== null ? ('recipe' as const) : ('food' as const),
    food:
      item.food_id !== null
        ? { food_id: item.food_id, canonical_name: source?.type === 'food' ? source.canonical_name : null }
        : null,
    recipe:
      item.recipe_version_id !== null
        ? {
            recipe_id: source?.type === 'recipe' ? source.recipe_id : null,
            recipe_version_id: item.recipe_version_id,
            version_number: source?.type === 'recipe' ? source.version_number : null,
            title: source?.type === 'recipe' ? source.title : null,
          }
        : null,
    amount:
      item.recipe_version_id !== null
        ? { servings: item.quantity }
        : {
            quantity: item.quantity,
            unit: item.unit,
            serving_id: item.food_serving_id,
            serving_description: source?.type === 'food' ? (source.serving?.description ?? null) : null,
          },
    status: item.status,
    consumed_at: item.consumed_at,
    created_at: item.created_at,
    is_active: isActive(item),
    logged_by_actor_type: item.status_changed_by_actor_type,
    correction: {
      corrects_meal_item_id: item.corrects_meal_item_id,
      superseded_by_meal_item_id: item.superseded_by_meal_item_id,
      correction_reason: item.correction_reason,
    },
    nutrition: itemNutrition(item, snapshot, options.detail),
  };
}

/** Meal totals from the active items' recorded snapshots. `missing[].index`
 * is the position in `active_item_ids`. */
export function toMealNutritionDto(items: readonly MealItemRow[], options: { includeNutrients: boolean }) {
  const active = items.filter(isActive);
  const snapshots = active.map((i) => {
    const s = snapshotOf(i);
    if (!s) throw new Error(`Consumed meal item ${i.id} has no nutrition snapshot.`);
    return s;
  });
  const aggregate = aggregateSnapshots(snapshots);
  const view = toAggregateDto(aggregate, active.length);
  return {
    basis: 'recorded_snapshots' as const,
    precision: { decimal_places: NUTRITION_DECIMAL_PLACES, rounding: ROUNDING_MODE },
    conversion_version: CONVERSION_VERSION,
    active_item_ids: active.map((i) => i.id),
    excluded_item_ids: items.filter((i) => !isActive(i)).map((i) => i.id),
    summary: projectAggregateSummary(aggregate, active.length),
    item_count: view.item_count,
    coverage_summary: view.coverage_summary,
    ...(options.includeNutrients ? { nutrients: view.nutrients } : {}),
  };
}

export function toMealLogDto(log: MealLogRow, items: readonly MealItemRow[]) {
  return {
    id: log.id,
    profile_id: log.profile_id,
    meal_type: log.meal_type,
    logged_date: log.logged_date,
    local_timezone: log.local_timezone,
    notes: log.notes,
    created_at: log.created_at,
    updated_at: log.updated_at,
    item_count: items.length,
    active_item_count: items.filter(isActive).length,
    items: items.map((i) => toMealItemDto(i)),
    nutrition: toMealNutritionDto(items, { includeNutrients: false }),
  };
}

export function toMealLogListItemDto(log: MealLogRow, items: readonly MealItemRow[]) {
  return {
    id: log.id,
    profile_id: log.profile_id,
    meal_type: log.meal_type,
    logged_date: log.logged_date,
    local_timezone: log.local_timezone,
    notes: log.notes,
    created_at: log.created_at,
    item_count: items.length,
    active_item_count: items.filter(isActive).length,
  };
}
