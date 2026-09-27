// Layer 4B §7/§8/§9 — EffectiveTargetResolver (computed on read, never
// persisted by default — 29_Data_Model.md §4) and EffectiveTargetSnapshot
// (write-once historical evidence — §4.2/§4.3).
//
// Read scopes (resolver + snapshot list) transcribed from
// 20260825121300_rls_targets_and_goals.sql
// (effective_target_snapshot_select_authorized, itself reading from
// clinician_target/nutrition_target which share the same read scopes) and
// 20260825121900_rls_pediatric_weight_management.sql
// (effective_target_snapshot_select_pediatric): full_management + view_only
// + pediatric_weight_management. Snapshot creation is full_management ONLY
// (effective_target_snapshot_insert_managed; deliberately no pediatric
// insert policy — "this scope does not create resolved-target snapshots
// itself").
//
// There is only ONE resolution implementation, here — never duplicated in
// a route, mobile code, or an AI prompt (Master §8: "must remain singular").

import { requireProfileScope } from '../../lib/authorize';
import { CLINICIAN_TARGET_COLUMNS, type ClinicianTargetRow } from '../clinicianTargets/clinicianTarget.dto';
import { NUTRITION_TARGET_COLUMNS, type NutritionTargetRow } from '../nutritionTargets/nutritionTarget.dto';
import { paginateInMemory, type Page, type PaginationQuery } from '../../lib/pagination';
import type { ScopedDbFactory } from '../../lib/scopedDb';
import type { AuthContext } from '../../types/express';
import type { EffectiveTargetResponse, ResolvedField, SnapshotDto } from './effectiveTarget.schemas';

const READ_SCOPES = ['full_management', 'view_only', 'pediatric_weight_management'] as const;
const SNAPSHOT_WRITE_SCOPES = ['full_management'] as const;
const FETCH_CAP = 1000;

/** Bump when the merge/precedence logic below changes in an
 * observably-different way — every EffectiveTargetSnapshot's resolver_version
 * records exactly which version produced it (29_Data_Model.md §4.2). */
export const RESOLVER_VERSION = 'phase1-clinician-user-field-merge-v1';

/** Only the two Phase 1-implemented precedence levels (Master §8.1 levels 2
 * and 3). Levels 1 (mandatory safety/clinical constraints) and 4
 * (profile-derived/default) require formulas that belong to the not-yet-
 * built Nutrition Engine — never fabricated here. */
export const IMPLEMENTED_SOURCES = ['clinician_target', 'user_target'] as const;

interface SnapshotRow {
  id: string;
  profile_id: string;
  snapshot_payload: Record<string, ResolvedField>;
  resolver_version: string;
  resolved_at: string;
  snapshot_reason: SnapshotDto['snapshot_reason'];
  linked_event_type: SnapshotDto['linked_event_type'];
  linked_event_id: string | null;
  created_at: string;
}
const SNAPSHOT_COLUMNS = 'id, profile_id, snapshot_payload, resolver_version, resolved_at, snapshot_reason, linked_event_type, linked_event_id, created_at';

export class EffectiveTargetService {
  constructor(private readonly dbFactory: ScopedDbFactory) {}

  /** Field-by-field merge, lower precedence applied first so a higher one
   * can overwrite it (Master §8.1: "a lower-precedence source fills fields
   * that are not defined by a higher-precedence source"). A field absent
   * from both active clinician_target and active nutrition_target simply
   * does not appear in `resolved` — there is no vocabulary of "all possible
   * fields" in Phase 1 to check absence against (29_Data_Model_Data_
   * Dictionary.md §8), so this never fabricates a placeholder/default for
   * it; `implemented_sources` documents why. */
  async resolve(auth: AuthContext, profileId: string): Promise<EffectiveTargetResponse> {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, READ_SCOPES);

    const [userRows, clinicianRows] = await Promise.all([
      db.select<NutritionTargetRow>('nutrition_target', {
        columns: NUTRITION_TARGET_COLUMNS,
        eq: { profile_id: profileId, is_active: true },
      }),
      db.select<ClinicianTargetRow>('clinician_target', {
        columns: CLINICIAN_TARGET_COLUMNS,
        eq: { profile_id: profileId, is_active: true },
      }),
    ]);

    const resolved: Record<string, ResolvedField> = {};
    for (const row of userRows) {
      resolved[row.field_name] = { value: row.value, unit: row.unit, source: 'user_target', source_reference: row.id };
    }
    for (const row of clinicianRows) {
      resolved[row.field_name] = { value: row.value, unit: row.unit, source: 'clinician_target', source_reference: row.id };
    }

    return {
      profile_id: profileId,
      resolved,
      resolver_version: RESOLVER_VERSION,
      resolved_at: new Date().toISOString(),
      implemented_sources: [...IMPLEMENTED_SOURCES],
    };
  }

  async listSnapshots(auth: AuthContext, profileId: string, pagination: PaginationQuery): Promise<Page<SnapshotDto>> {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, READ_SCOPES);
    const rows = await db.select<SnapshotRow>('effective_target_snapshot', {
      columns: SNAPSHOT_COLUMNS,
      eq: { profile_id: profileId },
      order: { column: 'resolved_at', ascending: false },
      limit: FETCH_CAP,
    });
    return paginateInMemory(rows, pagination);
  }

  /**
   * Not exposed through any route in Layer 4B (spec §9: "If snapshot
   * creation is an internal/server action rather than an ordinary user
   * operation, keep it internal") — every snapshot_reason (meal_consumed,
   * daily_summary_finalized, coach_recommendation_issued, user_requested_
   * export, manual_audit) is tied to a feature (meal logging, daily
   * summaries, AI coach, data export) none of which exist yet. Kept as a
   * service method, not a route, so (a) a future layer that builds one of
   * those features can call it without re-deriving the write path, and
   * (b) it can be exercised directly in tests to prove immutability
   * (Testing item V) without inventing a public creation endpoint now.
   */
  async createSnapshotInternal(
    auth: AuthContext,
    profileId: string,
    reason: SnapshotDto['snapshot_reason'],
    linkedEvent?: { type: SnapshotDto['linked_event_type']; id: string },
  ): Promise<SnapshotDto> {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, SNAPSHOT_WRITE_SCOPES);
    const resolved = await this.resolve(auth, profileId);

    const row = await db.insert<SnapshotRow>(
      'effective_target_snapshot',
      {
        profile_id: profileId,
        // Passed as a plain object, not a JSON string: supabase-js
        // serializes it as nested JSON for the jsonb column correctly, and
        // node-postgres's parameter binding auto-JSON.stringifies a plain
        // object — pre-stringifying here would double-encode it as a jsonb
        // column holding a string, not an object, via the PostgREST path.
        snapshot_payload: resolved.resolved,
        resolver_version: resolved.resolver_version,
        resolved_at: resolved.resolved_at,
        snapshot_reason: reason,
        linked_event_type: linkedEvent?.type ?? null,
        linked_event_id: linkedEvent?.id ?? null,
      },
      SNAPSHOT_COLUMNS,
    );
    return row;
  }
}
