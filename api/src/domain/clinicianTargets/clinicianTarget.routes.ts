import { Router } from 'express';
import { AppError } from '../../lib/errors';
import { paginationQuerySchema, type PaginationQuery } from '../../lib/pagination';
import { validate } from '../../middleware/validate';
import { profileIdParamSchema } from '../profiles/profile.schemas';
import {
  clinicianTargetCreateSchema,
  clinicianTargetHistoryQuerySchema,
  type ClinicianTargetHistoryQuery,
} from './clinicianTarget.schemas';
import type { ClinicianTargetService } from './clinicianTarget.service';

export function createClinicianTargetRouter(service: ClinicianTargetService): Router {
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

  router.get(
    '/history',
    validate({ params: profileIdParamSchema, query: clinicianTargetHistoryQuerySchema }),
    async (req, res, next) => {
      if (!req.auth) return next(AppError.unauthenticated());
      try {
        const { profile_id } = req.params as unknown as { profile_id: string };
        const page = await service.listHistory(req.auth, profile_id, req.query as unknown as ClinicianTargetHistoryQuery);
        res.status(200).json(page);
      } catch (err) {
        next(err);
      }
    },
  );

  // Unverified, self/guardian-relayed clinician targets only — see
  // clinicianTarget.service.ts's file-level comment. Creating a
  // platform_verified row is not implemented (deferred; no approved
  // verified-clinician-integration workflow exists).
  router.post('/', validate({ params: profileIdParamSchema, body: clinicianTargetCreateSchema }), async (req, res, next) => {
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
