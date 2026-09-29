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
import { AppError } from '../../lib/errors';
import type { ScopedDbClient } from '../../lib/scopedDb';
import { localDateOf } from '../meals/meal.time';
import type { DailySnapshotCaptureInput, DailySnapshotListQuery, EffectiveTargetResponse, ResolvedField, SnapshotDto, UnresolvedTargetField } from './effectiveTarget.schemas';

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
  local_date: string | null;
  local_timezone: string | null;
  unresolved_fields: UnresolvedTargetField[] | null;
}
const SNAPSHOT_COLUMNS =
  'id, profile_id, snapshot_payload, resolver_version, resolved_at, snapshot_reason, linked_event_type, linked_event_id, created_at, local_date, local_timezone, unresolved_fields';

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
   * Layer 10A — explicit, idempotent daily target capture. Freezes the
   * Profile's target context for ONE local calendar date: the first
   * successful capture for (profile, local_date) is the day's authoritative
   * historical target; a retry, a concurrent capture or a capture in another
   * time zone for the same date returns that same snapshot (`created:
   * false`), never a second truth. Only the CURRENT local date in the given
   * IANA zone can be captured (past and future are refused) because the
   * resolver answers only "what is effective now". Content comes from
   * resolve() — the single precedence implementation. full_management
   * (incl. owners) only; pediatric_weight_management reads but does not
   * create snapshots (existing RLS, unchanged).
   */
  async captureDaily(auth: AuthContext, profileId: string, input: DailySnapshotCaptureInput): Promise<{ created: boolean; snapshot: SnapshotRow }> {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, SNAPSHOT_WRITE_SCOPES);
    const today = localDateOf(new Date(), input.timezone);
    if (input.local_date !== today) {
      throw AppError.validation('A daily target snapshot can only be captured for the current local date.', {
        issues: [{ path: 'local_date', message: `Must be ${today} (the current date in ${input.timezone}); past and future dates cannot be captured.` }],
      });
    }
    const existing = await findDailySnapshot(db, profileId, input.local_date);
    if (existing) return { created: false, snapshot: existing };

    const resolved = await this.resolve(auth, profileId);
    try {
      const row = await db.insert<SnapshotRow>(
        'effective_target_snapshot',
        {
          profile_id: profileId,
          snapshot_payload: resolved.resolved,
          resolver_version: resolved.resolver_version,
          resolved_at: resolved.resolved_at,
          snapshot_reason: 'daily_tracking',
          local_date: input.local_date,
          local_timezone: input.timezone,
          unresolved_fields: resolved.unresolved_fields,
        },
        SNAPSHOT_COLUMNS,
      );
      return { created: true, snapshot: row };
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (code === '23505') {
        // a concurrent capture won: its snapshot is the day's truth
        const winner = await findDailySnapshot(db, profileId, input.local_date);
        if (winner) return { created: false, snapshot: winner };
      }
      if (code === '23514') throw AppError.conflict('The local date changed while capturing; retry with the current date.');
      if (code === '22023') throw AppError.validation('Invalid time zone.');
      if (code === '42501') throw AppError.forbidden('This operation is not permitted for this profile.');
      throw err;
    }
  }

  /** Layer 10A — the historical target context for one local date:
   * the daily snapshot, or `historical_target_unavailable` (never derived
   * from today's target or from target-row history). */
  async dailySnapshot(auth: AuthContext, profileId: string, localDate: string) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, READ_SCOPES);
    const snapshot = await findDailySnapshot(db, profileId, localDate);
    return snapshot
      ? { local_date: localDate, context: 'daily_snapshot' as const, snapshot: toDailySnapshotDto(snapshot) }
      : { local_date: localDate, context: 'historical_target_unavailable' as const, snapshot: null };
  }

  async listDailySnapshots(auth: AuthContext, profileId: string, query: DailySnapshotListQuery) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, READ_SCOPES);
    const rows = (
      await db.select<SnapshotRow>('effective_target_snapshot', {
        columns: SNAPSHOT_COLUMNS,
        eq: { profile_id: profileId, snapshot_reason: 'daily_tracking' },
        order: { column: 'local_date', ascending: false },
        limit: FETCH_CAP,
      })
    ).filter((r) => (query.from === undefined || (r.local_date ?? '') >= query.from) && (query.to === undefined || (r.local_date ?? '') <= query.to));
    return paginateInMemory(rows.map(toDailySnapshotDto), query as PaginationQuery);
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


/** Layer 10A — the daily snapshot of a Profile + local date, if captured. */
export async function findDailySnapshot(db: ScopedDbClient, profileId: string, localDate: string): Promise<SnapshotRow | null> {
  const rows = await db.select<SnapshotRow>('effective_target_snapshot', {
    columns: SNAPSHOT_COLUMNS,
    eq: { profile_id: profileId, snapshot_reason: 'daily_tracking', local_date: localDate },
    limit: 1,
  });
  return rows[0] ?? null;
}

/** Historical target DTO: canonical fields in key order with provenance,
 * plus the capture context. No actor ids. */
export function toDailySnapshotDto(s: SnapshotRow) {
  return {
    id: s.id,
    profile_id: s.profile_id,
    local_date: s.local_date,
    local_timezone: s.local_timezone,
    snapshot_reason: s.snapshot_reason,
    resolver_version: s.resolver_version,
    resolved_at: s.resolved_at,
    captured_at: s.created_at,
    fields: Object.entries(s.snapshot_payload ?? {})
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([field_name, f]) => ({ field_name, value: f.value, unit: f.unit, source: f.source, source_reference: f.source_reference })),
    unresolved_fields: s.unresolved_fields ?? [],
  };
}

export type SnapshotRecord = SnapshotRow;
