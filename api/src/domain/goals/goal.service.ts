// Layer 4B §3 — Goal domain logic.
//
// Allowed-scope lists below are transcribed directly from
// 20260825121300_rls_targets_and_goals.sql (goal_select_authorized,
// goal_insert_managed, goal_update_managed) and
// 20260825121900_rls_pediatric_weight_management.sql (goal_select_pediatric,
// goal_insert_pediatric, goal_update_pediatric): SELECT is full_management +
// view_only + pediatric_weight_management; INSERT/UPDATE is full_management
// + pediatric_weight_management (view_only is read-only). There is no
// DELETE route — RLS permits full_management to hard-delete (unchanged,
// Layer 2 behavior), but 33_Security_and_Privacy.md's Goal model exposes
// `is_active` as the intended deactivation path and Layer 4B spec §3
// explicitly prefers that over inventing a DELETE endpoint.

import { requireProfileScope } from '../../lib/authorize';
import { AppError } from '../../lib/errors';
import { paginateInMemory, type Page, type PaginationQuery } from '../../lib/pagination';
import type { ScopedDbFactory } from '../../lib/scopedDb';
import type { AuthContext } from '../../types/express';
import { GOAL_COLUMNS, toGoalDto, type GoalRow } from './goal.dto';
import type { GoalCreateInput, GoalDto, GoalPatchInput } from './goal.schemas';

const READ_SCOPES = ['full_management', 'view_only', 'pediatric_weight_management'] as const;
const WRITE_SCOPES = ['full_management', 'pediatric_weight_management'] as const;
const FETCH_CAP = 1000;

export class GoalService {
  constructor(private readonly dbFactory: ScopedDbFactory) {}

  async list(auth: AuthContext, profileId: string, pagination: PaginationQuery): Promise<Page<GoalDto>> {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, READ_SCOPES);
    const rows = await db.select<GoalRow>('goal', {
      columns: GOAL_COLUMNS,
      eq: { profile_id: profileId },
      order: { column: 'created_at', ascending: false },
      limit: FETCH_CAP,
    });
    return paginateInMemory(rows.map(toGoalDto), pagination);
  }

  async getOne(auth: AuthContext, profileId: string, goalId: string): Promise<GoalDto> {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, READ_SCOPES);
    // Filtering on (id, profile_id) together, rather than id alone, is what
    // makes a Goal belonging to a DIFFERENT profile_id come back as 404
    // rather than leaking cross-profile (Testing item G) — even before RLS
    // would independently also block it.
    const rows = await db.select<GoalRow>('goal', { columns: GOAL_COLUMNS, eq: { id: goalId, profile_id: profileId }, limit: 1 });
    const row = rows[0];
    if (!row) throw AppError.notFound('Goal not found.');
    return toGoalDto(row);
  }

  async create(auth: AuthContext, profileId: string, input: GoalCreateInput): Promise<GoalDto> {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, WRITE_SCOPES);
    const row = await db.insert<GoalRow>(
      'goal',
      {
        profile_id: profileId,
        goal_type: input.goal_type,
        target_weight_kg: input.target_weight_kg ?? null,
        target_date: input.target_date ?? null,
        notes: input.notes ?? null,
        ...(input.is_active !== undefined ? { is_active: input.is_active } : {}),
      },
      GOAL_COLUMNS,
    );
    return toGoalDto(row);
  }

  async update(auth: AuthContext, profileId: string, goalId: string, patch: GoalPatchInput): Promise<GoalDto> {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, WRITE_SCOPES);

    const values: Record<string, unknown> = {};
    if (patch.goal_type !== undefined) values.goal_type = patch.goal_type;
    if (patch.target_weight_kg !== undefined) values.target_weight_kg = patch.target_weight_kg;
    if (patch.target_date !== undefined) values.target_date = patch.target_date;
    if (patch.notes !== undefined) values.notes = patch.notes;
    if (patch.is_active !== undefined) values.is_active = patch.is_active;

    const updated = await db.update<GoalRow>('goal', { id: goalId, profile_id: profileId }, values, GOAL_COLUMNS);
    if (!updated) throw AppError.notFound('Goal not found.');
    return toGoalDto(updated);
  }
}
