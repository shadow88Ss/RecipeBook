// Layer 4B §4 — NutritionTarget request/response contracts.
//
// field_name has no fixed vocabulary in Phase 1 (29_Data_Model_Data_
// Dictionary.md §8 / the nutrition_target migration: "the full resolvable-
// field vocabulary... belongs to Phase 2, not Phase 1"), so this cannot
// validate against a closed enum. It is instead constrained to a safe,
// stable identifier shape — the same shape a fixed vocabulary would use —
// so free-form/unbounded text never reaches the shared field_name
// namespace ClinicianTarget and the EffectiveTargetResolver also key off.
//
// Per-field canonical units and plausible value ranges are likewise Phase 2
// vocabulary concerns (Data Dictionary: "must match field's canonical
// unit" / "plausible range per field") — not implementable without
// inventing that vocabulary now. This layer applies only the generic,
// non-domain-specific validation Layer 4B spec §12 asks for (reject NaN/
// Infinity/non-positive), and documents the rest as deferred.

import { z } from 'zod';

export const fieldNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/, 'field_name must be a canonical target key (e.g. "energy", "protein", "iron") or an accepted alias.');

const valueSchema = z.number().finite().positive().max(100_000);
const unitSchema = z.string().trim().min(1).max(32);

export const nutritionTargetCreateSchema = z.object({
  field_name: fieldNameSchema,
  value: valueSchema,
  unit: unitSchema,
});
export type NutritionTargetCreateInput = z.infer<typeof nutritionTargetCreateSchema>;

export const nutritionTargetHistoryQuerySchema = z.object({
  field_name: fieldNameSchema.optional(),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type NutritionTargetHistoryQuery = z.infer<typeof nutritionTargetHistoryQuerySchema>;

export const nutritionTargetDtoSchema = z.object({
  id: z.uuid(),
  profile_id: z.uuid(),
  field_name: z.string(),
  value: z.number(),
  unit: z.string(),
  is_active: z.boolean(),
  superseded_at: z.iso.datetime({ offset: true }).nullable(),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
});
export type NutritionTargetDto = z.infer<typeof nutritionTargetDtoSchema>;
