// Layer 4B §6 — WeightMeasurement domain logic.
//
// Allowed scopes transcribed from 20260825121300_rls_targets_and_goals.sql
// (weight_measurement_select_authorized, weight_measurement_insert_managed)
// and 20260825121900_rls_pediatric_weight_management.sql
// (weight_measurement_select_pediatric, weight_measurement_insert_
// pediatric): SELECT is full_management + view_only + pediatric_weight_
// management; INSERT is full_management + pediatric_weight_management
// (view_only cannot record a measurement). There is no UPDATE or DELETE
// path anywhere — 20260825120400's trg_weight_measurement_prevent_update
// blocks UPDATE unconditionally at the database layer regardless of RLS,
// and no DELETE grant/policy exists. A correction is always a new row
// referencing the one it corrects via corrects_measurement_id. At most one
// row may correct a given measurement (Layer 10B closure; unique index
// uq_weight_measurement_single_correction), so corrections form a chain:
// a second direct correction is 409 CONFLICT — correct the latest row.

import { AppError } from '../../lib/errors';
import { requireProfileScope } from '../../lib/authorize';
import { paginateInMemory, type Page, type PaginationQuery } from '../../lib/pagination';
import type { ScopedDbFactory } from '../../lib/scopedDb';
import type { AuthContext } from '../../types/express';
import { WEIGHT_MEASUREMENT_COLUMNS, toWeightMeasurementDto, type WeightMeasurementRow } from './weightMeasurement.dto';
import type { WeightMeasurementCreateInput, WeightMeasurementDto } from './weightMeasurement.schemas';

const READ_SCOPES = ['full_management', 'view_only', 'pediatric_weight_management'] as const;
const WRITE_SCOPES = ['full_management', 'pediatric_weight_management'] as const;
const FETCH_CAP = 1000;

export class WeightMeasurementService {
  constructor(private readonly dbFactory: ScopedDbFactory) {}

  async list(auth: AuthContext, profileId: string, pagination: PaginationQuery): Promise<Page<WeightMeasurementDto>> {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, READ_SCOPES);
    const rows = await db.select<WeightMeasurementRow>('weight_measurement', {
      columns: WEIGHT_MEASUREMENT_COLUMNS,
      eq: { profile_id: profileId },
      order: { column: 'measured_at', ascending: false },
      limit: FETCH_CAP,
    });
    return paginateInMemory(rows.map(toWeightMeasurementDto), pagination);
  }

  async create(auth: AuthContext, profileId: string, input: WeightMeasurementCreateInput): Promise<WeightMeasurementDto> {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, WRITE_SCOPES);

    if (input.corrects_measurement_id) {
      const referenced = await db.select<{ id: string }>('weight_measurement', {
        columns: 'id',
        eq: { id: input.corrects_measurement_id, profile_id: profileId },
        limit: 1,
      });
      if (referenced.length === 0) {
        throw AppError.validation('corrects_measurement_id must reference an existing measurement for this profile.');
      }
    }

    const row = await insertMeasurement(() => db.insert<WeightMeasurementRow>(
      'weight_measurement',
      {
        profile_id: profileId,
        measured_at: input.measured_at,
        value_kg: input.value_kg,
        // Always 'user_entered' through this endpoint — see file header.
        source: 'user_entered',
        provenance_reference: null,
        corrects_measurement_id: input.corrects_measurement_id ?? null,
      },
      WEIGHT_MEASUREMENT_COLUMNS,
    ));
    return toWeightMeasurementDto(row);
  }
}

/** Maps the single-correction refusal to a safe API error — never the SQL message. */
async function insertMeasurement<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if ((err as { code?: unknown }).code === '23505') {
      throw AppError.conflict('This measurement has already been corrected. Correct the latest measurement in its correction chain instead.');
    }
    throw err;
  }
}
