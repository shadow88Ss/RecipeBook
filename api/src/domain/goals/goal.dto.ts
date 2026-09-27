// Layer 4B §14 — Goal has no account/security-internal columns to redact
// (unlike Profile), but every row still passes through an explicit
// projection rather than being returned as-is, so the response contract is
// never accidentally widened by a future column addition to the table.

import type { GoalDto } from './goal.schemas';

export interface GoalRow {
  id: string;
  profile_id: string;
  goal_type: GoalDto['goal_type'];
  target_weight_kg: number | null;
  target_date: string | null;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export const GOAL_COLUMNS = 'id, profile_id, goal_type, target_weight_kg, target_date, notes, is_active, created_at, updated_at';

export function toGoalDto(row: GoalRow): GoalDto {
  return {
    id: row.id,
    profile_id: row.profile_id,
    goal_type: row.goal_type,
    target_weight_kg: row.target_weight_kg,
    target_date: row.target_date,
    notes: row.notes,
    is_active: row.is_active,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
