// Layer 6A — Recipe Book row shapes and response DTOs. No endpoint returns a
// raw database row; account attribution (created_by_account_id) is never
// exposed.

import { CONVERSION_VERSION, ROUNDING_MODE } from '../conversion/conversion.engine';
import { NUTRITION_CALCULATION_VERSION, NUTRITION_DECIMAL_PLACES } from '../nutrition/nutrition.engine';
import { toAggregateDto, toItemDto } from '../nutrition/nutrition.service';
import { projectAggregateSummary } from '../nutrition/nutritionSummary';
import type { IngredientMatchStatus, RecipeNutrition } from './recipe.nutrition';

export const RECIPE_COLUMNS = 'id, canonical_title, created_by_profile_id, visibility, current_version_id, created_at, updated_at';
export const RECIPE_VERSION_COLUMNS =
  'id, recipe_id, version_number, title, description, servings, origin_url_source_id, origin_import_job_id, origin_ai_extraction_id, created_at';
export const RECIPE_INGREDIENT_COLUMNS =
  'id, recipe_version_id, food_id, food_serving_id, raw_ingredient_text, quantity, unit, match_confidence, match_status, sort_order';
export const RECIPE_INSTRUCTION_COLUMNS = 'id, recipe_version_id, step_number, instruction_text';
export const RECIPE_VARIANT_COLUMNS =
  'id, base_recipe_id, base_recipe_version_id, profile_id, adjustments_payload, ai_generated, source_confidence, user_accepted_at, created_at, updated_at';

export interface RecipeRow {
  id: string;
  canonical_title: string;
  created_by_profile_id: string | null;
  visibility: 'private' | 'shared_library';
  current_version_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecipeVersionRow {
  id: string;
  recipe_id: string;
  version_number: number;
  title: string;
  description: string | null;
  servings: number | null;
  origin_url_source_id: string | null;
  origin_import_job_id: string | null;
  origin_ai_extraction_id: string | null;
  created_at: string;
}

export interface RecipeIngredientRow {
  id: string;
  recipe_version_id: string;
  food_id: string | null;
  food_serving_id: string | null;
  raw_ingredient_text: string;
  quantity: number | null;
  unit: string | null;
  match_confidence: number | null;
  match_status: IngredientMatchStatus;
  sort_order: number;
}

export interface RecipeInstructionRow {
  id: string;
  recipe_version_id: string;
  step_number: number;
  instruction_text: string;
}

export interface RecipeVariantRow {
  id: string;
  base_recipe_id: string;
  base_recipe_version_id: string;
  profile_id: string;
  adjustments_payload: unknown;
  ai_generated: boolean;
  source_confidence: number | null;
  user_accepted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface VersionContent {
  version: RecipeVersionRow;
  ingredients: RecipeIngredientRow[];
  instructions: RecipeInstructionRow[];
}

function provenance(version: RecipeVersionRow) {
  const imported = version.origin_url_source_id !== null || version.origin_import_job_id !== null || version.origin_ai_extraction_id !== null;
  return {
    origin: imported ? ('imported' as const) : ('manual' as const),
    origin_url_source_id: version.origin_url_source_id,
    origin_import_job_id: version.origin_import_job_id,
    origin_ai_extraction_id: version.origin_ai_extraction_id,
  };
}

export function toVersionSummaryDto(version: RecipeVersionRow, currentVersionId: string | null) {
  return {
    id: version.id,
    recipe_id: version.recipe_id,
    version_number: version.version_number,
    is_current: version.id === currentVersionId,
    title: version.title,
    servings: version.servings,
    created_at: version.created_at,
    provenance: provenance(version),
  };
}

export function toVersionDto({ version, ingredients, instructions }: VersionContent, currentVersionId: string | null) {
  return {
    ...toVersionSummaryDto(version, currentVersionId),
    description: version.description,
    ingredients: [...ingredients]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((i) => ({
        id: i.id,
        position: i.sort_order,
        text: i.raw_ingredient_text,
        food_id: i.food_id,
        serving_id: i.food_serving_id,
        quantity: i.quantity,
        unit: i.unit,
        match_status: i.match_status,
        match_confidence: i.match_confidence,
      })),
    instructions: [...instructions]
      .sort((a, b) => a.step_number - b.step_number)
      .map((s) => ({ id: s.id, step_number: s.step_number, text: s.instruction_text })),
  };
}

export function toRecipeListItemDto(recipe: RecipeRow, current: RecipeVersionRow | undefined) {
  return {
    id: recipe.id,
    profile_id: recipe.created_by_profile_id,
    visibility: recipe.visibility,
    title: recipe.canonical_title,
    current_version_id: recipe.current_version_id,
    current_version_number: current?.version_number ?? null,
    servings: current?.servings ?? null,
    created_at: recipe.created_at,
    updated_at: recipe.updated_at,
  };
}

/** Whole-recipe and per-serving nutrition. `missing[].index` in either
 * aggregate is the ingredient's 0-based position. */
export function toRecipeNutritionDto(nutrition: RecipeNutrition, options: { includeIngredients: boolean }) {
  const count = nutrition.ingredients.length;
  const aggregateView = (aggregate: NonNullable<RecipeNutrition['per_serving']>) => ({
    // Layer 5C projection of the same aggregate — never recalculated.
    summary: projectAggregateSummary(aggregate, count),
    ...toAggregateDto(aggregate, count),
  });
  return {
    calculation_version: NUTRITION_CALCULATION_VERSION,
    conversion_version: CONVERSION_VERSION,
    precision: { decimal_places: NUTRITION_DECIMAL_PLACES, rounding: ROUNDING_MODE },
    servings: nutrition.servings,
    ingredient_count: count,
    calculated_ingredient_count: nutrition.ingredients.filter((i) => i.status === 'calculated').length,
    whole_recipe: aggregateView(nutrition.whole_recipe),
    per_serving: nutrition.per_serving ? { servings: nutrition.servings, ...aggregateView(nutrition.per_serving) } : null,
    per_serving_status: nutrition.per_serving ? ('available' as const) : ('servings_not_defined' as const),
    ...(options.includeIngredients
      ? {
          ingredients: nutrition.ingredients.map((i) => ({
            ingredient_id: i.ingredient_id,
            index: i.index,
            nutrition_status: i.status,
            calculation: i.calculation ? toItemDto(i.calculation) : null,
          })),
        }
      : {}),
  };
}

export function toRecipeVariantDto(row: RecipeVariantRow) {
  return {
    id: row.id,
    profile_id: row.profile_id,
    base_recipe_id: row.base_recipe_id,
    base_recipe_version_id: row.base_recipe_version_id,
    /** Stored as-is. Its structure is not yet specified (Data Dictionary
     * §23: "structured substitutions/portion/ingredient changes"), so it is
     * neither validated nor applied to nutrition in Layer 6A. */
    adjustments_payload: row.adjustments_payload,
    ai_generated: row.ai_generated,
    source_confidence: row.source_confidence,
    user_accepted_at: row.user_accepted_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
