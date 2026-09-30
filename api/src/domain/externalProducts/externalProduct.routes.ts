// Layer 11D — consumer routes for external product candidates (mounted at
// /v1/external-products) and the internal-first barcode lookup handler
// mounted under /v1/products. Read-only: no route writes anything.

import { Router, type Request, type RequestHandler } from 'express';
import { AppError } from '../../lib/errors';
import { validate } from '../../middleware/validate';
import { barcodeParamSchema } from '../products/product.schemas';
import {
  barcodeLookupQuerySchema,
  externalCandidateParamSchema,
  externalSearchQuerySchema,
  type BarcodeLookupQuery,
  type ExternalSearchQuery,
} from './externalProduct.schemas';
import type { ExternalProductService } from './externalProduct.service';

function handle(fn: (req: Request & { auth: NonNullable<Request['auth']> }) => Promise<unknown>): RequestHandler {
  return async (req, res, next) => {
    if (!req.auth) return next(AppError.unauthenticated());
    try {
      res.status(200).json(await fn(req as Request & { auth: NonNullable<Request['auth']> }));
    } catch (err) {
      next(err);
    }
  };
}

export function createExternalProductRouter(service: ExternalProductService): Router {
  const router = Router();
  router.get('/search', validate({ query: externalSearchQuerySchema }), handle((req) => service.search(req.auth, req.query as unknown as ExternalSearchQuery, req.requestId)));
  router.get(
    '/:provider_key/:external_id',
    validate({ params: externalCandidateParamSchema }),
    handle((req) => {
      const { provider_key, external_id } = req.params as unknown as { provider_key: string; external_id: string };
      return service.candidate(req.auth, provider_key, external_id, req.requestId);
    }),
  );
  return router;
}

/** GET /v1/products/barcode/:code/lookup */
export function createBarcodeLookupHandler(service: ExternalProductService): RequestHandler[] {
  return [
    validate({ params: barcodeParamSchema, query: barcodeLookupQuerySchema }),
    handle((req) => {
      const { code } = req.params as unknown as { code: string };
      return service.lookupBarcode(req.auth, code, req.query as unknown as BarcodeLookupQuery, req.requestId);
    }),
  ];
}
