// Layer 12C — Meal Planning DTOs, written from docs/30_API.md §21 (no backend
// runtime code is imported). Only the fields the app renders are validated;
// unknown fields are dropped. Planned nutrition is the server's: live for
// draft/planned items, the stored snapshot for confirmed ones. Planning is
// intent, never consumption.

import { z } from 'zod';

import { localDateSchema, pageSchema } from './common';
import { nutritionSummarySchema } from './dailyTracker';

export const MEAL_PLAN_STATUSES = ['draft', 'active', 'completed', 'cancelled', 'archived'] as const;
export const PLANNED_ITEM_STATUSES = ['draft', 'planned', 'confirmed', 'cancelled'] as const;

const planSummaryFields = {
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  start_date: localDateSchema,
  end_date: localDateSchema,
  local_timezone: z.string(),
  /** Open: a status added on the server is shown generically, not rejected. */
  status: z.string(),
};

export const mealPlanSummarySchema = z.object(planSummaryFields);
export type MealPlanSummary = z.infer<typeof mealPlanSummarySchema>;
export const mealPlanPageSchema = pageSchema(mealPlanSummarySchema);
export type MealPlanPage = z.infer<typeof mealPlanPageSchema>;

/** `no_planned_items`: nothing is planned (the server's known zero), not "no data". */
const plannedNutritionSchema = z.object({
  basis: z.string(),
  summary: nutritionSummarySchema,
  item_count: z.number(),
});
export type PlannedNutrition = z.infer<typeof plannedNutritionSchema>;

export const plannedItemSchema = z.object({
  id: z.string(),
  source_type: z.enum(['food', 'recipe']),
  food: z.object({ food_id: z.string(), canonical_name: z.string().nullable() }).nullable(),
  recipe: z.object({ recipe_id: z.string().nullable(), recipe_version_id: z.string(), version_number: z.number().nullable(), title: z.string().nullable() }).nullable(),
  amount: z.union([
    z.object({ servings: z.number() }),
    z.object({ quantity: z.number(), unit: z.string().nullable(), serving_id: z.string().nullable(), serving_description: z.string().nullable() }),
  ]),
  status: z.string(),
  is_current: z.boolean(),
  is_pending_replacement: z.boolean(),
  superseded_by_planned_meal_item_id: z.string().nullable(),
  /** basis: live_calculation (draft/planned) or confirmed_snapshot. */
  nutrition: plannedNutritionSchema,
});
export type PlannedItem = z.infer<typeof plannedItemSchema>;

export const plannedMealSchema = z.object({
  id: z.string(),
  meal_type: z.string(),
  scheduled_local_time: z.string().nullable(),
  notes: z.string().nullable(),
  items: z.array(plannedItemSchema),
  nutrition: plannedNutritionSchema,
});
export type PlannedMeal = z.infer<typeof plannedMealSchema>;

/** GET /v1/profiles/{id}/meal-plans/{plan} — days → meals → items; totals cover current items only. */
export const mealPlanDetailSchema = z.object({
  ...planSummaryFields,
  current_item_count: z.number(),
  includes_unconfirmed: z.boolean(),
  days: z.array(z.object({ id: z.string(), plan_date: localDateSchema, meals: z.array(plannedMealSchema), nutrition: plannedNutritionSchema })),
});
export type MealPlanDetail = z.infer<typeof mealPlanDetailSchema>;

// ---- Layer 12E — planning writes (request bodies; the server owns status,
// confirmation and every nutrition value) ------------------------------------

export interface MealPlanCreate {
  name: string;
  description: string | null;
  start_date: string;
  end_date: string;
  /** IANA zone of the device; fixed once the plan leaves draft. */
  local_timezone: string;
}

export type PlannedItemInput =
  | { type: 'food'; food_id: string; quantity: number; unit: string }
  | { type: 'food'; food_id: string; quantity: number; serving_id: string }
  | { type: 'recipe'; recipe_id: string; recipe_version_id: string; servings: number };

export interface PlannedMealCreate {
  meal_type: string;
  /** HH:MM in the plan's time zone. */
  scheduled_local_time?: string;
}

/** PATCH …/items/{id} answers with the one item; the app re-reads the plan instead. */
export const plannedItemWrittenSchema = z.object({ id: z.string() });
