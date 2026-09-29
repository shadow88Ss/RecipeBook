// Layer 9A — grocery rows and response DTOs. Generated requirements only:
// no user shopping state exists in Layer 9A. Actor account ids are not
// exposed.

import { parseFraction, roundHalfUp } from '../conversion/decimal';
import { GROCERY_DECIMAL_PLACES, type GroceryItem, type GrocerySourceLine } from './grocery.engine';

export const GROCERY_LIST_COLUMNS =
  'id, profile_id, meal_plan_id, generation_number, status, supersedes_grocery_list_id, superseded_by_grocery_list_id, superseded_at, ' +
  'plan_status_at_generation, plan_start_date, plan_end_date, plan_local_timezone, source_fingerprint, fingerprint_version, ' +
  'calculation_version, conversion_version, excluded_sources, generated_at';
export const GROCERY_ITEM_COLUMNS =
  'id, grocery_list_id, profile_id, position, food_id, display_name, dimension, quantity_exact, quantity, unit, resolution_status, aggregation_status, unresolved_reason, source_count';
export const GROCERY_SOURCE_COLUMNS =
  'id, grocery_list_item_id, grocery_list_id, position, meal_plan_id, meal_plan_day_id, planned_meal_id, planned_meal_item_id, plan_date, source_type, ' +
  'food_id, food_serving_id, recipe_id, recipe_version_id, recipe_ingredient_id, ingredient_text, ingredient_match_status, source_quantity, source_unit, ' +
  'planned_servings, recipe_yield, scale_factor_exact, scaled_quantity_exact, contribution_quantity_exact, contribution_unit, conversion, unresolved_reason';

export interface GroceryListRow {
  id: string;
  profile_id: string;
  meal_plan_id: string;
  generation_number: number;
  status: 'active' | 'superseded';
  supersedes_grocery_list_id: string | null;
  superseded_by_grocery_list_id: string | null;
  superseded_at: string | null;
  plan_status_at_generation: string;
  plan_start_date: string;
  plan_end_date: string;
  plan_local_timezone: string;
  source_fingerprint: string;
  fingerprint_version: string;
  calculation_version: string;
  conversion_version: string;
  excluded_sources: ExcludedSource[];
  generated_at: string;
}

export interface GroceryItemRow extends Omit<GroceryItem, 'sources' | 'quantity'> {
  id: string;
  grocery_list_id: string;
  profile_id: string;
  quantity: number | string | null;
  source_count: number;
}

export interface GrocerySourceRow extends Omit<GrocerySourceLine, 'meal_type' | 'recipe_version_number' | 'recipe_title'> {
  id: string;
  grocery_list_item_id: string;
  grocery_list_id: string;
  position: number;
}

/** A current plan item that did NOT contribute, and why. */
export interface ExcludedSource {
  planned_meal_item_id: string;
  planned_meal_id: string;
  meal_plan_day_id: string;
  plan_date: string;
  meal_type: string;
  status: string;
  reason: 'unconfirmed' | 'pending_replacement_not_confirmed' | 'skipped';
  source_type: 'food' | 'recipe';
  food_id: string | null;
  recipe_version_id: string | null;
}

const exactToNumber = (exact: string | null) => (exact === null ? null : Number(roundHalfUp(parseFraction(exact), GROCERY_DECIMAL_PLACES)));
const numberOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

export function toSourceDto(s: Omit<GrocerySourceLine, 'recipe_version_number' | 'recipe_title' | 'meal_type'> & { meal_type: string | null }, position: number) {
  return {
    position,
    source_type: s.source_type,
    meal_plan_id: s.meal_plan_id,
    meal_plan_day_id: s.meal_plan_day_id,
    planned_meal_id: s.planned_meal_id,
    planned_meal_item_id: s.planned_meal_item_id,
    plan_date: s.plan_date,
    meal_type: s.meal_type,
    food_id: s.food_id,
    food_serving_id: s.food_serving_id,
    recipe_id: s.recipe_id,
    recipe_version_id: s.recipe_version_id,
    recipe_ingredient_id: s.recipe_ingredient_id,
    ingredient_text: s.ingredient_text,
    ingredient_match_status: s.ingredient_match_status,
    source_quantity: numberOrNull(s.source_quantity),
    source_unit: s.source_unit,
    planned_servings: numberOrNull(s.planned_servings),
    recipe_yield: numberOrNull(s.recipe_yield),
    scale_factor_exact: s.scale_factor_exact,
    scaled_quantity: exactToNumber(s.scaled_quantity_exact),
    scaled_quantity_exact: s.scaled_quantity_exact,
    contribution_quantity: exactToNumber(s.contribution_quantity_exact),
    contribution_quantity_exact: s.contribution_quantity_exact,
    contribution_unit: s.contribution_unit,
    conversion: s.conversion,
    unresolved_reason: s.unresolved_reason,
  };
}

export function toItemDto(item: Omit<GroceryItem, 'sources' | 'quantity'> & { id?: string; quantity: number | string | null }, sources: ReturnType<typeof toSourceDto>[]) {
  return {
    ...(item.id ? { id: item.id } : {}),
    position: item.position,
    food: item.food_id ? { food_id: item.food_id, canonical_name: item.display_name } : null,
    display_name: item.display_name,
    dimension: item.dimension,
    quantity: numberOrNull(item.quantity),
    quantity_exact: item.quantity_exact,
    unit: item.unit,
    resolution_status: item.resolution_status,
    aggregation_status: item.aggregation_status,
    unresolved_reason: item.unresolved_reason,
    source_count: sources.length,
    sources,
  };
}

export function summarize(items: ReadonlyArray<ReturnType<typeof toItemDto>>) {
  const sources = items.flatMap((i) => i.sources);
  return {
    item_count: items.length,
    resolved_item_count: items.filter((i) => i.resolution_status === 'resolved').length,
    incompatible_unit_item_count: items.filter((i) => i.resolution_status === 'incompatible_units').length,
    unresolved_item_count: items.filter((i) => i.aggregation_status === 'not_aggregated').length,
    source_line_count: sources.length,
    contributing_planned_item_count: new Set(sources.map((s) => s.planned_meal_item_id)).size,
    direct_food_source_count: sources.filter((s) => s.source_type === 'planned_food').length,
    recipe_ingredient_source_count: sources.filter((s) => s.source_type === 'recipe_ingredient').length,
    recipe_version_count: new Set(sources.flatMap((s) => (s.recipe_version_id ? [s.recipe_version_id] : []))).size,
  };
}

export function toListSummaryDto(l: GroceryListRow) {
  return {
    id: l.id,
    profile_id: l.profile_id,
    meal_plan_id: l.meal_plan_id,
    generation_number: l.generation_number,
    status: l.status,
    supersedes_grocery_list_id: l.supersedes_grocery_list_id,
    superseded_by_grocery_list_id: l.superseded_by_grocery_list_id,
    superseded_at: l.superseded_at,
    generated_at: l.generated_at,
    plan_context: {
      status_at_generation: l.plan_status_at_generation,
      start_date: l.plan_start_date,
      end_date: l.plan_end_date,
      local_timezone: l.plan_local_timezone,
    },
    calculation_version: l.calculation_version,
    conversion_version: l.conversion_version,
    fingerprint_version: l.fingerprint_version,
    generated_source_fingerprint: l.source_fingerprint,
  };
}

export function splitExcluded(excluded: readonly ExcludedSource[]) {
  return {
    excluded_unconfirmed_sources: excluded.filter((e) => e.reason !== 'skipped'),
    excluded_skipped_sources: excluded.filter((e) => e.reason === 'skipped'),
  };
}
