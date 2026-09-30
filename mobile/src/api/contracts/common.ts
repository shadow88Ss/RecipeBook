// Layer 12A §14–15 — mobile DTOs, written from docs/30_API.md (no backend
// runtime code is imported). Only the fields the app renders are validated;
// unknown fields are dropped, so additive API changes never break the app.

import { z } from 'zod';

export function pageSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    data: z.array(item),
    pagination: z.object({ nextCursor: z.string().nullable(), limit: z.number() }),
  });
}

export const coverageSchema = z.enum(['complete', 'partial', 'unavailable']);
export type Coverage = z.infer<typeof coverageSchema>;

/** Layer 5B rounded value: `value: null` is UNKNOWN, never zero. */
export const roundedValueSchema = z.object({
  value: z.number().nullable(),
  is_zero: z.boolean(),
  below_output_precision: z.boolean(),
});
export type RoundedValue = z.infer<typeof roundedValueSchema>;

export const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
