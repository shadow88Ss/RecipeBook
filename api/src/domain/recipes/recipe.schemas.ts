// Layer 6A — Recipe Book request contracts.
//
// Array order is the only ordering input: ingredient `sort_order` and
// instruction `step_number` are assigned 1..n from array position, so a
// client can never submit gaps, duplicates or out-of-order step numbers.
//
// Ingredient amount forms (Layer 5A):
//   quantity + unit        an exact registry unit code (g, kg, ml, cup_us, ...)
//   quantity + serving_id  a FoodServing of THIS ingredient's food
//   quantity alone         a count with no unit ("2 eggs") — kept for the
//                          recipe/grocery record, not calculable
//   nothing                "salt to taste" — kept, not calculable
// A user-entered quantity is recipe-specific input: it never creates or
// changes a global FoodServing (Layer 5C authority rules).
//
// Server-owned fields (match_status, match_confidence, sort_order,
// step_number, version_number, visibility) are not accepted from clients;
// undeclared fields are stripped (middleware/validate.ts policy).

import { z } from 'zod';
import { paginationQuerySchema } from '../../lib/pagination';
import { quantitySchema } from '../conversion/conversion.schemas';
import { unitCodeSchema } from '../nutrition/nutrition.schemas';
import { profileIdParamSchema } from '../profiles/profile.schemas';

export const MAX_RECIPE_INGREDIENTS = 100;
export const MAX_RECIPE_INSTRUCTIONS = 100;
export const MAX_RECIPE_SERVINGS = 1000;

const titleSchema = z.string().trim().min(1).max(200);
const descriptionSchema = z.string().trim().max(5000);
/** Recipe yield as a serving count. Fractional yields ("2.5 servings") are
 * allowed; zero, negative, NaN and Infinity are not. */
export const servingsSchema = z.number().finite().positive().max(MAX_RECIPE_SERVINGS);
const instructionSchema = z.string().trim().min(1).max(5000);

export const recipeIngredientInputSchema = z
  .object({
    /** The ingredient line as the user wrote it ("125 g chicken breast,
     * diced") — stored as raw_ingredient_text, never rewritten. */
    text: z.string().trim().min(1).max(500),
    /** The canonical Food the user selected. Omit to keep the ingredient
     * unresolved — it is stored as text only, never force-matched. */
    food_id: z.uuid().optional(),
    serving_id: z.uuid().optional(),
    quantity: quantitySchema.optional(),
    unit: unitCodeSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.unit !== undefined && value.serving_id !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['serving_id'], message: 'Provide at most one of unit or serving_id.' });
    }
    if (value.serving_id !== undefined && value.food_id === undefined) {
      ctx.addIssue({ code: 'custom', path: ['serving_id'], message: 'serving_id requires food_id (the serving must belong to that food).' });
    }
    if ((value.unit !== undefined || value.serving_id !== undefined) && value.quantity === undefined) {
      ctx.addIssue({ code: 'custom', path: ['quantity'], message: 'quantity is required with unit or serving_id.' });
    }
  });
export type RecipeIngredientInput = z.infer<typeof recipeIngredientInputSchema>;

const ingredientsSchema = z.array(recipeIngredientInputSchema).min(1).max(MAX_RECIPE_INGREDIENTS);
const instructionsSchema = z.array(instructionSchema).max(MAX_RECIPE_INSTRUCTIONS);

export const recipeCreateSchema = z.object({
  title: titleSchema,
  description: descriptionSchema.nullable().optional(),
  servings: servingsSchema,
  ingredients: ingredientsSchema,
  instructions: instructionsSchema.default([]),
});
export type RecipeCreateInput = z.infer<typeof recipeCreateSchema>;

/** PATCH creates a NEW RecipeVersion. Omitted fields are carried over from
 * the current version; `ingredients`/`instructions`, when present, replace
 * the whole list. */
export const recipePatchSchema = z
  .object({
    title: titleSchema.optional(),
    description: descriptionSchema.nullable().optional(),
    servings: servingsSchema.optional(),
    ingredients: ingredientsSchema.optional(),
    instructions: instructionsSchema.optional(),
    /** Optional optimistic-concurrency guard: refuse (409) if the recipe's
     * current version is no longer this one. */
    expected_current_version_id: z.uuid().optional(),
  })
  .refine(
    (body) =>
      body.title !== undefined ||
      body.description !== undefined ||
      body.servings !== undefined ||
      body.ingredients !== undefined ||
      body.instructions !== undefined,
    { message: 'At least one of title, description, servings, ingredients or instructions must be provided.' },
  );
export type RecipePatchInput = z.infer<typeof recipePatchSchema>;

export const recipeIdParamSchema = profileIdParamSchema.extend({
  recipe_id: z.uuid({ message: 'recipe_id must be a valid UUID.' }),
});

export const recipeVersionParamSchema = recipeIdParamSchema.extend({
  version_id: z.uuid({ message: 'version_id must be a valid UUID.' }),
});

/** NFKC, trimmed, whitespace-collapsed, lower-cased — the same shape of
 * normalization as food search. */
export function normalizeSearchText(text: string): string {
  return text.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export const recipeListQuerySchema = paginationQuerySchema.extend({
  q: z
    .string()
    .max(100)
    .transform(normalizeSearchText)
    .refine((value) => value.length > 0, 'q must not be blank.')
    .optional(),
});
export type RecipeListQuery = z.infer<typeof recipeListQuerySchema>;

export const recipeVariantParamSchema = profileIdParamSchema.extend({
  variant_id: z.uuid({ message: 'variant_id must be a valid UUID.' }),
});

export const recipeVariantListQuerySchema = paginationQuerySchema.extend({
  base_recipe_id: z.uuid().optional(),
});
export type RecipeVariantListQuery = z.infer<typeof recipeVariantListQuerySchema>;
