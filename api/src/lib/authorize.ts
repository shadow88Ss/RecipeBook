// Layer 4B §10 — one shared authorization check used by every new domain
// route, so the allowed-scope list for each operation is declared once,
// close to the RLS policy it must never broaden (spec §10: "API
// authorization must not broaden database authorization").
//
// This check is advisory/UX-layer: it produces the correct HTTP status
// before any query runs, and its allowed-scope lists are transcribed
// directly from the already-approved RLS policies (see the file-level
// comment in each domain's service.ts for the exact source migration).
// The database RLS policy remains the actual, final enforcement — every
// write this helper permits still goes through the caller's own
// RLS-scoped ScopedDbClient, never a privileged one.

import type { AccessScope } from '../domain/profiles/profile.repository';
import { AppError } from './errors';
import type { ScopedDbClient } from './scopedDb';

export async function resolveProfileScope(db: ScopedDbClient, profileId: string): Promise<AccessScope | null> {
  const scope = await db.rpc<AccessScope | null>('profile_access_scope', { target_profile_id: profileId });
  return scope ?? null;
}

/**
 * Throws a non-disclosing AppError.notFound() if the caller has no access
 * scope at all to the profile (mirrors Layer 4A's Profile behavior — a
 * profile_id that doesn't exist and one the caller can't see are
 * indistinguishable), or AppError.forbidden() if the caller has *some*
 * scope but not one that covers this operation (the profile's existence
 * isn't secret from a caller who already has a relationship to it, so a
 * clear 403 is correct and more useful here than another 404).
 */
export async function requireProfileScope(db: ScopedDbClient, profileId: string, allowed: readonly AccessScope[]): Promise<AccessScope> {
  const scope = await resolveProfileScope(db, profileId);
  if (!scope) {
    throw AppError.notFound('Profile not found.');
  }
  if (!allowed.includes(scope)) {
    throw AppError.forbidden(`This operation is not permitted for access scope "${scope}".`);
  }
  return scope;
}
