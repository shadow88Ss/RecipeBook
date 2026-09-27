// Layer 4A — Profile domain/business logic, kept separate from the HTTP
// route handlers (Layer 4A spec §1) so it is directly unit-testable and so
// the route layer stays a thin adapter.

import { requireProfileScope } from '../../lib/authorize';
import { AppError } from '../../lib/errors';
import { buildPage, decodeCursor, encodeCursor, type Page, type PaginationQuery } from '../../lib/pagination';
import type { ScopedDbFactory } from '../../lib/scopedDb';
import type { AuthContext } from '../../types/express';
import { toProfileDto } from './profile.dto';
import type { ProfileRepository, ProfileRow } from './profile.repository';
import type { AnyProfileDto, ProfilePatch } from './profile.schemas';

const PROFILE_COLUMNS = 'id, account_id, display_name, is_child, date_of_birth, created_at';

export class ProfileService {
  /** dbFactory is optional so existing Layer 4A call sites/tests that only
   * exercise the two GET endpoints are unaffected — it is required only by
   * updateProfile (Layer 4B), which throws clearly if it was omitted rather
   * than silently no-op'ing. */
  constructor(
    private readonly repository: ProfileRepository,
    private readonly dbFactory?: ScopedDbFactory,
  ) {}

  /** The accessible-profile set is small by construction (one Account's own
   * profiles plus guarded children — not an unbounded, growing collection),
   * so pagination is applied in-memory over the already RLS-filtered set
   * rather than pushed into the query. This still exercises the real,
   * reusable cursor contract end-to-end (Layer 4A spec §11) rather than
   * faking it, so a future genuinely-large list endpoint can adopt the same
   * cursor shape without a behavior change for existing clients. */
  async listAccessibleProfiles(auth: AuthContext, pagination: PaginationQuery): Promise<Page<AnyProfileDto>> {
    const rows = await this.repository.listAccessibleProfiles(auth);

    let startIndex = 0;
    if (pagination.cursor) {
      const decoded = decodeCursor(pagination.cursor);
      const cursorId = decoded?.id;
      if (typeof cursorId !== 'string') {
        throw AppError.validation('Invalid pagination cursor.');
      }
      const cursorIndex = rows.findIndex((row) => row.id === cursorId);
      if (cursorIndex === -1) {
        throw AppError.validation('Invalid pagination cursor.');
      }
      startIndex = cursorIndex + 1;
    }

    const page = rows.slice(startIndex, startIndex + pagination.limit);
    const hasMore = startIndex + pagination.limit < rows.length;
    const lastRow = page[page.length - 1];
    const nextCursor = hasMore && lastRow ? encodeCursor({ id: lastRow.id }) : null;

    return buildPage(page.map(toProfileDto), nextCursor, pagination.limit);
  }

  async getProfile(auth: AuthContext, profileId: string): Promise<AnyProfileDto> {
    const row = await this.repository.getProfileById(auth, profileId);
    if (!row) {
      // Deliberately identical whether the profile does not exist or the
      // caller simply is not authorized for it — a non-disclosing 404
      // (Layer 4A spec §15, Testing item E), never a 403 that would confirm
      // the profile's existence to an Account that has no access to it.
      throw AppError.notFound('Profile not found.');
    }
    return toProfileDto(row);
  }

  /** Layer 4B §2 — full_management only (profile_update_managed RLS policy,
   * 20260825121100_rls_account_auth_profile.sql), covering both an adult
   * editing their own profile and a guardian editing a child's. The Zod
   * schema (profile.schemas.ts) already excludes account_id/is_child from
   * `patch`; 20260825130000_profile_immutable_columns.sql freezes them at
   * the database layer too. */
  async updateProfile(auth: AuthContext, profileId: string, patch: ProfilePatch): Promise<AnyProfileDto> {
    if (!this.dbFactory) {
      throw AppError.internal();
    }
    const db = this.dbFactory.forUser(auth);
    const scope = await requireProfileScope(db, profileId, ['full_management']);

    const values: Record<string, unknown> = {};
    if (patch.display_name !== undefined) values.display_name = patch.display_name;
    if (patch.date_of_birth !== undefined) values.date_of_birth = patch.date_of_birth;

    const updated = await db.update<ProfileRow>('profile', { id: profileId }, values, PROFILE_COLUMNS);
    if (!updated) {
      // The scope check above already confirmed access; a null result here
      // means the row vanished between the check and the write (e.g.
      // deleted concurrently) — treat as not-found, not a server error.
      throw AppError.notFound('Profile not found.');
    }
    return toProfileDto({ ...updated, access_scope: scope });
  }
}
