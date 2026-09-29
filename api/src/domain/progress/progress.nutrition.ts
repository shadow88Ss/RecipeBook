// Layer 10B — nutrition target adherence: a pure read model.
//
// For each Profile-local date (MealLog.logged_date, as the Daily Tracker):
//   actual = the day's ACTIVE consumed MealItems' immutable Layer 7A
//            snapshots, aggregated by the engine (never recalculated);
//   target = ONLY the day's Layer 10A `daily_tracking` snapshot. A date
//            without one is `target_context_unavailable` — never today's
//            target, never the live resolver, never reconstructed.
// Comparison statuses are the Daily Tracker's (compareToTarget / mapTargets
// — no second definition). `percentage_of_target = actual / target x 100`
// only when the actual is complete, the target is > 0 and units map; a
// partial actual yields only a lower bound; unavailable yields nothing. No
// tolerance / "met target" rule exists (none is approved), no clamping, no
// good/bad labels.

import { add, div, fromNumber, mul, roundHalfUp, ZERO, type Rational } from '../conversion/decimal';
import { compareToTarget, mapTargets, type ComparisonStatus } from '../dailyTracker/dailyTracker.comparison';
import type { SnapshotRecord } from '../effectiveTarget/effectiveTarget.service';
import type { MealItemRow } from '../meals/meal.dto';
import { aggregateSnapshots, readSnapshot } from '../meals/meal.snapshot';
import { NUTRITION_DECIMAL_PLACES, type AggregateNutrient, type NutrientDefinition } from '../nutrition/nutrition.engine';
import { toAggregateDto } from '../nutrition/nutrition.service';
import { projectAggregateSummary } from '../nutrition/nutritionSummary';

const HUNDRED = fromNumber(100);
const num = (r: Rational) => Number(roundHalfUp(r, NUTRITION_DECIMAL_PLACES));

export interface NutritionDayInput {
  date: string;
  mealCount: number;
  activeItems: readonly MealItemRow[];
  snapshot: SnapshotRecord | null;
}

export type PercentageStatus = 'exact' | 'lower_bound_partial_actual' | 'actual_unavailable' | 'target_not_positive' | 'no_consumption_logged';

interface NutrientDay {
  nutrient_key: string;
  unit: string;
  comparable: boolean;
  actual: Rational | null;
  actualCoverage: AggregateNutrient['coverage'];
  target: Rational;
  percentage: Rational | null;
  status: ComparisonStatus | 'no_consumption_logged';
}

function percentage(actual: Rational, target: Rational): Rational {
  return div(mul(actual, HUNDRED), target);
}

/** One date. Nutrient comparisons exist only when the day has a daily
 * target snapshot; a day with no logged consumption is reported as such
 * (not compared as an intake of zero — no log is not proof of eating
 * nothing). */
export function nutritionDay(day: NutritionDayInput, vocabulary: readonly NutrientDefinition[]) {
  const hasConsumption = day.activeItems.length > 0;
  const actual = hasConsumption ? aggregateSnapshots(day.activeItems.map((i) => readSnapshot(i.nutrition_snapshot))) : [];
  const actualById = new Map(actual.map((a) => [a.nutrient.id, a]));
  const view = hasConsumption ? toAggregateDto(actual, day.activeItems.length) : null;
  const { mapped, unmapped } = day.snapshot ? mapTargets(day.snapshot.snapshot_payload, day.snapshot.unresolved_fields ?? [], vocabulary) : { mapped: [], unmapped: [] };

  const nutrients: NutrientDay[] = [];
  const dto = mapped.map((t) => {
    const a = actualById.get(t.nutrient.id);
    const cmp = compareToTarget(a, t);
    let pct: Rational | null = null;
    let pctStatus: PercentageStatus;
    if (!hasConsumption) pctStatus = 'no_consumption_logged';
    else if (!a || a.value === null || a.coverage === 'unavailable') pctStatus = 'actual_unavailable';
    else if (t.value.n <= 0n) pctStatus = 'target_not_positive';
    else {
      pct = percentage(a.value, t.value);
      pctStatus = a.coverage === 'complete' ? 'exact' : 'lower_bound_partial_actual';
    }
    const comparable = hasConsumption && pctStatus === 'exact';
    nutrients.push({
      nutrient_key: t.nutrient.canonical_key,
      unit: t.nutrient.unit,
      comparable,
      actual: a?.value ?? null,
      actualCoverage: a?.coverage ?? 'unavailable',
      target: t.value,
      percentage: pct,
      status: hasConsumption ? cmp.comparison_status : 'no_consumption_logged',
    });
    return {
      nutrient_key: t.nutrient.canonical_key,
      unit: t.nutrient.unit,
      actual: hasConsumption ? cmp.actual : null,
      target: cmp.target,
      comparison_status: hasConsumption ? cmp.comparison_status : ('no_consumption_logged' as const),
      remaining: hasConsumption ? cmp.remaining : null,
      over_target_by: hasConsumption ? cmp.over_target_by : null,
      percentage_of_target: pct && pctStatus === 'exact' ? num(pct) : null,
      percentage_of_target_at_least: pct && pctStatus === 'lower_bound_partial_actual' ? num(pct) : null,
      percentage_status: pctStatus,
    };
  });

  return {
    result: {
      date: day.date,
      target_context: day.snapshot ? ('daily_snapshot' as const) : ('target_context_unavailable' as const),
      target_snapshot: day.snapshot
        ? { id: day.snapshot.id, local_timezone: day.snapshot.local_timezone, resolver_version: day.snapshot.resolver_version, captured_at: day.snapshot.created_at }
        : null,
      meal_count: day.mealCount,
      active_item_count: day.activeItems.length,
      has_consumption: hasConsumption,
      actual: view
        ? { basis: 'recorded_snapshots' as const, summary: projectAggregateSummary(actual, day.activeItems.length), coverage_summary: view.coverage_summary }
        : { basis: 'no_consumption_logged' as const, summary: null, coverage_summary: null },
      nutrients: dto,
      unmapped_targets: unmapped,
    },
    nutrients,
  };
}

/** Range aggregates per canonical nutrient. Averages use COMPARABLE days
 * only (consumption logged, complete actual, positive target); partial,
 * unavailable, no-consumption and no-target days are counted, never
 * averaged as zero. */
export function nutritionRange(days: ReadonlyArray<ReturnType<typeof nutritionDay>>) {
  const keys = [...new Set(days.flatMap((d) => d.nutrients.map((n) => n.nutrient_key)))].sort();
  return keys.map((key) => {
    const entries = days.flatMap((d) => d.nutrients.filter((n) => n.nutrient_key === key));
    const comparable = entries.filter((e) => e.comparable);
    const statusCounts: Record<string, number> = {};
    for (const e of entries) statusCounts[e.status] = (statusCounts[e.status] ?? 0) + 1;
    const mean = (values: Rational[]) => (values.length ? num(div(values.reduce(add, ZERO), fromNumber(values.length))) : null);
    return {
      nutrient_key: key,
      unit: entries[0]?.unit ?? null,
      days_with_target: entries.length,
      days_comparable: comparable.length,
      days_partial_actual: entries.filter((e) => e.actualCoverage === 'partial' && e.status !== 'no_consumption_logged').length,
      days_actual_unavailable: entries.filter((e) => e.status === 'actual_unavailable').length,
      days_no_consumption_logged: entries.filter((e) => e.status === 'no_consumption_logged').length,
      comparison_status_counts: statusCounts,
      average_actual: mean(comparable.map((e) => e.actual as Rational)),
      average_target: mean(comparable.map((e) => e.target)),
      average_percentage_of_target: mean(comparable.map((e) => e.percentage as Rational)),
      averages_basis: 'comparable_days_only' as const,
    };
  });
}
