// Layer 7A — the consumed MealItem nutrition snapshot.
//
// A snapshot is what the deterministic system recorded for one item at
// logging time: its source (Food + amount, or exact RecipeVersion +
// servings), the exact per-nutrient values with their completeness, and the
// full Layer 5B/6A provenance (normalized quantity, conversion steps,
// serving/density sources, selected FoodNutrient records and bases, recipe
// ingredient breakdown), plus the rule versions that produced it.
//
// Once written to a consumed MealItem it is immutable (database trigger).
// History is read from snapshots ONLY: meal aggregation never reloads Food,
// FoodServing, FoodNutrient, density or recipes, so later reference-data
// changes or recipe edits cannot rewrite what was recorded. Aggregation uses
// the Layer 5B engine's aggregateCoverage (same unit normalization, exact
// arithmetic, completeness and rounding) over the stored exact values — it
// does not recalculate any food.

import { parseFraction, toFractionString } from '../conversion/decimal';
import { CONVERSION_VERSION } from '../conversion/conversion.engine';
import {
  aggregateCoverage,
  multiplyAggregate,
  NUTRITION_CALCULATION_VERSION,
  type AggregateNutrient,
  type Coverage,
  type CoverageContribution,
  type ItemCalculation,
  type NutrientDefinition,
} from '../nutrition/nutrition.engine';
import { toItemDto } from '../nutrition/nutrition.service';
import { NUTRIENT_ROLES, type NutrientRole } from '../nutrition/vocabulary';
import { toRecipeNutritionDto } from '../recipes/recipe.dto';
import type { RecipeNutrition } from '../recipes/recipe.nutrition';

export const MEAL_ITEM_SNAPSHOT_VERSION = 'meal-item-snapshot-7a.1';

export interface SnapshotNutrient {
  nutrient_id: string;
  nutrient_key: string;
  nutrient_role: NutrientRole;
  unit: string;
  coverage: Coverage;
  /** Engine status for a food item; for a recipe item `resolved` when a
   * value exists (see coverage for completeness), else `no_data`. */
  status: CoverageContribution['status'];
  /** Exact value as "numerator/denominator"; null when unavailable. */
  value_exact: string | null;
}

export type SnapshotSource =
  | {
      type: 'food';
      food_id: string;
      canonical_name: string;
      quantity: number;
      unit: string | null;
      serving: { serving_id: string; description: string; canonical_quantity: number; canonical_unit: string; source: string } | null;
    }
  | {
      type: 'recipe';
      recipe_id: string;
      recipe_version_id: string;
      version_number: number;
      title: string;
      yield_servings: number;
      servings_consumed: number;
    };

export interface MealItemSnapshot {
  snapshot_version: string;
  calculation_version: string;
  conversion_version: string;
  source: SnapshotSource;
  nutrients: SnapshotNutrient[];
  /** Layer 5B item result (food) or Layer 6A recipe nutrition (recipe), as
   * returned by those APIs at logging time. */
  provenance: unknown;
}

function role(definition: NutrientDefinition): NutrientRole {
  return definition.role ?? 'other';
}

export function buildFoodSnapshot(calculation: ItemCalculation, source: Extract<SnapshotSource, { type: 'food' }>): MealItemSnapshot {
  return {
    snapshot_version: MEAL_ITEM_SNAPSHOT_VERSION,
    calculation_version: NUTRITION_CALCULATION_VERSION,
    conversion_version: CONVERSION_VERSION,
    source,
    nutrients: calculation.nutrients.map((n) => {
      const resolved = n.status === 'resolved' && n.value !== null;
      return {
        nutrient_id: n.nutrient.id,
        nutrient_key: n.nutrient.canonical_key,
        nutrient_role: role(n.nutrient),
        unit: n.unit,
        coverage: resolved ? 'complete' : 'unavailable',
        status: n.status,
        value_exact: resolved && n.value ? toFractionString(n.value) : null,
      };
    }),
    provenance: toItemDto(calculation),
  };
}

/** Recipe item = the Layer 6A per-serving result x servings consumed
 * (engine multiplyAggregate). The recipe's own completeness is kept: a
 * nutrient partial across the recipe's ingredients is partial here too. */
export function buildRecipeSnapshot(
  recipeNutrition: RecipeNutrition,
  source: Extract<SnapshotSource, { type: 'recipe' }>,
): MealItemSnapshot {
  if (!recipeNutrition.per_serving) throw new Error('A recipe item needs a RecipeVersion with a yield.');
  const consumed = multiplyAggregate(recipeNutrition.per_serving, source.servings_consumed);
  return {
    snapshot_version: MEAL_ITEM_SNAPSHOT_VERSION,
    calculation_version: NUTRITION_CALCULATION_VERSION,
    conversion_version: CONVERSION_VERSION,
    source,
    nutrients: consumed.map((a) => ({
      nutrient_id: a.nutrient.id,
      nutrient_key: a.nutrient.canonical_key,
      nutrient_role: role(a.nutrient),
      unit: a.nutrient.unit,
      coverage: a.coverage,
      status: a.value !== null ? 'resolved' : 'no_data',
      value_exact: a.value !== null ? toFractionString(a.value) : null,
    })),
    provenance: toRecipeNutritionDto(recipeNutrition, { includeIngredients: true }),
  };
}

const COVERAGES: readonly Coverage[] = ['complete', 'partial', 'unavailable'];

/** Reads a stored snapshot defensively; a malformed one is an internal
 * error, never silently treated as zero or unknown. */
export function readSnapshot(value: unknown): MealItemSnapshot {
  const snapshot = value as Partial<MealItemSnapshot> | null;
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.nutrients) || !snapshot.source) {
    throw new Error('Malformed meal item nutrition snapshot.');
  }
  for (const n of snapshot.nutrients) {
    if (
      typeof n.nutrient_id !== 'string' ||
      typeof n.nutrient_key !== 'string' ||
      typeof n.unit !== 'string' ||
      !COVERAGES.includes(n.coverage) ||
      !(n.value_exact === null || typeof n.value_exact === 'string') ||
      (n.coverage !== 'unavailable') !== (n.value_exact !== null)
    ) {
      throw new Error('Malformed meal item nutrition snapshot nutrient.');
    }
  }
  return snapshot as MealItemSnapshot;
}

function contributions(snapshot: MealItemSnapshot): CoverageContribution[] {
  return snapshot.nutrients.map((n) => ({
    nutrient_id: n.nutrient_id,
    coverage: n.coverage,
    status: n.status,
    value: n.value_exact === null ? null : parseFraction(n.value_exact),
    unit: n.unit,
  }));
}

/** The nutrient definitions recorded in the snapshots themselves (ordered
 * by key), so history never depends on the live vocabulary. A nutrient
 * missing from some snapshot (e.g. added to the vocabulary later) makes
 * those items contribute "unknown", never 0. */
export function snapshotVocabulary(snapshots: readonly MealItemSnapshot[]): NutrientDefinition[] {
  const byId = new Map<string, NutrientDefinition>();
  for (const s of snapshots) {
    for (const n of s.nutrients) {
      if (!byId.has(n.nutrient_id)) {
        byId.set(n.nutrient_id, {
          id: n.nutrient_id,
          canonical_key: n.nutrient_key,
          unit: n.unit,
          role: NUTRIENT_ROLES.includes(n.nutrient_role) ? n.nutrient_role : 'other',
        });
      }
    }
  }
  return [...byId.values()].sort((a, b) => (a.canonical_key < b.canonical_key ? -1 : a.canonical_key > b.canonical_key ? 1 : 0));
}

/** Aggregates recorded snapshots; `index` is each snapshot's position. */
export function aggregateSnapshots(snapshots: readonly MealItemSnapshot[]): AggregateNutrient[] {
  return aggregateCoverage(
    snapshotVocabulary(snapshots),
    snapshots.map((s, index) => ({ index, nutrients: contributions(s) })),
  );
}
