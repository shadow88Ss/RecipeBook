import type { NutritionTargetDto } from './nutritionTarget.schemas';

export interface NutritionTargetRow {
  id: string;
  profile_id: string;
  field_name: string;
  value: number;
  unit: string;
  is_active: boolean;
  superseded_at: string | null;
  created_at: string;
  updated_at: string;
}

export const NUTRITION_TARGET_COLUMNS = 'id, profile_id, field_name, value, unit, is_active, superseded_at, created_at, updated_at';

export function toNutritionTargetDto(row: NutritionTargetRow): NutritionTargetDto {
  return { ...row };
}
