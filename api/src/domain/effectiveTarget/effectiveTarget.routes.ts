// Layer 4B §8/§9 — effective target and snapshot routes. Layer 4B's
// general-purpose snapshot creation stays internal (createSnapshotInternal);
// Layer 10A adds the one public capture action: the explicit, idempotent
// daily target snapshot (POST /target-snapshots), plus daily reads.

import { Router } from 'express';
import { AppError } from '../../lib/errors';
import { paginationQuerySchema, type PaginationQuery } from '../../lib/pagination';
import { validate } from '../../middleware/validate';
import { localDateSchema } from '../meals/meal.schemas';
import { profileIdParamSchema } from '../profiles/profile.schemas';
import { dailySnapshotCaptureSchema, dailySnapshotListQuerySchema, type DailySnapshotCaptureInput, type DailySnapshotListQuery } from './effectiveTarget.schemas';
import { toDailySnapshotDto, type EffectiveTargetService } from './effectiveTarget.service';

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

  // Layer 10A — daily historical target context.
  router.post('/target-snapshots', validate({ params: profileIdParamSchema, body: dailySnapshotCaptureSchema }), async (req, res, next) => {
    if (!req.auth) return next(AppError.unauthenticated());
    try {
      const { profile_id } = req.params as unknown as { profile_id: string };
      const { created, snapshot } = await service.captureDaily(req.auth, profile_id, req.body as DailySnapshotCaptureInput);
      res.status(created ? 201 : 200).json({ created, snapshot: toDailySnapshotDto(snapshot) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/target-snapshots', validate({ params: profileIdParamSchema, query: dailySnapshotListQuerySchema }), async (req, res, next) => {
    if (!req.auth) return next(AppError.unauthenticated());
    try {
      const { profile_id } = req.params as unknown as { profile_id: string };
      res.status(200).json(await service.listDailySnapshots(req.auth, profile_id, req.query as unknown as DailySnapshotListQuery));
    } catch (err) {
      next(err);
    }
  });

  router.get('/target-snapshots/daily/:local_date', validate({ params: dailySnapshotParamSchema }), async (req, res, next) => {
    if (!req.auth) return next(AppError.unauthenticated());
    try {
      const { profile_id, local_date } = req.params as unknown as { profile_id: string; local_date: string };
      res.status(200).json(await service.dailySnapshot(req.auth, profile_id, local_date));
    } catch (err) {
      next(err);
    }
  });

  return router;
}

const dailySnapshotParamSchema = profileIdParamSchema.extend({ local_date: localDateSchema });
