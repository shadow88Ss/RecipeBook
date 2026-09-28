// Layer 8B — planned vs actual request contracts. Only the relationship is
// accepted from clients; fulfillment states, quantities and nutrition are
// derived by the server. Undeclared fields are stripped (validate.ts).

import { z } from 'zod';
import { localDateSchema } from '../meals/meal.schemas';
import { mealPlanParamSchema, plannedItemParamSchema } from './mealPlan.schemas';

export const actualLinkCreateSchema = z.object({
  meal_item_id: z.uuid(),
  relationship_type: z.enum(['same_item', 'substitution']),
});
export type ActualLinkCreateInput = z.infer<typeof actualLinkCreateSchema>;

export const skipCreateSchema = z.object({
  reason: z
    .string()
    .trim()
    .max(500)
    .transform((v) => (v.length ? v : null))
    .nullable()
    .optional(),
});
export type SkipCreateInput = z.infer<typeof skipCreateSchema>;

export { plannedItemParamSchema };
export const actualLinkParamSchema = mealPlanParamSchema.extend({ planned_actual_link_id: z.uuid() });
export const fulfillmentDayParamSchema = mealPlanParamSchema.extend({ plan_date: localDateSchema });
