// Layer 10B — GET /v1/profiles/:profile_id/progress?from&to&timezone.
// Read-only: there is no write endpoint for analytics.

import { Router } from 'express';
import { AppError } from '../../lib/errors';
import { validate } from '../../middleware/validate';
import { profileIdParamSchema } from '../profiles/profile.schemas';
import { progressQuerySchema, type ProgressQuery } from './progress.schemas';
import type { ProgressService } from './progress.service';

export function createProgressRouter(service: ProgressService): Router {
  const router = Router({ mergeParams: true });
  router.get('/', validate({ params: profileIdParamSchema, query: progressQuerySchema }), async (req, res, next) => {
    if (!req.auth) return next(AppError.unauthenticated());
    try {
      const { profile_id } = req.params as unknown as { profile_id: string };
      res.status(200).json(await service.get(req.auth, profile_id, req.query as unknown as ProgressQuery));
    } catch (err) {
      next(err);
    }
  });
  return router;
}
