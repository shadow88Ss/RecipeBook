// docs/30_API.md §12 — GET /v1/profiles. The pediatric_weight_management
// projection omits account_id and created_at, so neither is required here and
// the app never uses account_id for anything.

import { z } from 'zod';

import { pageSchema } from './common';

/** Documented scopes. Kept as a plain string so a new server scope is shown, not rejected. */
export const KNOWN_ACCESS_SCOPES = ['full_management', 'view_only', 'pediatric_weight_management'] as const;

export const profileSchema = z.object({
  id: z.string().min(1),
  display_name: z.string(),
  is_child: z.boolean(),
  date_of_birth: z.string().nullable().optional(),
  access_scope: z.string().min(1),
});
export type Profile = z.infer<typeof profileSchema>;

export const profilePageSchema = pageSchema(profileSchema);
export type ProfilePage = z.infer<typeof profilePageSchema>;
