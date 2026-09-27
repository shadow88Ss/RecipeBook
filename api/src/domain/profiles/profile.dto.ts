// Layer 4A §6 — safe data projections. Nothing in this codebase returns a
// raw ProfileWithScope row to an HTTP client; every response goes through
// one of these two functions.

import type { AnyProfileDto, PediatricProfileDto, ProfileDto } from './profile.schemas';
import type { ProfileWithScope } from './profile.repository';

function toStandardDto(row: ProfileWithScope): ProfileDto {
  return {
    id: row.id,
    account_id: row.account_id,
    display_name: row.display_name,
    is_child: row.is_child,
    date_of_birth: row.date_of_birth,
    created_at: row.created_at,
    access_scope: row.access_scope,
  };
}

/** 33_Security_and_Privacy.md §9.3: account_id, created_at, and deleted_at
 * are never exposed to a pediatric_weight_management caller. deleted_at was
 * never on ProfileRow to begin with (soft-deleted rows are filtered at the
 * repository query, per profile.repository.ts), so it cannot leak here
 * either way. */
function toPediatricDto(row: ProfileWithScope): PediatricProfileDto {
  return {
    id: row.id,
    display_name: row.display_name,
    is_child: row.is_child,
    date_of_birth: row.date_of_birth,
    access_scope: 'pediatric_weight_management',
  };
}

export function toProfileDto(row: ProfileWithScope): AnyProfileDto {
  return row.access_scope === 'pediatric_weight_management' ? toPediatricDto(row) : toStandardDto(row);
}
