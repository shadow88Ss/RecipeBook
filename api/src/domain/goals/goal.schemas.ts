// Layer 4B §3 — Goal request/response contracts.

import { z } from 'zod';

/** Fixed Phase 1 enum (29_Data_Model.md §11 / enums.sql `goal_type`). Never
 * add a value here without an approved specification change — Layer 4B
 * spec §3: "Do not add new goal types merely because they may be useful
 * later." */
export const GOAL_TYPES = [
  'weight_loss',
  'maintenance',
  'weight_gain',
  'micronutrient_improvement',
  'fiber_improvement',
  'other',
] as const;
export const goalTypeSchema = z.enum(GOAL_TYPES);
export type GoalType = z.infer<typeof goalTypeSchema>;

export const goalIdParamSchema = z.object({
  profile_id: z.uuid({ message: 'profile_id must be a valid UUID.' }),
  goal_id: z.uuid({ message: 'goal_id must be a valid UUID.' }),
});

const targetWeightKgSchema = z.number().finite().positive().max(1000);
const targetDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'target_date must be an ISO date (YYYY-MM-DD).')
  .refine((value) => !Number.isNaN(Date.parse(value)), 'target_date must be a valid calendar date.')
  .refine((value) => Date.parse(value) > Date.now(), 'target_date must be a future date.');
const notesSchema = z.string().trim().max(2000);

export const goalCreateSchema = z.object({
  goal_type: goalTypeSchema,
  target_weight_kg: targetWeightKgSchema.optional(),
  target_date: targetDateSchema.optional(),
  notes: notesSchema.optional(),
  is_active: z.boolean().optional(),
});
export type GoalCreateInput = z.infer<typeof goalCreateSchema>;

export const goalPatchSchema = z
  .object({
    goal_type: goalTypeSchema.optional(),
    target_weight_kg: targetWeightKgSchema.nullable().optional(),
    target_date: targetDateSchema.nullable().optional(),
    notes: notesSchema.nullable().optional(),
    is_active: z.boolean().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'At least one field must be provided.' });
export type GoalPatchInput = z.infer<typeof goalPatchSchema>;

export const goalDtoSchema = z.object({
  id: z.uuid(),
  profile_id: z.uuid(),
  goal_type: goalTypeSchema,
  target_weight_kg: z.number().nullable(),
  target_date: z.string().nullable(),
  notes: z.string().nullable(),
  is_active: z.boolean(),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
});
export type GoalDto = z.infer<typeof goalDtoSchema>;
