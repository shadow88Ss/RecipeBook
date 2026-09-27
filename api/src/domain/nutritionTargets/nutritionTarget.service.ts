// Layer 4B §4 — NutritionTarget domain logic.
//
// Allowed scopes transcribed from 20260825121300_rls_targets_and_goals.sql
// (nutrition_target_select_authorized, nutrition_target_insert_managed) and
// 20260825121900_rls_pediatric_weight_management.sql (nutrition_target_
// select_pediatric, nutrition_target_insert_pediatric): SELECT is
// full_management + view_only + pediatric_weight_management; INSERT is
// full_management + pediatric_weight_management only. There is no UPDATE
// grant for ANY scope (20260825121300's comment: "clients only ever INSERT
// a new row [...] is_active and superseded_at are never client-writable") —
// this service never issues an UPDATE against nutrition_target; "replacing"
// a field is always a new INSERT, and 20260825120400's BEFORE INSERT
// trg_nutrition_target_supersede trigger deactivates the prior active row
// for the same (profile_id, field_name) atomically, enforced together with
// uq_nutrition_target_active_field so a duplicate-active state can never
// exist even transiently — this service adds no additional locking.

import { requireProfileScope } from '../../lib/authorize';
import { paginateInMemory, type Page, type PaginationQuery } from '../../lib/pagination';
import type { ScopedDbFactory } from '../../lib/scopedDb';
import type { AuthContext } from '../../types/express';
import { NUTRITION_TARGET_COLUMNS, toNutritionTargetDto, type NutritionTargetRow } from './nutritionTarget.dto';
import type { NutritionTargetCreateInput, NutritionTargetDto, NutritionTargetHistoryQuery } from './nutritionTarget.schemas';

const READ_SCOPES = ['full_management', 'view_only', 'pediatric_weight_management'] as const;
const WRITE_SCOPES = ['full_management', 'pediatric_weight_management'] as const;
const FETCH_CAP = 1000;

export class NutritionTargetService {
  constructor(private readonly dbFactory: ScopedDbFactory) {}

  /** Current active value per field only — one row per field_name
   * (uq_nutrition_target_active_field). */
  async listActive(auth: AuthContext, profileId: string, pagination: PaginationQuery): Promise<Page<NutritionTargetDto>> {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, READ_SCOPES);
    const rows = await db.select<NutritionTargetRow>('nutrition_target', {
      columns: NUTRITION_TARGET_COLUMNS,
      eq: { profile_id: profileId, is_active: true },
      order: { column: 'field_name', ascending: true },
      limit: FETCH_CAP,
    });
    return paginateInMemory(rows.map(toNutritionTargetDto), pagination);
  }

  /** Full history (active + superseded), optionally scoped to one
   * field_name — RLS's SELECT policy has no is_active filter, so superseded
   * rows are readable to the same scopes as the active one (Layer 4B spec
   * §4: "retrieving target history where the specification permits it"). */
  async listHistory(auth: AuthContext, profileId: string, query: NutritionTargetHistoryQuery): Promise<Page<NutritionTargetDto>> {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, READ_SCOPES);
    const eq: Record<string, string | boolean> = { profile_id: profileId };
    if (query.field_name) eq.field_name = query.field_name;
    const rows = await db.select<NutritionTargetRow>('nutrition_target', {
      columns: NUTRITION_TARGET_COLUMNS,
      eq,
      order: { column: 'created_at', ascending: false },
      limit: FETCH_CAP,
    });
    return paginateInMemory(rows.map(toNutritionTargetDto), { cursor: query.cursor, limit: query.limit });
  }

  /** "Replacing" a target field is always this: a new row, never an UPDATE
   * of the row being replaced (Layer 4B spec §4: "Do not UPDATE historical
   * target values in place. Do not bypass the database supersession
   * trigger."). */
  async create(auth: AuthContext, profileId: string, input: NutritionTargetCreateInput): Promise<NutritionTargetDto> {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, WRITE_SCOPES);
    const row = await db.insert<NutritionTargetRow>(
      'nutrition_target',
      { profile_id: profileId, field_name: input.field_name, value: input.value, unit: input.unit },
      NUTRITION_TARGET_COLUMNS,
    );
    return toNutritionTargetDto(row);
  }
}
