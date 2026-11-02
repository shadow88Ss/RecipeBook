// Layer 12C — Recipe Book DTOs, written from docs/30_API.md §17 (no backend
// runtime code is imported). Only the fields the app renders are validated;
// unknown fields are dropped. Recipe nutrition is calculated on the server
// (Layer 5B engine through Layer 6A) for the version shown; the app never
// derives a value, and per-serving nutrition is the server's own division.

import { z } from 'zod';

import { pageSchema } from './common';
import { nutritionSummarySchema } from './dailyTracker';
import { aggregateNutrientSchema, itemNutrientSchema } from './nutrition';
import { statedNutritionSchema } from './recipeImports';

export const recipeListItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  current_version_number: z.number().nullable(),
  servings: z.number().nullable(),
  updated_at: z.string(),
});
export type RecipeListItem = z.infer<typeof recipeListItemSchema>;
export const recipePageSchema = pageSchema(recipeListItemSchema);
export type RecipePage = z.infer<typeof recipePageSchema>;

export const recipeIngredientSchema = z.object({
  id: z.string(),
  position: z.number(),
  /** The line as the user wrote it — immutable provenance. */
  text: z.string(),
  food_id: z.string().nullable(),
  serving_id: z.string().nullable().optional(),
  quantity: z.number().nullable(),
  unit: z.string().nullable(),
  match_status: z.string(),
});
export type RecipeIngredient = z.infer<typeof recipeIngredientSchema>;

export const recipeVersionSchema = z.object({
  id: z.string(),
  version_number: z.number(),
  is_current: z.boolean(),
  title: z.string(),
  description: z.string().nullable(),
  /** The yield. null = not defined, so there is no per-serving nutrition. */
  servings: z.number().nullable(),
  ingredients: z.array(recipeIngredientSchema),
  instructions: z.array(z.object({ id: z.string(), step_number: z.number(), text: z.string() })),
});
export type RecipeVersion = z.infer<typeof recipeVersionSchema>;

/** Whole recipe or one serving: the Layer 5C summary and every nutrient, with coverage across ingredients. */
const recipeNutritionViewSchema = z.object({
  summary: nutritionSummarySchema,
  item_count: z.number(),
  nutrients: z.array(aggregateNutrientSchema).default([]),
});
export type RecipeNutritionView = z.infer<typeof recipeNutritionViewSchema>;

/** Why an ingredient is not counted (docs/30_API.md §17 "Completeness"); `calculated` = counted. */
export const INGREDIENT_NUTRITION_STATUSES = ['calculated', 'food_unmatched', 'food_needs_confirmation', 'food_unavailable', 'quantity_missing', 'unit_missing'] as const;

/** GET /v1/profiles/{id}/recipes/{recipe_id}/nutrition — the current version, with per-ingredient status. */
export const recipeNutritionSchema = z.object({
  recipe_version_id: z.string(),
  version_number: z.number(),
  servings: z.number().nullable(),
  ingredient_count: z.number(),
  calculated_ingredient_count: z.number(),
  whole_recipe: recipeNutritionViewSchema,
  per_serving: recipeNutritionViewSchema.extend({ servings: z.number().nullable() }).nullable(),
  per_serving_status: z.enum(['available', 'servings_not_defined']),
  ingredients: z
    .array(
      z.object({
        ingredient_id: z.string(),
        index: z.number(),
        nutrition_status: z.string(),
        /** Layer 13A.1 — this ingredient's own nutrition, for its amount, as the server calculated it; null when not counted. */
        calculation: z.object({ summary: nutritionSummarySchema, nutrients: z.array(itemNutrientSchema).default([]) }).nullable().default(null).catch(null),
      }),
    )
    .default([]),
});
export type RecipeNutrition = z.infer<typeof recipeNutritionSchema>;

/** GET /v1/profiles/{id}/recipes/{recipe_id} */
export const recipeDetailSchema = z.object({
  id: z.string(),
  title: z.string(),
  updated_at: z.string(),
  version_count: z.number(),
  current_version: recipeVersionSchema.nullable(),
  /** Layer 13A.1 — where an imported recipe came from, and the nutrition that page states (not verified, not used in totals). */
  imported_source: z.object({ url: z.string(), stated_nutrition: statedNutritionSchema.nullable() }).nullable().default(null),
});
export type RecipeDetail = z.infer<typeof recipeDetailSchema>;

// ---- Layer 12D — create and edit (new version) -----------------------------

/**
 * One ingredient line as sent to POST/PATCH (docs/30_API.md §17). `text` is
 * the line as written. `food_id` is a Food the user chose, a confirmed match;
 * without it the line is kept as text only. The amount is quantity + unit,
 * quantity + serving_id (a serving of that Food), quantity alone (a count),
 * or nothing. Server-owned fields (match state, order numbers) are never sent.
 */
export type RecipeIngredientInput = {
  text: string;
  food_id?: string;
  serving_id?: string;
  quantity?: number;
  unit?: string;
  /** Layer 13A.1 — import save only: a suggestion the user did not confirm; stored unconfirmed and not counted. */
  suggested_food_id?: string;
  suggestion_confidence?: number;
};

export interface RecipeWrite {
  title: string;
  description: string | null;
  servings: number;
  ingredients: RecipeIngredientInput[];
  instructions: string[];
}
