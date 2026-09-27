// Layer 4B §5 — ClinicianTarget request/response contracts.
//
// The create request intentionally has NO field for verification_status,
// source_type, provided_by_account_id, or entered_at — all four are
// system_computed (29_Data_Model_Data_Dictionary.md §9) and are derived
// server-side in clinicianTarget.service.ts, never read from the request
// body. This is the enforcement for Layer 4B spec §5's hard requirement:
// "A client must NEVER be able to set verification_status =
// platform_verified merely by supplying that value" — the field is
// structurally absent from the schema, not merely defaulted, so there is no
// code path where a client-supplied value could reach the insert.

import { z } from 'zod';
import { fieldNameSchema } from '../nutritionTargets/nutritionTarget.schemas';

const valueSchema = z.number().finite().positive().max(100_000);
const unitSchema = z.string().trim().min(1).max(32);

export const clinicianTargetCreateSchema = z.object({
  field_name: fieldNameSchema,
  value: valueSchema,
  unit: unitSchema,
});
export type ClinicianTargetCreateInput = z.infer<typeof clinicianTargetCreateSchema>;

export const clinicianTargetHistoryQuerySchema = z.object({
  field_name: fieldNameSchema.optional(),
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type ClinicianTargetHistoryQuery = z.infer<typeof clinicianTargetHistoryQuerySchema>;

export const clinicianTargetDtoSchema = z.object({
  id: z.uuid(),
  profile_id: z.uuid(),
  field_name: z.string(),
  value: z.number(),
  unit: z.string(),
  source_type: z.enum(['guardian_entered', 'user_entered', 'clinician_integration']),
  verification_status: z.enum(['unverified', 'platform_verified']),
  provided_by_account_id: z.uuid(),
  entered_at: z.iso.datetime({ offset: true }),
  is_active: z.boolean(),
  superseded_at: z.iso.datetime({ offset: true }).nullable(),
  created_at: z.iso.datetime({ offset: true }),
});
export type ClinicianTargetDto = z.infer<typeof clinicianTargetDtoSchema>;
