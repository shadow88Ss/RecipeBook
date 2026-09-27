// Layer 5A — request contracts for the conversion endpoints (30_API.md §3,
// §5). Only request *shape* is validated here; whether a unit string is
// supported, ambiguous, or dimensionally compatible is a defined
// conversion outcome (`status: 'unresolved'`), not a validation error —
// see conversion.engine.ts.

import { z } from 'zod';

/** Upper bound on a single conversion's input quantity — far above any
 * real kitchen/meal quantity, low enough that exact arithmetic stays cheap. */
export const MAX_CONVERSION_QUANTITY = 1_000_000;

export const quantitySchema = z.number().finite().positive().max(MAX_CONVERSION_QUANTITY);

const unitTextSchema = z.string().trim().min(1).max(32);

/** Exactly one of `unit` or `serving_id`. Supplying both is rejected rather
 * than silently preferring one. */
export const conversionEndpointSchema = z
  .object({
    unit: unitTextSchema.optional(),
    serving_id: z.uuid().optional(),
  })
  .refine((value) => (value.unit === undefined) !== (value.serving_id === undefined), {
    message: 'Provide exactly one of unit or serving_id.',
  });

export const foodConversionSchema = z.object({
  quantity: quantitySchema,
  from: conversionEndpointSchema,
  to: conversionEndpointSchema,
});
export type FoodConversionInput = z.infer<typeof foodConversionSchema>;

export const unitConversionSchema = z.object({
  quantity: quantitySchema,
  from_unit: unitTextSchema,
  to_unit: unitTextSchema,
});
export type UnitConversionInput = z.infer<typeof unitConversionSchema>;
