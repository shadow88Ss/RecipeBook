// Layer 4A §14 — minimal Profile proof endpoints. Route handlers are thin:
// validate -> call service -> respond. No query building, no authorization
// decision, and no DTO shaping happens in this file (Layer 4A spec §1).

import { Router } from 'express';
import { paginationQuerySchema, type PaginationQuery } from '../../lib/pagination';
import { validate } from '../../middleware/validate';
import { AppError } from '../../lib/errors';
import { profileIdParamSchema } from './profile.schemas';
import type { ProfileService } from './profile.service';

export function createProfileRouter(service: ProfileService): Router {
  const router = Router();

  // GET /v1/profiles — every Profile legitimately available to the
  // authenticated Account (spec §14, §15): directly owned profiles, plus
  // child profiles reached through an active GuardianAuthorization. Never
  // another Account's unrelated profiles, and a revoked guardian grant
  // removes the child profile from this list on the very next request.
  router.get('/', validate({ query: paginationQuerySchema }), async (req, res, next) => {
    if (!req.auth) {
      next(AppError.unauthenticated());
      return;
    }
    try {
      const page = await service.listAccessibleProfiles(req.auth, req.query as unknown as PaginationQuery);
      res.status(200).json(page);
    } catch (err) {
      next(err);
    }
  });

  // GET /v1/profiles/:profile_id — proves authentication + API-layer
  // authorization + RLS + safe projection together (spec §14). A
  // profile_id the caller is not authorized for, or that does not exist,
  // both resolve to the same non-disclosing 404 (spec §15, Testing item E).
  router.get('/:profile_id', validate({ params: profileIdParamSchema }), async (req, res, next) => {
    if (!req.auth) {
      next(AppError.unauthenticated());
      return;
    }
    try {
      const { profile_id } = req.params as unknown as { profile_id: string };
      const dto = await service.getProfile(req.auth, profile_id);
      res.status(200).json(dto);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
