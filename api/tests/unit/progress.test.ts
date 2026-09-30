// Layer 10B unit tests — measurement classification, goal comparison and
// request validation (pure; no database).
import { describe, expect, it } from 'vitest';
import type { GoalRow } from '../../src/domain/goals/goal.dto';
import type { WeightMeasurementRow } from '../../src/domain/weightMeasurements/weightMeasurement.dto';
import { classifyMeasurements, goalProgress } from '../../src/domain/progress/progress.measurements';
import { nutritionRange } from '../../src/domain/progress/progress.nutrition';
import { progressQuerySchema } from '../../src/domain/progress/progress.schemas';
import { fulfillmentRates } from '../../src/domain/progress/progress.service';
import { FULFILLMENT_STATES, type FulfillmentState } from '../../src/domain/mealPlans/planFulfillment';

const m = (id: string, measured_at: string, value_kg: number, corrects: string | null = null): WeightMeasurementRow => ({
  id,
  profile_id: 'p',
  measured_at,
  value_kg,
  source: 'user_entered',
  provenance_reference: null,
  corrects_measurement_id: corrects,
  created_at: `${measured_at}|${id}`,
});
const goal = (partial: Partial<GoalRow>): GoalRow => ({ id: 'g', profile_id: 'p', goal_type: 'weight_loss', target_weight_kg: null, target_date: null, notes: null, is_active: true, created_at: 'x', updated_at: 'x', ...partial });

describe('measurement corrections', () => {
  it('a single correction chain leaves exactly one active record', () => {
    const s = classifyMeasurements([m('a', '2026-01-01T00:00:00Z', 80), m('b', '2026-01-01T00:00:00Z', 79, 'a'), m('c', '2026-01-01T00:00:00Z', 78, 'b')]);
    expect([...s.entries()]).toEqual([
      ['a', 'superseded_by_correction'],
      ['b', 'superseded_by_correction'],
      ['c', 'active'],
    ]);
  });

  it('two corrections of one record are a conflict: neither is picked (descendants included)', () => {
    const s = classifyMeasurements([m('a', 't', 80), m('b', 't', 79, 'a'), m('c', 't', 78, 'a'), m('d', 't', 77, 'c')]);
    expect(s.get('b')).toBe('conflicting_correction');
    expect(s.get('c')).toBe('superseded_by_correction');
    expect(s.get('d')).toBe('conflicting_correction');
  });
});

describe('goal comparison', () => {
  const rows = [m('b', '2026-01-10T08:00:00Z', 81.5), m('a', '2026-01-02T08:00:00Z', 83)];
  it('orders by measured_at, computes signed change, compares weight goals with a target only', () => {
    const g = goalProgress({ rows, goals: [goal({ target_weight_kg: 85, goal_type: 'weight_gain' }), goal({ id: 'h', goal_type: 'other' })], from: '2026-01-01', to: '2026-01-31', timeZone: 'UTC' });
    expect(g.first_active?.value).toBe(83);
    expect(g.latest_active?.value).toBe(81.5);
    expect(g.absolute_change_kg).toBe(-1.5);
    expect(g.goals[0]).toMatchObject({ goal_type: 'weight_gain', difference_from_target_kg: -3.5, progress_percentage: null });
    expect(g.goals[1]).toMatchObject({ measurement_comparison: 'not_a_measurement_goal' });
  });

  it('one measurement has no change; no measurement means no comparison', () => {
    expect(goalProgress({ rows: [rows[0] as WeightMeasurementRow], goals: [], from: '2026-01-01', to: '2026-01-31', timeZone: 'UTC' }).absolute_change_kg).toBeNull();
    expect(goalProgress({ rows: [], goals: [goal({ target_weight_kg: 70 })], from: '2026-01-01', to: '2026-01-31', timeZone: 'UTC' }).goals[0]).toMatchObject({ measurement_comparison: 'no_measurement', difference_from_target_kg: null });
  });
});

describe('range aggregation and request', () => {
  it('no days -> no nutrient summaries', () => {
    expect(nutritionRange([])).toEqual([]);
  });

  it('validates order, bounded length and the time zone', () => {
    expect(progressQuerySchema.safeParse({ from: '2026-01-01', to: '2026-01-31', timezone: 'Asia/Dubai' }).success).toBe(true);
    expect(progressQuerySchema.safeParse({ from: '2026-02-01', to: '2026-01-31', timezone: 'UTC' }).success).toBe(false);
    expect(progressQuerySchema.safeParse({ from: '2026-01-01', to: '2026-06-30', timezone: 'UTC' }).success).toBe(false);
    expect(progressQuerySchema.safeParse({ from: '2026-01-01', to: '2026-01-31' }).success).toBe(false);
  });
});

describe('fulfillment rates (10B closure)', () => {
  const zero = () => Object.fromEntries(FULFILLMENT_STATES.map((s) => [s, 0])) as Record<FulfillmentState, number>;
  const expectedBucket: Record<FulfillmentState, string> = {
    fulfilled_exact: 'exact_fulfillment_rate',
    fulfilled_with_substitution: 'substitution_rate',
    above_planned_quantity: 'above_planned_quantity_rate',
    partial: 'partial_rate',
    skipped: 'skip_rate',
    unlinked: 'unlinked_rate',
    quantity_not_comparable: 'not_comparable_rate',
    identity_changed_by_correction: 'not_comparable_rate',
  };

  it.each(FULFILLMENT_STATES)('A-H: one %s item contributes to exactly one rate', (state) => {
    const r = fulfillmentRates({ ...zero(), [state]: 1 });
    const hits = Object.entries(r).filter(([k, v]) => k.endsWith('_rate') && (v as { count: number }).count > 0);
    expect(hits).toEqual([[expectedBucket[state], { count: 1, denominator: 1, percentage: 100 }]]);
  });

  it('M: count / denominator x 100, exact then rounded half-up once to 6 places', () => {
    const r = fulfillmentRates({ ...zero(), fulfilled_exact: 2, partial: 1 });
    expect(r.exact_fulfillment_rate).toEqual({ count: 2, denominator: 3, percentage: 66.666667 });
    expect(r.partial_rate).toEqual({ count: 1, denominator: 3, percentage: 33.333333 });
    expect(r.denominator).toEqual({ name: 'eligible_current_confirmed_planned_items', value: 3 });
  });

  it('N/O: zero denominator gives null rates; no combined rate key exists', () => {
    const r = fulfillmentRates(zero());
    expect(r.status).toBe('no_eligible_planned_items');
    expect(Object.keys(r).sort()).toEqual(
      ['above_planned_quantity_rate', 'denominator', 'exact_fulfillment_rate', 'not_comparable_rate', 'partial_rate', 'skip_rate', 'status', 'substitution_rate', 'unlinked_rate'],
    );
    for (const [k, v] of Object.entries(r)) if (k.endsWith('_rate')) expect(v).toEqual({ count: 0, denominator: 0, percentage: null });
  });
});
