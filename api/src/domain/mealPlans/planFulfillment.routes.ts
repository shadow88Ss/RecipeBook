// Layer 8B — planned vs actual routes, mounted at
// /v1/profiles/:profile_id/meal-plans alongside the Layer 8A router. Links
// and skips are revoked, never deleted; fulfillment is read-only.

import { Router, type RequestHandler } from 'express';
import { AppError } from '../../lib/errors';
import { validate } from '../../middleware/validate';
import type { AuthContext } from '../../types/express';
import {
  actualLinkCreateSchema,
  actualLinkParamSchema,
  fulfillmentDayParamSchema,
  plannedItemParamSchema,
  skipCreateSchema,
  type ActualLinkCreateInput,
  type SkipCreateInput,
} from './planFulfillment.schemas';
import { mealPlanParamSchema } from './mealPlan.schemas';
import type { PlanFulfillmentService } from './planFulfillment.service';

type Params = { profile_id: string; meal_plan_id: string; planned_meal_item_id: string; planned_actual_link_id: string; plan_date: string };

function handle(status: number, fn: (auth: AuthContext, p: Params, body: unknown) => Promise<unknown>): RequestHandler {
  return async (req, res, next) => {
    if (!req.auth) return next(AppError.unauthenticated());
    try {
      res.status(status).json(await fn(req.auth, req.params as unknown as Params, req.body));
    } catch (err) {
      next(err);
    }
  };
}

export function createPlanFulfillmentRouter(service: PlanFulfillmentService): Router {
  const r = Router({ mergeParams: true });
  r.post(
    '/:meal_plan_id/items/:planned_meal_item_id/actual-links',
    validate({ params: plannedItemParamSchema, body: actualLinkCreateSchema }),
    handle(201, (a, p, body) => service.createLink(a, p.profile_id, p.meal_plan_id, p.planned_meal_item_id, body as ActualLinkCreateInput)),
  );
  r.post(
    '/:meal_plan_id/actual-links/:planned_actual_link_id/revoke',
    validate({ params: actualLinkParamSchema }),
    handle(200, (a, p) => service.revokeLink(a, p.profile_id, p.meal_plan_id, p.planned_actual_link_id)),
  );
  r.post(
    '/:meal_plan_id/items/:planned_meal_item_id/skip',
    validate({ params: plannedItemParamSchema, body: skipCreateSchema }),
    handle(201, (a, p, body) => service.skip(a, p.profile_id, p.meal_plan_id, p.planned_meal_item_id, (body ?? {}) as SkipCreateInput)),
  );
  r.post('/:meal_plan_id/items/:planned_meal_item_id/unskip', validate({ params: plannedItemParamSchema }), handle(200, (a, p) => service.unskip(a, p.profile_id, p.meal_plan_id, p.planned_meal_item_id)));
  r.get('/:meal_plan_id/fulfillment', validate({ params: mealPlanParamSchema }), handle(200, (a, p) => service.plan(a, p.profile_id, p.meal_plan_id)));
  r.get('/:meal_plan_id/fulfillment/days/:plan_date', validate({ params: fulfillmentDayParamSchema }), handle(200, (a, p) => service.day(a, p.profile_id, p.meal_plan_id, p.plan_date)));
  r.get(
    '/:meal_plan_id/items/:planned_meal_item_id/fulfillment',
    validate({ params: plannedItemParamSchema }),
    handle(200, (a, p) => service.item(a, p.profile_id, p.meal_plan_id, p.planned_meal_item_id)),
  );
  return r;
}
