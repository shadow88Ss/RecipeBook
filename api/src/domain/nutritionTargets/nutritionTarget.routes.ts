import { Router } from 'express';
import { AppError } from '../../lib/errors';
import { paginationQuerySchema, type PaginationQuery } from '../../lib/pagination';
import { validate } from '../../middleware/validate';
import { profileIdParamSchema } from '../profiles/profile.schemas';
import { nutritionTargetCreateSchema, nutritionTargetHistoryQuerySchema, type NutritionTargetHistoryQuery } from './nutritionTarget.schemas';
import type { NutritionTargetService } from './nutritionTarget.service';

export function createNutritionTargetRouter(service: NutritionTargetService): Router {
  const router = Router({ mergeParams: true });

  router.get('/', validate({ params: profileIdParamSchema, query: paginationQuerySchema }), async (req, res, next) => {
    if (!req.auth) return next(AppError.unauthenticated());
    try {
      const { profile_id } = req.params as unknown as { profile_id: string };
      const page = await service.listActive(req.auth, profile_id, req.query as unknown as PaginationQuery);
      res.status(200).json(page);
    } catch (err) {
      next(err);
    }
  });

  // Static sub-path, not a :id route — nutrition_target rows are never
  // fetched individually by id through this API (only as the current-active
  // set or as history), matching the field-level, supersession-based model.
  router.get('/history', validate({ params: profileIdParamSchema, query: nutritionTargetHistoryQuerySchema }), async (req, res, next) => {
    if (!req.auth) return next(AppError.unauthenticated());
    try {
      const { profile_id } = req.params as unknown as { profile_id: string };
      const page = await service.listHistory(req.auth, profile_id, req.query as unknown as NutritionTargetHistoryQuery);
      res.status(200).json(page);
    } catch (err) {
      next(err);
    }
  });

  router.post('/', validate({ params: profileIdParamSchema, body: nutritionTargetCreateSchema }), async (req, res, next) => {
    if (!req.auth) return next(AppError.unauthenticated());
    try {
      const { profile_id } = req.params as unknown as { profile_id: string };
      const dto = await service.create(req.auth, profile_id, req.body);
      res.status(201).json(dto);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
