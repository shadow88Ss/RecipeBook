import type { WeightMeasurementDto } from './weightMeasurement.schemas';

export interface WeightMeasurementRow {
  id: string;
  profile_id: string;
  measured_at: string;
  value_kg: number;
  source: WeightMeasurementDto['source'];
  provenance_reference: string | null;
  corrects_measurement_id: string | null;
  created_at: string;
}

export const WEIGHT_MEASUREMENT_COLUMNS =
  'id, profile_id, measured_at, value_kg, source, provenance_reference, corrects_measurement_id, created_at';

export function toWeightMeasurementDto(row: WeightMeasurementRow): WeightMeasurementDto {
  return { ...row };
}
