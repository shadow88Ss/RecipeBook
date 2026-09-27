// Layer 4A §4/§17 — Profile data access, behind an interface so the HTTP
// layer and service layer never know whether they are talking to a live
// Supabase project (production) or a test harness (see
// tests/helpers/pgHarnessProfileRepository.ts, deliberately NOT in src/ —
// Layer 4A spec §20 requires simulation and live verification stay clearly
// distinguished, including by where the code lives).
//
// Every method is called with an AuthContext derived from a verified
// Supabase token (never a client-supplied account_id) and returns only
// rows Postgres RLS itself decided are visible to that Account — there is
// no code path here that reads with elevated/service-role privileges
// (spec §17, §19).

import type { AuthContext } from '../../types/express';

export const ACCESS_SCOPES = ['full_management', 'view_only', 'pediatric_weight_management'] as const;
export type AccessScope = (typeof ACCESS_SCOPES)[number];

/** Mirrors profile's Phase 1 columns (29_Data_Model_Data_Dictionary.md §4).
 * This is the raw row shape used internally — it is never returned to an
 * HTTP client directly; see profile.dto.ts for the projections that are. */
export interface ProfileRow {
  id: string;
  account_id: string;
  display_name: string;
  is_child: boolean;
  date_of_birth: string | null;
  created_at: string;
}

export interface ProfileWithScope extends ProfileRow {
  /** The caller's own access scope to this specific profile, resolved the
   * same way RLS resolves it (profile_access_scope(id): direct ownership
   * of an adult profile reads as 'full_management'; a child profile reads
   * the caller's active GuardianAuthorization scope). Never null here —
   * a row this repository returns is, by construction, one RLS already
   * decided the caller may see, so a resolvable scope always exists. */
  access_scope: AccessScope;
}

export interface ProfileRepository {
  /** Every Profile currently visible to this Account under RLS: owned
   * profiles, plus child profiles reached through an active
   * GuardianAuthorization (spec §15). A revoked authorization makes the
   * child profile disappear on the very next call — there is no caching
   * layer that could serve a stale, now-unauthorized row. */
  listAccessibleProfiles(auth: AuthContext): Promise<ProfileWithScope[]>;

  /** A single Profile by id, or null if it does not exist OR the caller is
   * not authorized for it — RLS makes those two cases indistinguishable at
   * the query level, which is exactly the non-disclosing behavior the
   * service layer relies on (spec §15, Testing item E). */
  getProfileById(auth: AuthContext, profileId: string): Promise<ProfileWithScope | null>;
}
