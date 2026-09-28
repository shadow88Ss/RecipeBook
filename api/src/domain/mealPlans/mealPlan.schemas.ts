// Layer 8A — Meal Planning request contracts (planned INTENT).
//
// A planned item is exactly one of:
//   { type: "food",   food_id, quantity, unit | serving_id }
//   { type: "recipe", recipe_id, recipe_version_id, servings }
// Nutrition is never accepted from clients: the server computes it (live for
// draft/planned items, as an immutable snapshot at confirmation). Status
// "confirmed", snapshots, supersession links and actors are server-owned;
// undeclared fields are stripped (middleware/validate.ts).

import { z } from 'zod';
import { paginationQuerySchema } from '../../lib/pagination';
import { quantitySchema } from '../conversion/conversion.schemas';
import { localDateSchema, MEAL_TYPES, timeZoneSchema } from '../meals/meal.schemas';
import { unitCodeSchema } from '../nutrition/nutrition.schemas';
import { profileIdParamSchema } from '../profiles/profile.schemas';

export const MEAL_PLAN_STATUSES = ['draft', 'active', 'completed', 'cancelled', 'archived'] as const;
export const MAX_PLAN_DAYS = 366;
export const MAX_ITEMS_PER_REQUEST = 50;
export const MAX_RECIPE_SERVINGS_PLANNED = 100;
const MAX_POSITION = 1000;

const positionSchema = z.number().int().min(0).max(MAX_POSITION);
const notesSchema = z
  .string()
  .trim()
  .max(2000)
  .transform((v) => (v.length ? v : null));

export const plannedItemInputSchema = z
  .discriminatedUnion('type', [
    z.object({
      type: z.literal('food'),
      food_id: z.uuid(),
      quantity: quantitySchema,
      unit: unitCodeSchema.optional(),
      serving_id: z.uuid().optional(),
      position: positionSchema.optional(),
    }),
    z.object({
      type: z.literal('recipe'),
      recipe_id: z.uuid(),
      recipe_version_id: z.uuid(),
      servings: z.number().finite().positive().max(MAX_RECIPE_SERVINGS_PLANNED),
      position: positionSchema.optional(),
    }),
  ])
  .superRefine((item, ctx) => {
    if (item.type === 'food' && (item.unit === undefined) === (item.serving_id === undefined)) {
      ctx.addIssue({ code: 'custom', path: ['unit'], message: 'Provide exactly one of unit or serving_id.' });
    }
  });
export type PlannedItemInput = z.infer<typeof plannedItemInputSchema>;

const dateRange = <T extends { start_date?: string; end_date?: string }>(v: T) =>
  v.start_date === undefined || v.end_date === undefined || v.start_date <= v.end_date;

export const mealPlanCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    description: notesSchema.nullable().optional(),
    start_date: localDateSchema,
    end_date: localDateSchema,
    local_timezone: timeZoneSchema,
  })
  .refine(dateRange, { message: 'start_date must not be after end_date.', path: ['end_date'] })
  .refine((v) => (Date.parse(v.end_date) - Date.parse(v.start_date)) / 86_400_000 < MAX_PLAN_DAYS, {
    message: `A plan covers at most ${MAX_PLAN_DAYS} days.`,
    path: ['end_date'],
  });
export type MealPlanCreateInput = z.infer<typeof mealPlanCreateSchema>;

/** `active` is reached only through /confirm. */
export const mealPlanPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    description: notesSchema.nullable().optional(),
    start_date: localDateSchema.optional(),
    end_date: localDateSchema.optional(),
    local_timezone: timeZoneSchema.optional(),
    status: z.enum(['completed', 'cancelled', 'archived']).optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Provide at least one field to change.' });
export type MealPlanPatchInput = z.infer<typeof mealPlanPatchSchema>;

export const mealPlanDayCreateSchema = z.object({ plan_date: localDateSchema });

export const plannedMealCreateSchema = z.object({
  meal_type: z.enum(MEAL_TYPES),
  /** Wall-clock time in the plan's local_timezone. */
  scheduled_local_time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'scheduled_local_time must be HH:MM (24-hour).')
    .optional(),
  notes: notesSchema.nullable().optional(),
  position: positionSchema.optional(),
  items: z.array(plannedItemInputSchema).max(MAX_ITEMS_PER_REQUEST).default([]),
});
export type PlannedMealCreateInput = z.infer<typeof plannedMealCreateSchema>;

export const plannedItemsAddSchema = z.object({ items: z.array(plannedItemInputSchema).min(1).max(MAX_ITEMS_PER_REQUEST) });

/** Draft/planned items only. The source (Food / RecipeVersion) is fixed:
 * change it by cancelling and adding a new item. */
export const plannedItemPatchSchema = z
  .object({
    status: z.enum(['planned', 'cancelled']).optional(),
    quantity: quantitySchema.optional(),
    unit: unitCodeSchema.optional(),
    serving_id: z.uuid().optional(),
    servings: z.number().finite().positive().max(MAX_RECIPE_SERVINGS_PLANNED).optional(),
    position: positionSchema.optional(),
  })
  .refine((b) => !(b.unit !== undefined && b.serving_id !== undefined), { message: 'Provide at most one of unit or serving_id.', path: ['unit'] })
  .refine((b) => Object.values(b).some((v) => v !== undefined), { message: 'Provide at least one field to change.' });
export type PlannedItemPatchInput = z.infer<typeof plannedItemPatchSchema>;

export const mealPlanListQuerySchema = paginationQuerySchema.extend({ status: z.enum(MEAL_PLAN_STATUSES).optional() });
export type MealPlanListQuery = z.infer<typeof mealPlanListQuerySchema>;

export const mealPlanParamSchema = profileIdParamSchema.extend({ meal_plan_id: z.uuid({ message: 'meal_plan_id must be a valid UUID.' }) });
export const mealPlanDayParamSchema = mealPlanParamSchema.extend({ meal_plan_day_id: z.uuid() });
export const plannedMealParamSchema = mealPlanParamSchema.extend({ planned_meal_id: z.uuid() });
export const plannedItemParamSchema = mealPlanParamSchema.extend({ planned_meal_item_id: z.uuid() });
