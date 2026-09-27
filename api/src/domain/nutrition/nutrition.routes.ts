// Layer 5B — POST /v1/nutrition/calculate. A deterministic computation:
// reads reference data, persists nothing, safe to retry.

import { Router } from 'express';
import { AppError } from '../../lib/errors';
import { validate } from '../../middleware/validate';
import { nutritionCalculateSchema, type NutritionCalculateRequest } from './nutrition.schemas';
import type { NutritionService } from './nutrition.service';

export function createNutritionRouter(service: NutritionService): Router {
  const router = Router();

  router.post('/calculate', validate({ body: nutritionCalculateSchema }), async (req, res, next) => {
    if (!req.auth) return next(AppError.unauthenticated());
    try {
      const result = await service.calculate(req.auth, req.body as NutritionCalculateRequest);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
