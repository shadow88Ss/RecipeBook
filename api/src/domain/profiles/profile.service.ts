// Layer 4A — Profile domain/business logic, kept separate from the HTTP
// route handlers (Layer 4A spec §1) so it is directly unit-testable and so
// the route layer stays a thin adapter.

import { AppError } from '../../lib/errors';
import { buildPage, decodeCursor, encodeCursor, type Page, type PaginationQuery } from '../../lib/pagination';
import type { AuthContext } from '../../types/express';
import { toProfileDto } from './profile.dto';
import type { ProfileRepository } from './profile.repository';
import type { AnyProfileDto } from './profile.schemas';

export class ProfileService {
  constructor(private readonly repository: ProfileRepository) {}

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
}
