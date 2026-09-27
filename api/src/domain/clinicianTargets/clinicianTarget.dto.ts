import type { ClinicianTargetDto } from './clinicianTarget.schemas';

export interface ClinicianTargetRow {
  id: string;
  profile_id: string;
  field_name: string;
  value: number;
  unit: string;
  source_type: ClinicianTargetDto['source_type'];
  verification_status: ClinicianTargetDto['verification_status'];
  provided_by_account_id: string;
  entered_at: string;
  is_active: boolean;
  superseded_at: string | null;
  created_at: string;
}

export const CLINICIAN_TARGET_COLUMNS =
  'id, profile_id, field_name, value, unit, source_type, verification_status, provided_by_account_id, entered_at, is_active, superseded_at, created_at';

export function toClinicianTargetDto(row: ClinicianTargetRow): ClinicianTargetDto {
  return { ...row };
}
