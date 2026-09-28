// Layer 8A — Meal Planning routes, mounted at
// /v1/profiles/:profile_id/meal-plans. No DELETE anywhere (items are
// cancelled; confirmed items are replaced) and no actual-logging endpoints.

import { Router, type Request, type RequestHandler } from 'express';
import { AppError } from '../../lib/errors';
import { validate } from '../../middleware/validate';
import type { AuthContext } from '../../types/express';
import { profileIdParamSchema } from '../profiles/profile.schemas';
import {
  mealPlanCreateSchema,
  mealPlanDayCreateSchema,
  mealPlanDayParamSchema,
  mealPlanListQuerySchema,
  mealPlanParamSchema,
  mealPlanPatchSchema,
  plannedItemInputSchema,
  plannedItemParamSchema,
  plannedItemPatchSchema,
  plannedItemsAddSchema,
  plannedMealCreateSchema,
  plannedMealParamSchema,
  type MealPlanCreateInput,
  type MealPlanListQuery,
  type MealPlanPatchInput,
  type PlannedItemInput,
  type PlannedItemPatchInput,
  type PlannedMealCreateInput,
} from './mealPlan.schemas';
import type { MealPlanService } from './mealPlan.service';

type Params = { profile_id: string; meal_plan_id: string; meal_plan_day_id: string; planned_meal_id: string; planned_meal_item_id: string };

function handle(status: number, fn: (auth: AuthContext, p: Params, req: Request) => Promise<unknown>): RequestHandler {
  return async (req, res, next) => {
    if (!req.auth) return next(AppError.unauthenticated());
    try {
      res.status(status).json(await fn(req.auth, req.params as unknown as Params, req));
    } catch (err) {
      next(err);
    }
  };
}

export function createMealPlanRouter(service: MealPlanService): Router {
  const r = Router({ mergeParams: true });
  r.get('/', validate({ params: profileIdParamSchema, query: mealPlanListQuerySchema }), handle(200, (a, p, req) => service.list(a, p.profile_id, req.query as unknown as MealPlanListQuery)));
  r.post('/', validate({ params: profileIdParamSchema, body: mealPlanCreateSchema }), handle(201, (a, p, req) => service.create(a, p.profile_id, req.body as MealPlanCreateInput)));
  r.get('/:meal_plan_id', validate({ params: mealPlanParamSchema }), handle(200, (a, p) => service.get(a, p.profile_id, p.meal_plan_id)));
  r.patch('/:meal_plan_id', validate({ params: mealPlanParamSchema, body: mealPlanPatchSchema }), handle(200, (a, p, req) => service.update(a, p.profile_id, p.meal_plan_id, req.body as MealPlanPatchInput)));
  r.get('/:meal_plan_id/days', validate({ params: mealPlanParamSchema }), handle(200, (a, p) => service.days(a, p.profile_id, p.meal_plan_id)));
  r.post('/:meal_plan_id/days', validate({ params: mealPlanParamSchema, body: mealPlanDayCreateSchema }), handle(201, (a, p, req) => service.addDay(a, p.profile_id, p.meal_plan_id, (req.body as { plan_date: string }).plan_date)));
  r.post(
    '/:meal_plan_id/days/:meal_plan_day_id/meals',
    validate({ params: mealPlanDayParamSchema, body: plannedMealCreateSchema }),
    handle(201, (a, p, req) => service.addMeal(a, p.profile_id, p.meal_plan_id, p.meal_plan_day_id, req.body as PlannedMealCreateInput)),
  );
  r.post(
    '/:meal_plan_id/meals/:planned_meal_id/items',
    validate({ params: plannedMealParamSchema, body: plannedItemsAddSchema }),
    handle(201, (a, p, req) => service.addItems(a, p.profile_id, p.meal_plan_id, p.planned_meal_id, (req.body as { items: PlannedItemInput[] }).items)),
  );
  r.get('/:meal_plan_id/items/:planned_meal_item_id', validate({ params: plannedItemParamSchema }), handle(200, (a, p) => service.itemDetailPublic(a, p.profile_id, p.meal_plan_id, p.planned_meal_item_id)));
  r.patch(
    '/:meal_plan_id/items/:planned_meal_item_id',
    validate({ params: plannedItemParamSchema, body: plannedItemPatchSchema }),
    handle(200, (a, p, req) => service.updateItem(a, p.profile_id, p.meal_plan_id, p.planned_meal_item_id, req.body as PlannedItemPatchInput)),
  );
  r.post(
    '/:meal_plan_id/items/:planned_meal_item_id/replace',
    validate({ params: plannedItemParamSchema, body: plannedItemInputSchema }),
    handle(201, (a, p, req) => service.replaceItem(a, p.profile_id, p.meal_plan_id, p.planned_meal_item_id, req.body as PlannedItemInput)),
  );
  r.get('/:meal_plan_id/nutrition', validate({ params: mealPlanParamSchema }), handle(200, (a, p) => service.nutrition(a, p.profile_id, p.meal_plan_id)));
  r.post('/:meal_plan_id/confirm', validate({ params: mealPlanParamSchema }), handle(200, (a, p) => service.confirm(a, p.profile_id, p.meal_plan_id)));
  return r;
}
