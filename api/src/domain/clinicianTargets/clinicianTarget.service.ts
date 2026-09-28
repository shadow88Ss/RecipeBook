// Layer 4B §5 — ClinicianTarget domain logic.
//
// Allowed scopes transcribed from 20260825121300_rls_targets_and_goals.sql
// (clinician_target_select_authorized, clinician_target_insert_managed) and
// 20260825121900_rls_pediatric_weight_management.sql
// (clinician_target_select_pediatric — deliberately no insert_pediatric):
// SELECT is full_management + view_only + pediatric_weight_management;
// INSERT is full_management ONLY. pediatric_weight_management cannot create
// a ClinicianTarget row at all — RLS's own comment is explicit that this
// scope "alone must not create clinician-target rows at all (not even
// unverified ones)" (Layer 4B spec §5: "Do not allow
// pediatric_weight_management to impersonate a clinician").
//
// verification_status, source_type, provided_by_account_id, and entered_at
// are never read from client input (see clinicianTarget.schemas.ts) — all
// four are computed here. verification_status is always 'unverified':
// creating a 'platform_verified' row requires a separate, not-yet-built,
// approved verified-clinician-integration workflow (RLS comment,
// clinician_target_insert_managed) — out of scope for Layer 4B, and
// reported as deferred rather than invented (spec §5).

import { canonicalTargetOrThrow, historyFieldNames } from '../nutritionTargets/targetVocabulary';
import { requireProfileScope } from '../../lib/authorize';
import { paginateInMemory, type Page, type PaginationQuery } from '../../lib/pagination';
import type { ScopedDbFactory } from '../../lib/scopedDb';
import type { AuthContext } from '../../types/express';
import { CLINICIAN_TARGET_COLUMNS, toClinicianTargetDto, type ClinicianTargetRow } from './clinicianTarget.dto';
import type { ClinicianTargetCreateInput, ClinicianTargetDto, ClinicianTargetHistoryQuery } from './clinicianTarget.schemas';

const READ_SCOPES = ['full_management', 'view_only', 'pediatric_weight_management'] as const;
const WRITE_SCOPES = ['full_management'] as const;
const FETCH_CAP = 1000;

export class ClinicianTargetService {
  constructor(private readonly dbFactory: ScopedDbFactory) {}

  async listActive(auth: AuthContext, profileId: string, pagination: PaginationQuery): Promise<Page<ClinicianTargetDto>> {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, READ_SCOPES);
    const rows = await db.select<ClinicianTargetRow>('clinician_target', {
      columns: CLINICIAN_TARGET_COLUMNS,
      eq: { profile_id: profileId, is_active: true },
      order: { column: 'field_name', ascending: true },
      limit: FETCH_CAP,
    });
    return paginateInMemory(rows.map(toClinicianTargetDto), pagination);
  }

  async listHistory(auth: AuthContext, profileId: string, query: ClinicianTargetHistoryQuery): Promise<Page<ClinicianTargetDto>> {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, READ_SCOPES);
    const eq: Record<string, string | boolean> = { profile_id: profileId };
    // Layer 7C: an alias or canonical key selects every stored name of that
    // key, so history written before canonical keys stays reachable.
    const names = query.field_name ? historyFieldNames(query.field_name) : undefined;
    const rows = await db.select<ClinicianTargetRow>('clinician_target', {
      columns: CLINICIAN_TARGET_COLUMNS,
      eq,
      ...(names ? { in: { field_name: names } } : {}),
      order: { column: 'created_at', ascending: false },
      limit: FETCH_CAP,
    });
    return paginateInMemory(rows.map(toClinicianTargetDto), { cursor: query.cursor, limit: query.limit });
  }

  async create(auth: AuthContext, profileId: string, input: ClinicianTargetCreateInput): Promise<ClinicianTargetDto> {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, WRITE_SCOPES);
    // Layer 7C: canonical key and reporting unit only (see targetVocabulary.ts).
    const target = canonicalTargetOrThrow(input);

    // source_type is system_computed (Data Dictionary §9): derived from
    // whether this is a child profile (guardian relaying a value on the
    // child's behalf) or the caller's own adult profile — never read from
    // the request.
    const profileRows = await db.select<{ is_child: boolean }>('profile', { columns: 'is_child', eq: { id: profileId }, limit: 1 });
    const isChild = profileRows[0]?.is_child ?? false;

    const row = await db.insert<ClinicianTargetRow>(
      'clinician_target',
      {
        profile_id: profileId,
        field_name: target.field_name,
        value: target.value,
        unit: target.unit,
        source_type: isChild ? 'guardian_entered' : 'user_entered',
        verification_status: 'unverified',
        provided_by_account_id: auth.accountId,
        entered_at: new Date().toISOString(),
      },
      CLINICIAN_TARGET_COLUMNS,
    );
    return toClinicianTargetDto(row);
  }
}
