// Layer 7B — GET /v1/profiles/:profile_id/daily-tracker?date=&timezone=.
// Read-only; no other method exists on this route.

import { Router } from 'express';
import { AppError } from '../../lib/errors';
import { validate } from '../../middleware/validate';
import { profileIdParamSchema } from '../profiles/profile.schemas';
import { dailyTrackerQuerySchema, type DailyTrackerQuery } from './dailyTracker.schemas';
import type { DailyTrackerService } from './dailyTracker.service';

export function createDailyTrackerRouter(service: DailyTrackerService): Router {
  const router = Router({ mergeParams: true });
  router.get('/', validate({ params: profileIdParamSchema, query: dailyTrackerQuerySchema }), async (req, res, next) => {
    if (!req.auth) return next(AppError.unauthenticated());
    try {
      const { profile_id } = req.params as unknown as { profile_id: string };
      res.status(200).json(await service.get(req.auth, profile_id, req.query as unknown as DailyTrackerQuery));
    } catch (err) {
      next(err);
    }
  });
  return router;
}
