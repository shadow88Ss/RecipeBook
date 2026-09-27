// Layer 4B §3 — Goal proof endpoints. Mounted with mergeParams so
// :profile_id from the parent /v1/profiles/:profile_id mount is visible
// here (see routes/v1.ts).

import { Router } from 'express';
import { AppError } from '../../lib/errors';
import { paginationQuerySchema, type PaginationQuery } from '../../lib/pagination';
import { validate } from '../../middleware/validate';
import { profileIdParamSchema } from '../profiles/profile.schemas';
import { goalCreateSchema, goalIdParamSchema, goalPatchSchema } from './goal.schemas';
import type { GoalService } from './goal.service';

export function createGoalRouter(service: GoalService): Router {
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

  router.get('/:goal_id', validate({ params: goalIdParamSchema }), async (req, res, next) => {
    if (!req.auth) return next(AppError.unauthenticated());
    try {
      const { profile_id, goal_id } = req.params as unknown as { profile_id: string; goal_id: string };
      const dto = await service.getOne(req.auth, profile_id, goal_id);
      res.status(200).json(dto);
    } catch (err) {
      next(err);
    }
  });

  router.post('/', validate({ params: profileIdParamSchema, body: goalCreateSchema }), async (req, res, next) => {
    if (!req.auth) return next(AppError.unauthenticated());
    try {
      const { profile_id } = req.params as unknown as { profile_id: string };
      const dto = await service.create(req.auth, profile_id, req.body);
      res.status(201).json(dto);
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:goal_id', validate({ params: goalIdParamSchema, body: goalPatchSchema }), async (req, res, next) => {
    if (!req.auth) return next(AppError.unauthenticated());
    try {
      const { profile_id, goal_id } = req.params as unknown as { profile_id: string; goal_id: string };
      const dto = await service.update(req.auth, profile_id, goal_id, req.body);
      res.status(200).json(dto);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
