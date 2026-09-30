// Layer 11A — read-only Product & Barcode routes plus a deterministic
// Product nutrition calculation. No POST/PATCH/DELETE on any product entity
// and no barcode reassignment endpoint: reference data is written only by
// trusted ingestion (product.service.ts). Every route requires auth.

import { Router } from 'express';
import { AppError } from '../../lib/errors';
import { validate } from '../../middleware/validate';
import type { BarcodeType } from './barcode';
import {
  barcodeParamSchema,
  barcodeQuerySchema,
  productIdParamSchema,
  productNutritionCalculateSchema,
  productSearchQuerySchema,
  type ProductNutritionCalculateRequest,
  type ProductSearchQuery,
} from './product.schemas';
import type { ProductService } from './product.service';

export function createProductRouter(service: ProductService): Router {
  const router = Router();

  router.get('/', validate({ query: productSearchQuerySchema }), async (req, res, next) => {
    if (!req.auth) return next(AppError.unauthenticated());
    try {
      res.status(200).json(await service.search(req.auth, req.query as unknown as ProductSearchQuery));
    } catch (err) {
      next(err);
    }
  });

  // before /:product_id so "barcode" is never read as an id
  router.get('/barcode/:code', validate({ params: barcodeParamSchema, query: barcodeQuerySchema }), async (req, res, next) => {
    if (!req.auth) return next(AppError.unauthenticated());
    try {
      const { code } = req.params as unknown as { code: string };
      const { type } = req.query as unknown as { type?: BarcodeType };
      res.status(200).json(await service.lookupBarcode(req.auth, code, type));
    } catch (err) {
      next(err);
    }
  });

  router.get('/:product_id', validate({ params: productIdParamSchema }), async (req, res, next) => {
    if (!req.auth) return next(AppError.unauthenticated());
    try {
      const { product_id } = req.params as unknown as { product_id: string };
      res.status(200).json(await service.get(req.auth, product_id));
    } catch (err) {
      next(err);
    }
  });

  router.post('/:product_id/nutrition/calculate', validate({ params: productIdParamSchema, body: productNutritionCalculateSchema }), async (req, res, next) => {
    if (!req.auth) return next(AppError.unauthenticated());
    try {
      const { product_id } = req.params as unknown as { product_id: string };
      res.status(200).json(await service.calculate(req.auth, product_id, req.body as ProductNutritionCalculateRequest));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
