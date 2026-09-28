// Layer 7A — meal logging routes, mounted at /v1/profiles/:profile_id/meals.
// Actual consumption only: no PATCH/PUT/DELETE of items (corrections are a
// separate, additive action) and no planning endpoints.

import { Router, type Request, type RequestHandler } from 'express';
import { AppError } from '../../lib/errors';
import { validate } from '../../middleware/validate';
import type { AuthContext } from '../../types/express';
import { profileIdParamSchema } from '../profiles/profile.schemas';
import {
  mealCreateSchema,
  mealItemCorrectSchema,
  mealItemParamSchema,
  mealItemsAddSchema,
  mealListQuerySchema,
  mealParamSchema,
  type MealCreateInput,
  type MealItemCorrectInput,
  type MealItemsAddInput,
  type MealListQuery,
} from './meal.schemas';
import type { MealService } from './meal.service';

type Params = { profile_id: string; meal_log_id: string; meal_item_id: string };

function handle(status: number, fn: (auth: AuthContext, params: Params, req: Request) => Promise<unknown>): RequestHandler {
  return async (req, res, next) => {
    if (!req.auth) return next(AppError.unauthenticated());
    try {
      res.status(status).json(await fn(req.auth, req.params as unknown as Params, req));
    } catch (err) {
      next(err);
    }
  };
}

export function createMealRouter(service: MealService): Router {
  const router = Router({ mergeParams: true });

  router.get(
    '/',
    validate({ params: profileIdParamSchema, query: mealListQuerySchema }),
    handle(200, (auth, p, req) => service.list(auth, p.profile_id, req.query as unknown as MealListQuery)),
  );
  router.post(
    '/',
    validate({ params: profileIdParamSchema, body: mealCreateSchema }),
    handle(201, (auth, p, req) => service.create(auth, p.profile_id, req.body as MealCreateInput)),
  );
  router.get(
    '/:meal_log_id',
    validate({ params: mealParamSchema }),
    handle(200, (auth, p) => service.get(auth, p.profile_id, p.meal_log_id)),
  );
  router.get(
    '/:meal_log_id/nutrition',
    validate({ params: mealParamSchema }),
    handle(200, (auth, p) => service.nutrition(auth, p.profile_id, p.meal_log_id)),
  );
  router.post(
    '/:meal_log_id/items',
    validate({ params: mealParamSchema, body: mealItemsAddSchema }),
    handle(201, (auth, p, req) => service.addItems(auth, p.profile_id, p.meal_log_id, req.body as MealItemsAddInput)),
  );
  router.get(
    '/:meal_log_id/items/:meal_item_id',
    validate({ params: mealItemParamSchema }),
    handle(200, (auth, p) => service.getItem(auth, p.profile_id, p.meal_log_id, p.meal_item_id)),
  );
  router.post(
    '/:meal_log_id/items/:meal_item_id/correct',
    validate({ params: mealItemParamSchema, body: mealItemCorrectSchema }),
    handle(201, (auth, p, req) => service.correct(auth, p.profile_id, p.meal_log_id, p.meal_item_id, req.body as MealItemCorrectInput)),
  );

  return router;
}
