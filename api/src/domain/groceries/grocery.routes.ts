// Layer 9A — Grocery Planning routes. Plan-scoped (preview, generate, a
// plan's generations) under /v1/profiles/:profile_id/meal-plans; lists
// under /v1/profiles/:profile_id/grocery-lists. No PATCH/DELETE: generated
// lists are immutable; regeneration creates a new generation.

import { Router, type Request, type RequestHandler } from 'express';
import { AppError } from '../../lib/errors';
import { validate } from '../../middleware/validate';
import type { AuthContext } from '../../types/express';
import { profileIdParamSchema } from '../profiles/profile.schemas';
import { groceryGenerateSchema, groceryListParamSchema, groceryListQuerySchema, groceryPlanParamSchema, type GroceryListQuery } from './grocery.schemas';
import type { GroceryService } from './grocery.service';

type Params = { profile_id: string; meal_plan_id: string; grocery_list_id: string };

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

export function createPlanGroceryRouter(service: GroceryService): Router {
  const r = Router({ mergeParams: true });
  r.get('/:meal_plan_id/grocery-preview', validate({ params: groceryPlanParamSchema }), handle(200, (a, p) => service.preview(a, p.profile_id, p.meal_plan_id)));
  r.post('/:meal_plan_id/grocery-lists', validate({ params: groceryPlanParamSchema, body: groceryGenerateSchema }), handle(201, (a, p) => service.generate(a, p.profile_id, p.meal_plan_id)));
  r.get(
    '/:meal_plan_id/grocery-lists',
    validate({ params: groceryPlanParamSchema, query: groceryListQuerySchema }),
    handle(200, (a, p, req) => service.list(a, p.profile_id, req.query as unknown as GroceryListQuery, p.meal_plan_id)),
  );
  return r;
}

export function createGroceryListRouter(service: GroceryService): Router {
  const r = Router({ mergeParams: true });
  r.get('/', validate({ params: profileIdParamSchema, query: groceryListQuerySchema }), handle(200, (a, p, req) => service.list(a, p.profile_id, req.query as unknown as GroceryListQuery)));
  r.get('/:grocery_list_id', validate({ params: groceryListParamSchema }), handle(200, (a, p) => service.get(a, p.profile_id, p.grocery_list_id)));
  return r;
}
