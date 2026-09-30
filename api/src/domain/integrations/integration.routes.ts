// Layer 11C — platform administration routes, mounted at
// /v1/admin/integrations. platform_admin only (checked by the service and
// enforced by RLS). No route returns a secret value.

import { Router, type Request, type RequestHandler } from 'express';
import { AppError } from '../../lib/errors';
import { validate } from '../../middleware/validate';
import type { AuthContext } from '../../types/express';
import {
  providerKeyParamSchema,
  providerPatchSchema,
  providerRegisterSchema,
  routingQuerySchema,
  type ProviderPatchInput,
  type ProviderRegisterInput,
  type RoutingQuery,
} from './integration.schemas';
import type { IntegrationService } from './integration.service';

type Params = { provider_key: string };

function handle(status: number, fn: (auth: AuthContext, params: Params, req: Request) => Promise<unknown>): RequestHandler {
  return async (req, res, next) => {
    if (!req.auth) return next(AppError.unauthenticated());
    try {
      res.status(status).json(await fn(req.auth, req.params as unknown as Params, req));
    } catch (err) {
      next(err);
    }
  };
}

export function createIntegrationAdminRouter(service: IntegrationService): Router {
  const router = Router();
  router.get('/', handle(200, (auth) => service.list(auth)));
  router.post('/', validate({ body: providerRegisterSchema }), handle(201, (auth, _p, req) => service.register(auth, req.body as ProviderRegisterInput)));
  router.get('/capabilities', handle(200, (auth) => service.capabilities(auth)));
  router.get('/routing', validate({ query: routingQuerySchema }), handle(200, (auth, _p, req) => service.routing(auth, req.query as unknown as RoutingQuery)));
  router.get('/:provider_key', validate({ params: providerKeyParamSchema }), handle(200, (auth, p) => service.get(auth, p.provider_key)));
  router.patch(
    '/:provider_key',
    validate({ params: providerKeyParamSchema, body: providerPatchSchema }),
    handle(200, (auth, p, req) => service.update(auth, p.provider_key, req.body as ProviderPatchInput)),
  );
  router.post('/:provider_key/test', validate({ params: providerKeyParamSchema }), handle(200, (auth, p, req) => service.testConnection(auth, p.provider_key, req.requestId)));
  router.get('/:provider_key/health', validate({ params: providerKeyParamSchema }), handle(200, (auth, p) => service.health(auth, p.provider_key)));
  router.get('/:provider_key/audit', validate({ params: providerKeyParamSchema }), handle(200, (auth, p) => service.audit(auth, p.provider_key)));
  return router;
}
