// Layer 13A — recipe import DTOs, written from docs/30_API.md §33 (no backend
// runtime code is imported). Only the fields the app renders are validated.

import { z } from 'zod';

export const IMPORT_STATUSES = ['queued', 'processing', 'needs_confirmation', 'succeeded', 'retryable_failed', 'permanently_failed', 'cancelled'] as const;

/** Layer 13B — an amount the server built from the suggested Food's servings
 * ("2 cups" -> 2 x "1 cup" = 60 g of spinach), with what it had to assume. */
export const suggestedAmountSchema = z.object({
  quantity: z.number(),
  unit: z.string().optional(),
  serving_id: z.string().optional(),
  serving_description: z.string().optional(),
  grams: z.number().nullable().default(null),
  assumptions: z.array(z.string()).default([]),
});
export type SuggestedAmount = z.infer<typeof suggestedAmountSchema>;

export const importDraftIngredientSchema = z.object({
  /** The line exactly as the page published it. */
  text: z.string(),
  quantity: z.number().optional(),
  unit: z.string().optional(),
  /** Why no amount was filled in although the line starts with a number. */
  note: z.string().optional(),
  /** Layer 13A.1 — a proposed Food; it counts only after the user confirms it.
   * Layer 13B — with the server's match details: `auto` (clear enough to be
   * pre-linked for review), why it is not certain, the preparation state, a
   * calculable amount from the Food's own servings, and close alternatives. */
  suggestion: z
    .object({
      food_id: z.string(),
      name: z.string(),
      confidence: z.number(),
      auto: z.boolean().default(false),
      reasons: z.array(z.string()).default([]),
      state: z.object({ line: z.string().nullable(), food: z.string().nullable() }).nullable().default(null),
      amount: suggestedAmountSchema.nullable().default(null).catch(null),
      alternatives: z
        .array(z.object({ food_id: z.string(), name: z.string(), state: z.string().nullable(), confidence: z.number(), amount: suggestedAmountSchema.nullable().default(null).catch(null) }))
        .default([])
        .catch([]),
    })
    .optional(),
});
/** Layer 13A.1 — nutrition as the source page states it (schema.org names), per serving. Never calculated or used in totals. */
export const statedNutritionSchema = z.object({
  serving_size: z.string().nullable(),
  values: z.array(z.object({ field: z.string(), text: z.string() })),
});
export type StatedNutrition = z.infer<typeof statedNutritionSchema>;

export type ImportDraftIngredient = z.infer<typeof importDraftIngredientSchema>;

export const importDraftSchema = z.object({
  title: z.string(),
  description: z.string().nullable(),
  servings: z.number().nullable(),
  yield_text: z.string().nullable(),
  ingredients: z.array(importDraftIngredientSchema),
  instructions: z.array(z.string()),
  truncated: z.boolean().default(false),
  source_nutrition: statedNutritionSchema.nullable().default(null),
});
export type ImportDraft = z.infer<typeof importDraftSchema>;

export const recipeImportSchema = z.object({
  id: z.string(),
  status: z.enum(IMPORT_STATUSES),
  error_code: z.string().nullable(),
  source: z.object({ url: z.string(), original_url: z.string(), provider: z.string() }).nullable(),
  draft: importDraftSchema.nullable(),
  /** The recipe saved from this import. */
  recipe_id: z.string().nullable(),
  /** A recipe in this profile already imported from the same link. */
  existing_recipe_id: z.string().nullable(),
});
export type RecipeImport = z.infer<typeof recipeImportSchema>;
