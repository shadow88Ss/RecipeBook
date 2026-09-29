// Layer 10B — Progress & Adherence: THREE separate, factual read models over
// historical truth owned by other modules. Nothing is written; there is no
// combined score.
//
//   plan_fulfillment     Layer 8B derived fulfillment of current confirmed
//                        planned items whose plan date is in the range (not
//                        re-matched here), counts per factual state, and
//                        unplanned actual items. No fulfilled-rate: which
//                        states count as "fulfilled" is not yet approved.
//   nutrition_adherence  per date: actual (immutable 7A snapshots) vs the
//                        date's Layer 10A daily target snapshot only.
//   goal_progress        WeightMeasurement history (corrections resolved,
//                        branches excluded) and active Goals compared with
//                        the latest active measurement; no percent-to-goal
//                        (no start value exists).
//
// Read scopes: every table read here is readable by full_management,
// view_only and pediatric_weight_management under the existing RLS; the
// analytics run as the caller (no service role) and broaden nothing.

import { requireProfileScope } from '../../lib/authorize';
import { AppError } from '../../lib/errors';
import { IN_MEMORY_PAGE_FETCH_CAP } from '../../lib/pagination';
import type { ScopedDbClient, ScopedDbFactory } from '../../lib/scopedDb';
import type { AuthContext } from '../../types/express';

import type { SnapshotRecord } from '../effectiveTarget/effectiveTarget.service';
import { GOAL_COLUMNS, type GoalRow } from '../goals/goal.dto';
import { FULFILLMENT_STATES, type FulfillmentState } from '../mealPlans/planFulfillment';
import type { PlanFulfillmentService } from '../mealPlans/planFulfillment.service';
import { MEAL_PLAN_COLUMNS, type MealPlanRow } from '../mealPlans/mealPlan.dto';
import { isActive, MEAL_ITEM_COLUMNS, MEAL_LOG_COLUMNS, type MealItemRow, type MealLogRow } from '../meals/meal.dto';
import { aggregateSnapshots, readSnapshot } from '../meals/meal.snapshot';
import { localDateOf } from '../meals/meal.time';
import { loadNutrientVocabulary, toAggregateDto } from '../nutrition/nutrition.service';
import { projectAggregateSummary } from '../nutrition/nutritionSummary';
import { WEIGHT_MEASUREMENT_COLUMNS, type WeightMeasurementRow } from '../weightMeasurements/weightMeasurement.dto';
import { goalProgress } from './progress.measurements';
import { nutritionDay, nutritionRange } from './progress.nutrition';
import type { ProgressQuery } from './progress.schemas';

const READ_SCOPES = ['full_management', 'view_only', 'pediatric_weight_management'] as const;
const PLAN_STATUSES_WITH_INTENT: readonly MealPlanRow['status'][] = ['active', 'completed', 'archived'];
const SNAPSHOT_COLUMNS =
  'id, profile_id, snapshot_payload, resolver_version, resolved_at, snapshot_reason, linked_event_type, linked_event_id, created_at, local_date, local_timezone, unresolved_fields';
export const PROGRESS_RULES_VERSION = 'progress-analytics-10b.1';

function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(`${from}T00:00:00Z`);
  for (let s = from; s <= to; d.setUTCDate(d.getUTCDate() + 1), s = d.toISOString().slice(0, 10)) out.push(s);
  return out;
}

export class ProgressService {
  constructor(
    private readonly dbFactory: ScopedDbFactory,
    private readonly fulfillment: PlanFulfillmentService,
  ) {}

  async get(auth: AuthContext, profileId: string, query: ProgressQuery) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, READ_SCOPES);
    const today = localDateOf(new Date(), query.timezone);
    if (query.to > today) {
      throw AppError.validation('The range ends after the current local date.', { issues: [{ path: 'to', message: `Must not be after ${today} in ${query.timezone}.` }] });
    }
    const dates = datesBetween(query.from, query.to);
    const [plan, nutrition, goal] = await Promise.all([
      this.planFulfillment(auth, db, profileId, query),
      nutritionAdherence(db, profileId, dates),
      measurementProgress(db, profileId, query),
    ]);
    return {
      profile_id: profileId,
      range: { from: query.from, to: query.to, timezone: query.timezone, days_requested: dates.length },
      rules_version: PROGRESS_RULES_VERSION,
      combined_score: null,
      plan_fulfillment: plan,
      nutrition_adherence: nutrition,
      goal_progress: goal,
    };
  }

  private async planFulfillment(auth: AuthContext, db: ScopedDbClient, profileId: string, query: ProgressQuery) {
    const plans = (await db.select<MealPlanRow>('meal_plan', { columns: MEAL_PLAN_COLUMNS, eq: { profile_id: profileId }, limit: IN_MEMORY_PAGE_FETCH_CAP }))
      .filter((p) => PLAN_STATUSES_WITH_INTENT.includes(p.status) && p.start_date <= query.to && p.end_date >= query.from)
      .sort((a, b) => (a.start_date !== b.start_date ? (a.start_date < b.start_date ? -1 : 1) : a.id < b.id ? -1 : 1));
    const emptyStates = () => Object.fromEntries(FULFILLMENT_STATES.map((s) => [s, 0])) as Record<FulfillmentState, number>;
    const total = emptyStates();
    const unplanned = new Map<string, { id: string; plan_local_date: string }>();
    const perPlan = [];
    for (const plan of plans) {
      const f = await this.fulfillment.plan(auth, profileId, plan.id);
      const inRange = (d: string) => d >= query.from && d <= query.to;
      const items = f.days.filter((d) => inRange(d.plan_date)).flatMap((d) => d.items); // current confirmed intent only
      const counts = emptyStates();
      for (const i of items) {
        counts[i.fulfillment_state] += 1;
        total[i.fulfillment_state] += 1;
      }
      for (const u of f.unplanned_actual_items) if (inRange(u.plan_local_date)) unplanned.set(u.id, { id: u.id, plan_local_date: u.plan_local_date });
      perPlan.push({ meal_plan_id: plan.id, name: plan.name, status: plan.status, start_date: plan.start_date, end_date: plan.end_date, local_timezone: plan.local_timezone, counts: countsDto(counts) });
    }
    const unplannedRows = unplanned.size
      ? await db.select<MealItemRow>('meal_item', { columns: MEAL_ITEM_COLUMNS, eq: { profile_id: profileId }, in: { id: [...unplanned.keys()] }, limit: IN_MEMORY_PAGE_FETCH_CAP })
      : [];
    const unplannedAggregate = unplannedRows.length ? aggregateSnapshots(unplannedRows.map((r) => readSnapshot(r.nutrition_snapshot))) : null;
    return {
      source: 'layer_8b_derived_fulfillment' as const,
      plan_count: plans.length,
      counts: countsDto(total),
      fulfilled_item_rate: {
        value: null,
        status: 'classification_not_approved' as const,
        note: 'Which fulfillment states count as fulfilled is not yet approved; counts are factual.',
      },
      unplanned_actual_item_count: unplanned.size,
      unplanned_actual_items: [...unplanned.values()].sort((a, b) => (a.plan_local_date < b.plan_local_date ? -1 : a.plan_local_date > b.plan_local_date ? 1 : a.id < b.id ? -1 : 1)),
      unplanned_actual_nutrition: unplannedAggregate
        ? { summary: projectAggregateSummary(unplannedAggregate, unplannedRows.length), coverage_summary: toAggregateDto(unplannedAggregate, unplannedRows.length).coverage_summary }
        : null,
      plans: perPlan,
    };
  }
}

function countsDto(byState: Record<FulfillmentState, number>) {
  const confirmed = Object.values(byState).reduce((a, b) => a + b, 0);
  return {
    confirmed_planned_items: confirmed,
    fulfilled_exact: byState.fulfilled_exact,
    fulfilled_with_substitution: byState.fulfilled_with_substitution,
    above_planned_quantity: byState.above_planned_quantity,
    partial: byState.partial,
    skipped: byState.skipped,
    unlinked: byState.unlinked,
    not_comparable: byState.quantity_not_comparable + byState.identity_changed_by_correction,
    by_state: byState,
  };
}

async function nutritionAdherence(db: ScopedDbClient, profileId: string, dates: readonly string[]) {
  const [logs, snapshots, vocabulary] = await Promise.all([
    db.select<MealLogRow>('meal_log', { columns: MEAL_LOG_COLUMNS, eq: { profile_id: profileId }, in: { logged_date: dates }, limit: IN_MEMORY_PAGE_FETCH_CAP }),
    db.select<SnapshotRecord>('effective_target_snapshot', { columns: SNAPSHOT_COLUMNS, eq: { profile_id: profileId, snapshot_reason: 'daily_tracking' }, in: { local_date: dates }, limit: IN_MEMORY_PAGE_FETCH_CAP }),
    loadNutrientVocabulary(db),
  ]);
  const items = logs.length
    ? await db.select<MealItemRow>('meal_item', { columns: MEAL_ITEM_COLUMNS, in: { meal_log_id: logs.map((l) => l.id) }, limit: 10 * IN_MEMORY_PAGE_FETCH_CAP })
    : [];
  const snapshotByDate = new Map(snapshots.filter((s) => s.local_date !== null).map((s) => [s.local_date as string, s]));
  const days = dates.map((date) => {
    const dayLogs = logs.filter((l) => l.logged_date === date);
    const logIds = new Set(dayLogs.map((l) => l.id));
    return nutritionDay({ date, mealCount: dayLogs.length, activeItems: items.filter((i) => logIds.has(i.meal_log_id) && isActive(i)), snapshot: snapshotByDate.get(date) ?? null }, vocabulary);
  });
  const withConsumption = days.filter((d) => d.result.has_consumption);
  return {
    actual_source: 'recorded_meal_item_snapshots' as const,
    target_source: 'daily_tracking_target_snapshots' as const,
    range_summary: {
      days_requested: days.length,
      days_with_consumption: withConsumption.length,
      days_with_historical_target: days.filter((d) => d.result.target_context === 'daily_snapshot').length,
      days_without_historical_target: days.filter((d) => d.result.target_context === 'target_context_unavailable').length,
      days_with_consumption_and_target: withConsumption.filter((d) => d.result.target_context === 'daily_snapshot').length,
      days_with_consumption_without_target: withConsumption.filter((d) => d.result.target_context === 'target_context_unavailable').length,
    },
    nutrient_summary: nutritionRange(days),
    daily: days.map((d) => d.result),
  };
}

async function measurementProgress(db: ScopedDbClient, profileId: string, query: ProgressQuery) {
  const [rows, goals] = await Promise.all([
    db.select<WeightMeasurementRow>('weight_measurement', { columns: WEIGHT_MEASUREMENT_COLUMNS, eq: { profile_id: profileId }, limit: 10 * IN_MEMORY_PAGE_FETCH_CAP }),
    db.select<GoalRow>('goal', { columns: GOAL_COLUMNS, eq: { profile_id: profileId }, limit: IN_MEMORY_PAGE_FETCH_CAP }),
  ]);
  return { measurement_type: 'body_weight' as const, ...goalProgress({ rows, goals, from: query.from, to: query.to, timeZone: query.timezone }) };
}

