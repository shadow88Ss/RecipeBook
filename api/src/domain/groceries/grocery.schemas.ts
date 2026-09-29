// Layer 9A — grocery request contracts. Generation takes NO body: grocery
// requirements are derived by the server; any submitted fields (items,
// quantities, fingerprints, versions) are stripped and ignored.

import { z } from 'zod';
import { paginationQuerySchema } from '../../lib/pagination';
import { mealPlanParamSchema } from '../mealPlans/mealPlan.schemas';
import { profileIdParamSchema } from '../profiles/profile.schemas';

export const groceryGenerateSchema = z.object({});

export const groceryListQuerySchema = paginationQuerySchema.extend({
  meal_plan_id: z.uuid().optional(),
  status: z.enum(['active', 'superseded']).optional(),
});
export type GroceryListQuery = z.infer<typeof groceryListQuerySchema>;

export const groceryPlanParamSchema = mealPlanParamSchema;
export const groceryListParamSchema = profileIdParamSchema.extend({ grocery_list_id: z.uuid({ message: 'grocery_list_id must be a valid UUID.' }) });
