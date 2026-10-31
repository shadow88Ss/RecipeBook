// Layer 13A — recipe import DTOs, written from docs/30_API.md §33 (no backend
// runtime code is imported). Only the fields the app renders are validated.

import { z } from 'zod';

export const IMPORT_STATUSES = ['queued', 'processing', 'needs_confirmation', 'succeeded', 'retryable_failed', 'permanently_failed', 'cancelled'] as const;

export const importDraftIngredientSchema = z.object({
  /** The line exactly as the page published it. */
  text: z.string(),
  quantity: z.number().optional(),
  unit: z.string().optional(),
  /** Why no amount was filled in although the line starts with a number. */
  note: z.string().optional(),
});
export type ImportDraftIngredient = z.infer<typeof importDraftIngredientSchema>;

export const importDraftSchema = z.object({
  title: z.string(),
  description: z.string().nullable(),
  servings: z.number().nullable(),
  yield_text: z.string().nullable(),
  ingredients: z.array(importDraftIngredientSchema),
  instructions: z.array(z.string()),
  truncated: z.boolean().default(false),
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
