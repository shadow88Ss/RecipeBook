// Layer 10B — measurement history and goal comparison: a pure read model.
//
// WeightMeasurement is append-only; a correction is a NEW row whose
// `corrects_measurement_id` names the row it corrects. Active measurements
// are those no other row corrects, so A -> B -> C resolves to C alone. Since
// the Layer 10B closure the database allows at most one direct correction
// per measurement (uq_weight_measurement_single_correction); a LEGACY branch
// that predates it cannot be resolved without guessing, so every row
// descending from it is reported as `conflicting_correction` and excluded
// from first/latest/change — never picked. Ordering is by measured_at (then created_at, id), never
// insertion order. Nothing is interpolated, smoothed or predicted.
//
// Goals: the schema stores goal_type and an optional target_weight_kg, but
// no starting value, so a percent-to-goal is never computed. Weight goals
// with a target get a factual latest-vs-target difference; others are
// listed as not measurement-comparable. goal_type is reported as stored,
// with no success/failure interpretation.

import { fromNumber, roundHalfUp, type Rational } from '../conversion/decimal';
import type { GoalRow } from '../goals/goal.dto';
import { localDateOf } from '../meals/meal.time';
import type { WeightMeasurementRow } from '../weightMeasurements/weightMeasurement.dto';

export const WEIGHT_GOAL_TYPES = ['weight_loss', 'maintenance', 'weight_gain'] as const;

export type MeasurementState = 'active' | 'superseded_by_correction' | 'conflicting_correction';

const byTime = (a: WeightMeasurementRow, b: WeightMeasurementRow) =>
  a.measured_at !== b.measured_at ? (a.measured_at < b.measured_at ? -1 : 1) : a.created_at !== b.created_at ? (a.created_at < b.created_at ? -1 : 1) : a.id < b.id ? -1 : 1;

/** Signed a - b of two non-negative decimals, rounded half-up (away from
 * zero) to 6 places. */
function signedDifference(a: number, b: number): number {
  const x: Rational = fromNumber(Number(a));
  const y: Rational = fromNumber(Number(b));
  const n = x.n * y.d - y.n * x.d;
  const magnitude = Number(roundHalfUp({ n: n < 0n ? -n : n, d: x.d * y.d }, 6));
  return n < 0n && magnitude !== 0 ? -magnitude : magnitude;
}

export function classifyMeasurements(rows: readonly WeightMeasurementRow[]): Map<string, MeasurementState> {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const correctors = new Map<string, string[]>();
  for (const r of rows) {
    if (r.corrects_measurement_id && byId.has(r.corrects_measurement_id)) {
      correctors.set(r.corrects_measurement_id, [...(correctors.get(r.corrects_measurement_id) ?? []), r.id]);
    }
  }
  const inBranch = (row: WeightMeasurementRow): boolean => {
    let current = row;
    for (let guard = 0; current.corrects_measurement_id && guard < 10_000; guard += 1) {
      if ((correctors.get(current.corrects_measurement_id)?.length ?? 0) > 1) return true;
      const parent = byId.get(current.corrects_measurement_id);
      if (!parent) break;
      current = parent;
    }
    return false;
  };
  const out = new Map<string, MeasurementState>();
  for (const r of rows) {
    if (correctors.has(r.id)) out.set(r.id, 'superseded_by_correction');
    else if (inBranch(r)) out.set(r.id, 'conflicting_correction');
    else out.set(r.id, 'active');
  }
  return out;
}

const measurementDto = (r: WeightMeasurementRow, state: MeasurementState, timeZone: string) => ({
  id: r.id,
  measured_at: r.measured_at,
  local_date: localDateOf(r.measured_at, timeZone),
  value: Number(r.value_kg),
  unit: 'kg' as const,
  source: r.source,
  corrects_measurement_id: r.corrects_measurement_id,
  state,
});

export function goalProgress(input: { rows: readonly WeightMeasurementRow[]; goals: readonly GoalRow[]; from: string; to: string; timeZone: string }) {
  const states = classifyMeasurements(input.rows);
  const sorted = [...input.rows].sort(byTime);
  const inRange = sorted.filter((r) => {
    const d = localDateOf(r.measured_at, input.timeZone);
    return d >= input.from && d <= input.to;
  });
  const activeInRange = inRange.filter((r) => states.get(r.id) === 'active');
  const first = activeInRange[0] ?? null;
  const latest = activeInRange[activeInRange.length - 1] ?? null;
  // "current" for a goal comparison = latest active measurement up to the range end
  const latestUpToEnd = [...sorted].reverse().find((r) => states.get(r.id) === 'active' && localDateOf(r.measured_at, input.timeZone) <= input.to) ?? null;

  const goals = input.goals
    .filter((g) => g.is_active)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1))
    .map((g) => {
      const isWeightGoal = (WEIGHT_GOAL_TYPES as readonly string[]).includes(g.goal_type);
      const base = { goal_id: g.id, goal_type: g.goal_type, target_weight_kg: g.target_weight_kg === null ? null : Number(g.target_weight_kg), target_date: g.target_date };
      const noPercentage = { progress_percentage: null, progress_percentage_status: 'not_computable_goal_has_no_start_value' as const };
      if (!isWeightGoal) return { ...base, measurement_comparison: 'not_a_measurement_goal' as const, latest_measurement: null, difference_from_target_kg: null, ...noPercentage };
      if (g.target_weight_kg === null) return { ...base, measurement_comparison: 'no_target_weight' as const, latest_measurement: null, difference_from_target_kg: null, ...noPercentage };
      if (!latestUpToEnd) return { ...base, measurement_comparison: 'no_measurement' as const, latest_measurement: null, difference_from_target_kg: null, ...noPercentage };
      return {
        ...base,
        measurement_comparison: 'latest_measurement_vs_target' as const,
        latest_measurement: { id: latestUpToEnd.id, measured_at: latestUpToEnd.measured_at, value: Number(latestUpToEnd.value_kg), unit: 'kg' as const },
        // latest - target (factual; no direction judgement)
        difference_from_target_kg: signedDifference(latestUpToEnd.value_kg, g.target_weight_kg),
        ...noPercentage,
      };
    });

  return {
    measurements: inRange.map((r) => measurementDto(r, states.get(r.id) ?? 'active', input.timeZone)),
    active_measurement_count: activeInRange.length,
    excluded: {
      superseded_by_correction: inRange.filter((r) => states.get(r.id) === 'superseded_by_correction').length,
      conflicting_correction: inRange.filter((r) => states.get(r.id) === 'conflicting_correction').length,
    },
    first_active: first ? measurementDto(first, 'active', input.timeZone) : null,
    latest_active: latest ? measurementDto(latest, 'active', input.timeZone) : null,
    absolute_change_kg: first && latest && first.id !== latest.id ? signedDifference(latest.value_kg, first.value_kg) : null,
    goals,
    inactive_goal_count: input.goals.filter((g) => !g.is_active).length,
    interpretation: 'none' as const,
  };
}
