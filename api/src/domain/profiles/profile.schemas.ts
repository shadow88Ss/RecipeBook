// Layer 4A §2/§7 — Zod schemas for the Profile endpoints' request/response
// contracts (30_API.md §5: "that schema is the source of truth for both
// server-side validation and any generated/shared client types").

import { z } from 'zod';
import { ACCESS_SCOPES } from './profile.repository';

export const profileIdParamSchema = z.object({
  profile_id: z.uuid({ message: 'profile_id must be a valid UUID.' }),
});
export type ProfileIdParam = z.infer<typeof profileIdParamSchema>;

const accessScopeSchema = z.enum(ACCESS_SCOPES);

/** The standard projection: direct owner, full_management, and view_only
 * guardians all see this shape (Layer 4A spec §6; 33_Security_and_Privacy.md
 * has no field-restriction requirement for these three access paths). */
export const profileDtoSchema = z.object({
  id: z.uuid(),
  account_id: z.uuid(),
  display_name: z.string(),
  is_child: z.boolean(),
  date_of_birth: z.string().nullable(),
  created_at: z.iso.datetime({ offset: true }),
  access_scope: accessScopeSchema,
});
export type ProfileDto = z.infer<typeof profileDtoSchema>;

/** The pediatric_weight_management projection (33_Security_and_Privacy.md
 * §9.3): account_id, created_at, and deleted_at are never exposed through
 * this path. */
export const pediatricProfileDtoSchema = z.object({
  id: z.uuid(),
  display_name: z.string(),
  is_child: z.boolean(),
  date_of_birth: z.string().nullable(),
  access_scope: z.literal('pediatric_weight_management'),
});
export type PediatricProfileDto = z.infer<typeof pediatricProfileDtoSchema>;

export type AnyProfileDto = ProfileDto | PediatricProfileDto;

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date_of_birth must be an ISO date (YYYY-MM-DD).')
  .refine((value) => !Number.isNaN(Date.parse(value)), 'date_of_birth must be a valid calendar date.')
  .refine((value) => Date.parse(value) <= Date.now(), 'date_of_birth must not be in the future.');

/** Layer 4B §2 — only the two fields Profile's own Data Dictionary marks
 * user-editable (id/account_id/is_child/created_at/deleted_at are
 * structurally absent from this schema, and are additionally frozen at the
 * database layer by 20260825130000_profile_immutable_columns.sql). */
export const profilePatchSchema = z
  .object({
    display_name: z.string().trim().min(1).max(200).optional(),
    date_of_birth: isoDateSchema.nullable().optional(),
  })
  .refine((body) => body.display_name !== undefined || body.date_of_birth !== undefined, {
    message: 'At least one of display_name or date_of_birth must be provided.',
  });
export type ProfilePatch = z.infer<typeof profilePatchSchema>;
