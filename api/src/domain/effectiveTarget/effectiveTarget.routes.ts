// Layer 4B §8/§9 — read-only routes. No POST: snapshot creation is kept
// internal (see effectiveTarget.service.ts's createSnapshotInternal doc
// comment).

import { Router } from 'express';
import { AppError } from '../../lib/errors';
import { paginationQuerySchema, type PaginationQuery } from '../../lib/pagination';
import { validate } from '../../middleware/validate';
import { profileIdParamSchema } from '../profiles/profile.schemas';
import type { EffectiveTargetService } from './effectiveTarget.service';

export function createEffectiveTargetRouter(service: EffectiveTargetService): Router {
  const router = Router({ mergeParams: true });

  router.get('/effective-target', validate({ params: profileIdParamSchema }), async (req, res, next) => {
    if (!req.auth) return next(AppError.unauthenticated());
    try {
      const { profile_id } = req.params as unknown as { profile_id: string };
      const dto = await service.resolve(req.auth, profile_id);
      res.status(200).json(dto);
    } catch (err) {
      next(err);
    }
  });

  router.get(
    '/effective-target-snapshots',
    validate({ params: profileIdParamSchema, query: paginationQuerySchema }),
    async (req, res, next) => {
      if (!req.auth) return next(AppError.unauthenticated());
      try {
        const { profile_id } = req.params as unknown as { profile_id: string };
        const page = await service.listSnapshots(req.auth, profile_id, req.query as unknown as PaginationQuery);
        res.status(200).json(page);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
