// Layer 4B §6 — no PATCH, no DELETE: WeightMeasurement is immutable
// historical data (see weightMeasurement.service.ts).

import { Router } from 'express';
import { AppError } from '../../lib/errors';
import { paginationQuerySchema, type PaginationQuery } from '../../lib/pagination';
import { validate } from '../../middleware/validate';
import { profileIdParamSchema } from '../profiles/profile.schemas';
import { weightMeasurementCreateSchema } from './weightMeasurement.schemas';
import type { WeightMeasurementService } from './weightMeasurement.service';

export function createWeightMeasurementRouter(service: WeightMeasurementService): Router {
  const router = Router({ mergeParams: true });

  router.get('/', validate({ params: profileIdParamSchema, query: paginationQuerySchema }), async (req, res, next) => {
    if (!req.auth) return next(AppError.unauthenticated());
    try {
      const { profile_id } = req.params as unknown as { profile_id: string };
      const page = await service.list(req.auth, profile_id, req.query as unknown as PaginationQuery);
      res.status(200).json(page);
    } catch (err) {
      next(err);
    }
  });

  router.post('/', validate({ params: profileIdParamSchema, body: weightMeasurementCreateSchema }), async (req, res, next) => {
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
