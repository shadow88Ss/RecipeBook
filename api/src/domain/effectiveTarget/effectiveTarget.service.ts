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
import { normalizeTarget, resolveTargetKey } from '../nutritionTargets/targetVocabulary';
import type { EffectiveTargetResponse, ResolvedField, SnapshotDto, UnresolvedTargetField } from './effectiveTarget.schemas';

const READ_SCOPES = ['full_management', 'view_only', 'pediatric_weight_management'] as const;
const SNAPSHOT_WRITE_SCOPES = ['full_management'] as const;
const FETCH_CAP = 1000;

/** Bump when the merge/precedence logic below changes in an
 * observably-different way — every EffectiveTargetSnapshot's resolver_version
 * records exactly which version produced it (29_Data_Model.md §4.2). */
export const RESOLVER_VERSION = 'phase2-canonical-target-keys-v2';

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

    // Layer 7C: every row is read through the canonical target vocabulary,
    // so `resolved` is keyed by canonical key in the canonical unit. Rows
    // stored before canonical keys (e.g. "calories") are interpreted by the
    // same deterministic alias map; anything uninterpretable is reported in
    // `unresolved_fields`, never guessed. Precedence is unchanged:
    // clinician_target over user_target, field by field.
    const { resolved, unresolved } = mergeCanonical([
      { source: 'clinician_target', rows: clinicianRows },
      { source: 'user_target', rows: userRows },
    ]);

    return {
      profile_id: profileId,
      resolved,
      unresolved_fields: unresolved,
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

interface TargetRow {
  id: string;
  field_name: string;
  value: number;
  unit: string;
}

/**
 * Field-by-field merge over sources given highest precedence first. For
 * each canonical key, the highest-precedence source that has any row for it
 * decides: one interpretable row -> resolved; two rows of that source for
 * the same key, or a row with an unconvertible unit/invalid value ->
 * unresolved (and a lower source does NOT silently fill it). Rows whose
 * name is not a target key are reported and never block anything.
 */
function mergeCanonical(sources: ReadonlyArray<{ source: 'clinician_target' | 'user_target'; rows: readonly TargetRow[] }>): {
  resolved: Record<string, ResolvedField>;
  unresolved: UnresolvedTargetField[];
} {
  const resolved: Record<string, ResolvedField> = {};
  const unresolved: UnresolvedTargetField[] = [];
  const decided = new Set<string>();

  for (const { source, rows } of sources) {
    const byKey = new Map<string, Array<{ row: TargetRow; normalized: ReturnType<typeof normalizeTarget> }>>();
    for (const row of [...rows].sort((a, b) => (a.field_name < b.field_name ? -1 : a.field_name > b.field_name ? 1 : a.id < b.id ? -1 : 1))) {
      const normalized = normalizeTarget(row.field_name, row.value, row.unit);
      const key = normalized.ok ? normalized.key : (resolveTargetKey(row.field_name)?.key ?? null);
      if (!key) {
        unresolved.push({ field_name: row.field_name, source, source_reference: row.id, reason: 'unknown_target_key' });
        continue;
      }
      const list = byKey.get(key) ?? [];
      list.push({ row, normalized });
      byKey.set(key, list);
    }
    for (const [key, entries] of [...byKey.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (decided.has(key)) continue; // a higher-precedence source already decided this key
      decided.add(key);
      const [only, ...rest] = entries;
      if (!only) continue;
      if (rest.length) {
        for (const e of entries) unresolved.push({ field_name: e.row.field_name, source, source_reference: e.row.id, reason: 'conflicting_rows' });
        continue;
      }
      if (!only.normalized.ok) {
        unresolved.push({ field_name: only.row.field_name, source, source_reference: only.row.id, reason: only.normalized.reason });
        continue;
      }
      resolved[key] = { value: only.normalized.value, unit: only.normalized.unit, source, source_reference: only.row.id };
    }
  }
  return { resolved, unresolved };
}

