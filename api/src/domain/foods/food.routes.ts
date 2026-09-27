// Layer 5A — read-only food reference routes plus food-aware conversion.
// No POST/PATCH/DELETE on any food entity: reference data is written only by
// a trusted ingestion workflow (see food.service.ts). POST /convert computes
// and returns a result without persisting anything.

import { Router } from 'express';
import { AppError } from '../../lib/errors';
import { validate } from '../../middleware/validate';
import { foodConversionSchema } from '../conversion/conversion.schemas';
import {
  foodDetailQuerySchema,
  foodIdParamSchema,
  foodSearchQuerySchema,
  nutrientListQuerySchema,
  type FoodDetailQuery,
  type FoodSearchQuery,
  type NutrientListQuery,
} from './food.schemas';
import type { FoodService } from './food.service';

export function createFoodRouter(service: FoodService): Router {
  const router = Router();

  router.get('/', validate({ query: foodSearchQuerySchema }), async (req, res, next) => {
    if (!req.auth) return next(AppError.unauthenticated());
    try {
      const page = await service.search(req.auth, req.query as unknown as FoodSearchQuery);
      res.status(200).json(page);
    } catch (err) {
      next(err);
    }
  });

  router.get('/:food_id', validate({ params: foodIdParamSchema, query: foodDetailQuerySchema }), async (req, res, next) => {
    if (!req.auth) return next(AppError.unauthenticated());
    try {
      const { food_id } = req.params as unknown as { food_id: string };
      const dto = await service.getFood(req.auth, food_id, req.query as unknown as FoodDetailQuery);
      res.status(200).json(dto);
    } catch (err) {
      next(err);
    }
  });

  router.post('/:food_id/convert', validate({ params: foodIdParamSchema, body: foodConversionSchema }), async (req, res, next) => {
    if (!req.auth) return next(AppError.unauthenticated());
    try {
      const { food_id } = req.params as unknown as { food_id: string };
      const result = await service.convertForFood(req.auth, food_id, req.body);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export function createNutrientRouter(service: FoodService): Router {
  const router = Router();

  router.get('/', validate({ query: nutrientListQuerySchema }), async (req, res, next) => {
    if (!req.auth) return next(AppError.unauthenticated());
    try {
      const page = await service.listNutrients(req.auth, req.query as unknown as NutrientListQuery);
      res.status(200).json(page);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
