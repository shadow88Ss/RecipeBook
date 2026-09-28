// Layer 8A — Meal Planning rows and response DTOs. No raw rows are returned;
// actor account ids stay in the database.

import { ZERO } from '../conversion/decimal';
import type { AggregateNutrient, NutrientDefinition } from '../nutrition/nutrition.engine';
import { toAggregateDto } from '../nutrition/nutrition.service';
import { projectAggregateSummary } from '../nutrition/nutritionSummary';
import { aggregateSnapshots, type MealItemSnapshot } from '../meals/meal.snapshot';

export const MEAL_PLAN_COLUMNS = 'id, profile_id, name, description, start_date, end_date, local_timezone, status, created_at, updated_at';
export const MEAL_PLAN_DAY_COLUMNS = 'id, meal_plan_id, profile_id, plan_date, created_at';
export const PLANNED_MEAL_COLUMNS = 'id, meal_plan_day_id, profile_id, meal_type, scheduled_local_time, notes, position, created_at';
export const PLANNED_ITEM_COLUMNS =
  'id, planned_meal_id, profile_id, food_id, food_serving_id, unit, recipe_id, recipe_version_id, quantity, position, status, confirmed_at, ' +
  'supersedes_planned_meal_item_id, superseded_by_planned_meal_item_id, nutrition_snapshot, nutrition_calculation_version, nutrition_calculated_at, created_at';

export type MealPlanStatus = 'draft' | 'active' | 'completed' | 'cancelled' | 'archived';
export type PlannedItemStatus = 'draft' | 'planned' | 'confirmed' | 'cancelled';

export interface MealPlanRow {
  id: string;
  profile_id: string;
  name: string;
  description: string | null;
  start_date: string;
  end_date: string;
  local_timezone: string;
  status: MealPlanStatus;
  created_at: string;
  updated_at: string;
}

export interface MealPlanDayRow {
  id: string;
  meal_plan_id: string;
  profile_id: string;
  plan_date: string;
  created_at: string;
}

export interface PlannedMealRow {
  id: string;
  meal_plan_day_id: string;
  profile_id: string;
  meal_type: string;
  scheduled_local_time: string | null;
  notes: string | null;
  position: number;
  created_at: string;
}

export interface PlannedItemRow {
  id: string;
  planned_meal_id: string;
  profile_id: string;
  food_id: string | null;
  food_serving_id: string | null;
  unit: string | null;
  recipe_id: string | null;
  recipe_version_id: string | null;
  quantity: number;
  position: number;
  status: PlannedItemStatus;
  confirmed_at: string | null;
  supersedes_planned_meal_item_id: string | null;
  superseded_by_planned_meal_item_id: string | null;
  nutrition_snapshot: unknown;
  nutrition_calculation_version: string | null;
  nutrition_calculated_at: string | null;
  created_at: string;
}

export interface PlanTree {
  plan: MealPlanRow;
  days: MealPlanDayRow[];
  meals: PlannedMealRow[];
  items: PlannedItemRow[];
}

/** A replacement not yet confirmed: the original is still the current item. */
export function isPendingReplacement(item: PlannedItemRow): boolean {
  return item.supersedes_planned_meal_item_id !== null && (item.status === 'draft' || item.status === 'planned');
}

/** The current plan view: not cancelled, not superseded, not a pending replacement. */
export function isCurrent(item: PlannedItemRow): boolean {
  return item.status !== 'cancelled' && item.superseded_by_planned_meal_item_id === null && !isPendingReplacement(item);
}

export function isEligibleForConfirmation(item: PlannedItemRow): boolean {
  return item.status === 'draft' || item.status === 'planned';
}

const byPosition = <T extends { position: number; created_at: string; id: string }>(a: T, b: T) =>
  a.position !== b.position ? a.position - b.position : a.created_at !== b.created_at ? (a.created_at < b.created_at ? -1 : 1) : a.id < b.id ? -1 : 1;

/** Summary of a set of item snapshots (live or confirmed). Nothing planned
 * is a KNOWN zero (not unknown), as for an empty tracker day. */
export function aggregatePlanned(snapshots: readonly MealItemSnapshot[], vocabulary: readonly NutrientDefinition[]): AggregateNutrient[] {
  if (snapshots.length) return aggregateSnapshots(snapshots);
  return vocabulary.map((nutrient) => ({ nutrient, value: ZERO, coverage: 'complete', resolved_item_count: 0, item_count: 0, missing: [] }));
}

export function nutritionView(snapshots: readonly MealItemSnapshot[], detail: boolean, vocabulary: readonly NutrientDefinition[] = []) {
  const aggregate = aggregatePlanned(snapshots, vocabulary);
  const view = toAggregateDto(aggregate, snapshots.length);
  return {
    basis: snapshots.length ? ('planned_items' as const) : ('no_planned_items' as const),
    summary: projectAggregateSummary(aggregate, snapshots.length),
    item_count: view.item_count,
    coverage_summary: view.coverage_summary,
    ...(detail ? { nutrients: view.nutrients } : {}),
  };
}

export function toPlannedItemDto(item: PlannedItemRow, snapshot: MealItemSnapshot, options: { detail: boolean } = { detail: false }) {
  const source = snapshot.source;
  const confirmed = item.status === 'confirmed';
  return {
    id: item.id,
    planned_meal_id: item.planned_meal_id,
    source_type: item.recipe_version_id !== null ? ('recipe' as const) : ('food' as const),
    food: item.food_id !== null ? { food_id: item.food_id, canonical_name: source.type === 'food' ? source.canonical_name : null } : null,
    recipe:
      item.recipe_version_id !== null
        ? {
            recipe_id: item.recipe_id,
            recipe_version_id: item.recipe_version_id,
            version_number: source.type === 'recipe' ? source.version_number : null,
            title: source.type === 'recipe' ? source.title : null,
          }
        : null,
    amount:
      item.recipe_version_id !== null
        ? { servings: item.quantity }
        : {
            quantity: item.quantity,
            unit: item.unit,
            serving_id: item.food_serving_id,
            serving_description: source.type === 'food' ? (source.serving?.description ?? null) : null,
          },
    position: item.position,
    status: item.status,
    confirmed_at: item.confirmed_at,
    is_current: isCurrent(item),
    is_pending_replacement: isPendingReplacement(item),
    supersedes_planned_meal_item_id: item.supersedes_planned_meal_item_id,
    superseded_by_planned_meal_item_id: item.superseded_by_planned_meal_item_id,
    created_at: item.created_at,
    nutrition: {
      ...nutritionView([snapshot], options.detail),
      basis: confirmed ? ('confirmed_snapshot' as const) : ('live_calculation' as const),
      snapshot_version: snapshot.snapshot_version,
      calculation_version: confirmed ? item.nutrition_calculation_version : snapshot.calculation_version,
      conversion_version: snapshot.conversion_version,
      calculated_at: item.nutrition_calculated_at,
      ...(options.detail ? { provenance: snapshot.provenance } : {}),
    },
  };
}

export function toMealPlanSummaryDto(plan: MealPlanRow) {
  return {
    id: plan.id,
    profile_id: plan.profile_id,
    name: plan.name,
    description: plan.description,
    start_date: plan.start_date,
    end_date: plan.end_date,
    local_timezone: plan.local_timezone,
    status: plan.status,
    created_at: plan.created_at,
    updated_at: plan.updated_at,
  };
}

/** Full tree. Meal/day/plan nutrition cover CURRENT items only. */
export function toMealPlanDetailDto(tree: PlanTree, snapshots: ReadonlyMap<string, MealItemSnapshot>, vocabulary: readonly NutrientDefinition[]) {
  const snap = (item: PlannedItemRow) => {
    const s = snapshots.get(item.id);
    if (!s) throw new Error(`No nutrition for planned item ${item.id}.`);
    return s;
  };
  const counts = { draft: 0, planned: 0, confirmed: 0, cancelled: 0 };
  for (const i of tree.items) counts[i.status] += 1;
  const current = tree.items.filter(isCurrent);

  const days = [...tree.days]
    .sort((a, b) => (a.plan_date < b.plan_date ? -1 : 1))
    .map((day) => {
      const meals = tree.meals
        .filter((m) => m.meal_plan_day_id === day.id)
        .sort(byPosition)
        .map((meal) => {
          const items = tree.items.filter((i) => i.planned_meal_id === meal.id).sort(byPosition);
          return {
            id: meal.id,
            meal_type: meal.meal_type,
            scheduled_local_time: meal.scheduled_local_time ? meal.scheduled_local_time.slice(0, 5) : null,
            notes: meal.notes,
            position: meal.position,
            items: items.map((i) => toPlannedItemDto(i, snap(i))),
            nutrition: nutritionView(items.filter(isCurrent).map(snap), false, vocabulary),
          };
        });
      const dayMealIds = new Set(meals.map((m) => m.id));
      return {
        id: day.id,
        plan_date: day.plan_date,
        meals,
        nutrition: nutritionView(current.filter((i) => dayMealIds.has(i.planned_meal_id)).map(snap), false, vocabulary),
      };
    });

  return {
    ...toMealPlanSummaryDto(tree.plan),
    item_counts: counts,
    current_item_count: current.length,
    includes_unconfirmed: current.some((i) => i.status !== 'confirmed'),
    days,
    nutrition: nutritionView(current.map(snap), false, vocabulary),
  };
}
