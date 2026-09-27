// Layer 4B §6 — WeightMeasurement request/response contracts.
//
// No field here accepts `source` or `provenance_reference` — both are
// system_computed (Data Dictionary §10) and forced server-side to
// 'user_entered' / null (weightMeasurement.service.ts): "Do not allow
// clients to claim a clinician/wearable source they are not authorized to
// represent" (Layer 4B spec §6). A wearable-sync or clinician-entry path
// would be a service-role/worker or clinician-workflow write, neither of
// which exists yet — explicitly out of scope here.

import { z } from 'zod';

const measuredAtSchema = z.iso
  .datetime({ offset: true })
  .refine((value) => Date.parse(value) <= Date.now(), 'measured_at must not be in the future.');

const valueKgSchema = z.number().finite().positive().max(500);

export const weightMeasurementCreateSchema = z.object({
  measured_at: measuredAtSchema,
  value_kg: valueKgSchema,
  /** Correction pattern (Data Dictionary §10, mirrors MealItem): a new row
   * referencing the measurement it corrects. Must reference an existing row
   * for the SAME profile (weightMeasurement.service.ts validates this). */
  corrects_measurement_id: z.uuid().optional(),
});
export type WeightMeasurementCreateInput = z.infer<typeof weightMeasurementCreateSchema>;

export const weightMeasurementDtoSchema = z.object({
  id: z.uuid(),
  profile_id: z.uuid(),
  measured_at: z.iso.datetime({ offset: true }),
  value_kg: z.number(),
  source: z.enum(['user_entered', 'wearable_synced', 'clinician_entered']),
  provenance_reference: z.uuid().nullable(),
  corrects_measurement_id: z.uuid().nullable(),
  created_at: z.iso.datetime({ offset: true }),
});
export type WeightMeasurementDto = z.infer<typeof weightMeasurementDtoSchema>;
