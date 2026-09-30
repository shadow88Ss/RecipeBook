// Layer 7A — Food & Meal Logging request contracts.
//
// A MealItem is exactly one of:
//   { type: "food",    food_id, quantity, unit | serving_id }
//   { type: "recipe",  recipe_id, recipe_version_id, servings }
//   { type: "product", product_id | barcode (+ barcode_type), quantity,
//     unit | product_serving_id, label_version_id? }       (Layer 11B)
// Nutrition is never accepted from the client: the server calculates it and
// stores it as the item's snapshot. status, match state, actor, snapshot and
// correction links are server-owned (undeclared fields are stripped).

import { z } from 'zod';
import { paginationQuerySchema } from '../../lib/pagination';
import { quantitySchema } from '../conversion/conversion.schemas';
import { unitCodeSchema } from '../nutrition/nutrition.schemas';
import { BARCODE_TYPES } from '../products/barcode';
import { profileIdParamSchema } from '../profiles/profile.schemas';
import { isValidTimeZone } from './meal.time';

export const MEAL_TYPES = ['breakfast', 'lunch', 'dinner', 'snack', 'other'] as const;
export const MAX_ITEMS_PER_REQUEST = 50;
export const MAX_RECIPE_SERVINGS_CONSUMED = 100;
export const MAX_NOTES_LENGTH = 2000;
export const MAX_CORRECTION_REASON_LENGTH = 500;

/** An unambiguous instant: ISO 8601 with an explicit offset or Z. */
export const instantSchema = z.iso.datetime({ offset: true, message: 'Must be an ISO 8601 timestamp with an offset or Z.' });

export const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a calendar date (YYYY-MM-DD).')
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, 'Must be a valid calendar date.');

export const timeZoneSchema = z.string().max(64).refine(isValidTimeZone, 'Must be an IANA time zone identifier such as Asia/Dubai.');

const foodItemSchema = z.object({
  type: z.literal('food'),
  food_id: z.uuid(),
  quantity: quantitySchema,
  unit: unitCodeSchema.optional(),
  serving_id: z.uuid().optional(),
  consumed_at: instantSchema.optional(),
});

const recipeItemSchema = z.object({
  type: z.literal('recipe'),
  recipe_id: z.uuid(),
  recipe_version_id: z.uuid(),
  /** Servings of the RecipeVersion's yield consumed; fractional allowed. */
  servings: z.number().finite().positive().max(MAX_RECIPE_SERVINGS_CONSUMED),
  consumed_at: instantSchema.optional(),
});

/** Layer 11B — an exact commercial Product, by id or by barcode. The server
 * resolves the barcode, selects the exact ProductLabelVersion and computes
 * nutrition; `quantity` is an amount in `unit`, or a count of the label's
 * ProductServing. `label_version_id` is accepted only to answer a
 * label-version confirmation (backdated logging, approved G1) — or, on a
 * correction, to move off the original's label under the same rule. */
const productItemSchema = z.object({
  type: z.literal('product'),
  product_id: z.uuid().optional(),
  barcode: z.string().min(1).max(64).optional(),
  barcode_type: z.enum(BARCODE_TYPES).optional(),
  quantity: quantitySchema,
  unit: unitCodeSchema.optional(),
  product_serving_id: z.uuid().optional(),
  label_version_id: z.uuid().optional(),
  consumed_at: instantSchema.optional(),
});

export const mealItemInputSchema = z.discriminatedUnion('type', [foodItemSchema, recipeItemSchema, productItemSchema]).superRefine((item, ctx) => {
  if (item.type === 'food' && (item.unit === undefined) === (item.serving_id === undefined)) {
    ctx.addIssue({ code: 'custom', path: ['unit'], message: 'Provide exactly one of unit or serving_id.' });
  }
  if (item.type === 'product') {
    if ((item.product_id === undefined) === (item.barcode === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['product_id'], message: 'Provide exactly one of product_id or barcode.' });
    }
    if (item.barcode_type !== undefined && item.barcode === undefined) {
      ctx.addIssue({ code: 'custom', path: ['barcode_type'], message: 'barcode_type is only accepted with barcode.' });
    }
    if ((item.unit === undefined) === (item.product_serving_id === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['unit'], message: 'Provide exactly one of unit or product_serving_id.' });
    }
  }
});
export type MealItemInput = z.infer<typeof mealItemInputSchema>;
export type ProductItemInput = Extract<MealItemInput, { type: 'product' }>;

const notesSchema = z
  .string()
  .trim()
  .max(MAX_NOTES_LENGTH)
  .transform((value) => (value.length ? value : null));

export const mealCreateSchema = z.object({
  meal_type: z.enum(MEAL_TYPES),
  logged_date: localDateSchema,
  local_timezone: timeZoneSchema,
  notes: notesSchema.nullable().optional(),
  /** Default consumed_at for items that do not carry their own. */
  consumed_at: instantSchema.optional(),
  items: z.array(mealItemInputSchema).max(MAX_ITEMS_PER_REQUEST).default([]),
});
export type MealCreateInput = z.infer<typeof mealCreateSchema>;

export const mealItemsAddSchema = z.object({
  consumed_at: instantSchema.optional(),
  items: z.array(mealItemInputSchema).min(1).max(MAX_ITEMS_PER_REQUEST),
});
export type MealItemsAddInput = z.infer<typeof mealItemsAddSchema>;

export const mealItemCorrectSchema = z.object({
  correction_reason: z.string().trim().min(1).max(MAX_CORRECTION_REASON_LENGTH),
  /** The corrected item. consumed_at defaults to the original's. */
  item: mealItemInputSchema,
});
export type MealItemCorrectInput = z.infer<typeof mealItemCorrectSchema>;

export const mealListQuerySchema = paginationQuerySchema
  .extend({ from: localDateSchema.optional(), to: localDateSchema.optional() })
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, { message: 'from must not be after to.', path: ['from'] });
export type MealListQuery = z.infer<typeof mealListQuerySchema>;

export const mealParamSchema = profileIdParamSchema.extend({
  meal_log_id: z.uuid({ message: 'meal_log_id must be a valid UUID.' }),
});

export const mealItemParamSchema = mealParamSchema.extend({
  meal_item_id: z.uuid({ message: 'meal_item_id must be a valid UUID.' }),
});
