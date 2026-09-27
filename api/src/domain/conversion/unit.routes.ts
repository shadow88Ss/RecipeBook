// Layer 5A — food-independent unit endpoints. Pure computation over the
// static unit registry (units.ts): no database access and no side effects,
// so POST /convert is safe to retry. Authentication is still required, like
// every /v1 route.

import { Router } from 'express';
import { AppError } from '../../lib/errors';
import { validate } from '../../middleware/validate';
import { convert } from './conversion.engine';
import { unitConversionSchema, type UnitConversionInput } from './conversion.schemas';
import { BASE_UNIT, UNITS } from './units';

export function createUnitRouter(): Router {
  const router = Router();

  router.get('/', (req, res, next) => {
    if (!req.auth) return next(AppError.unauthenticated());
    res.status(200).json({
      base_units: BASE_UNIT,
      data: [...UNITS.values()].map(({ code, dimension, factor, system, label }) => ({
        code,
        dimension,
        base_unit: BASE_UNIT[dimension],
        factor_to_base: factor,
        system,
        label,
      })),
    });
  });

  router.post('/convert', validate({ body: unitConversionSchema }), (req, res, next) => {
    if (!req.auth) return next(AppError.unauthenticated());
    const body = req.body as UnitConversionInput;
    const result = convert({ quantity: body.quantity, from: { unit: body.from_unit }, to: { unit: body.to_unit } }, null);
    res.status(200).json(result);
  });

  return router;
}
