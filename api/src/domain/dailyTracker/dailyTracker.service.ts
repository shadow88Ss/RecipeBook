// Layer 7B — Daily Nutrition Tracker. A READ MODEL: it computes nothing
// authoritative and writes nothing.
//
//   actual  = the day's MealLogs (logged_date = the requested Profile-local
//             day) -> active consumed MealItems (consumed, not superseded)
//             -> their immutable Layer 7A snapshots -> aggregateSnapshots
//             (engine aggregateCoverage) -> Layer 5C summary.
//             Never recalculated from Food/FoodServing/FoodNutrient/density
//             or recipes.
//   target  = the single EffectiveTargetResolver, and ONLY for the current
//             local day. No EffectiveTargetSnapshot is tied to a local date,
//             and target history cannot be re-resolved without a new policy,
//             so a past day reports `historical_target_unavailable` rather
//             than comparing with today's target.
//
// Read scopes: every table read here (meal_log, meal_item, nutrition_target,
// clinician_target, nutrient) is readable by full_management, view_only and
// pediatric_weight_management under the existing RLS — never broadened.
//
// Queries per request: profile scope, meal_log, meal_item (one query for
// the whole day), nutrient vocabulary, and — current day only — the
// resolver's two target queries. No per-item queries.

import { requireProfileScope } from '../../lib/authorize';
import { AppError } from '../../lib/errors';
import { IN_MEMORY_PAGE_FETCH_CAP } from '../../lib/pagination';
import type { ScopedDbFactory } from '../../lib/scopedDb';
import type { AuthContext } from '../../types/express';
import { CONVERSION_VERSION, ROUNDING_MODE } from '../conversion/conversion.engine';
import { ZERO } from '../conversion/decimal';
import type { EffectiveTargetService } from '../effectiveTarget/effectiveTarget.service';
import { MEAL_ITEM_COLUMNS, MEAL_LOG_COLUMNS, isActive, toMealItemDto, toMealNutritionDto, type MealItemRow, type MealLogRow } from '../meals/meal.dto';
import { MEAL_READ_SCOPES } from '../meals/meal.service';
import { MEAL_TYPES } from '../meals/meal.schemas';
import { aggregateSnapshots, readSnapshot } from '../meals/meal.snapshot';
import { localDateOf } from '../meals/meal.time';
import { NUTRITION_DECIMAL_PLACES, type AggregateNutrient, type NutrientDefinition } from '../nutrition/nutrition.engine';
import { loadNutrientVocabulary, toAggregateDto } from '../nutrition/nutrition.service';
import { projectAggregateSummary } from '../nutrition/nutritionSummary';
import { compareToTarget, mapTargets } from './dailyTracker.comparison';
import type { DailyTrackerQuery } from './dailyTracker.schemas';

/** A day with no active consumed items: every nutrient is a KNOWN zero
 * (nothing was consumed), distinct from unknown data inside a consumed item. */
function noConsumption(vocabulary: readonly NutrientDefinition[]): AggregateNutrient[] {
  return vocabulary.map((nutrient) => ({ nutrient, value: ZERO, coverage: 'complete', resolved_item_count: 0, item_count: 0, missing: [] }));
}

export class DailyTrackerService {
  constructor(
    private readonly dbFactory: ScopedDbFactory,
    private readonly targets: EffectiveTargetService,
  ) {}

  async get(auth: AuthContext, profileId: string, query: DailyTrackerQuery) {
    const db = this.dbFactory.forUser(auth);
    await requireProfileScope(db, profileId, MEAL_READ_SCOPES);

    const today = localDateOf(new Date(), query.timezone);
    if (query.date > today) {
      throw AppError.validation('date is after the current local date.', { issues: [{ path: 'date', message: `Must not be after ${today} in ${query.timezone}.` }] });
    }
    const isCurrentDay = query.date === today;

    const [logs, vocabulary] = await Promise.all([
      db.select<MealLogRow>('meal_log', {
        columns: MEAL_LOG_COLUMNS,
        eq: { profile_id: profileId, logged_date: query.date },
        order: { column: 'created_at', ascending: true },
        limit: IN_MEMORY_PAGE_FETCH_CAP,
      }),
      loadNutrientVocabulary(db),
    ]);
    const items = logs.length
      ? await db.select<MealItemRow>('meal_item', {
          columns: MEAL_ITEM_COLUMNS,
          in: { meal_log_id: logs.map((l) => l.id) },
          order: { column: 'created_at', ascending: true },
          limit: IN_MEMORY_PAGE_FETCH_CAP,
        })
      : [];
    const active = items.filter(isActive);

    // Actual intake: recorded snapshots only.
    const actual = active.length ? aggregateSnapshots(active.map((i) => readSnapshot(i.nutrition_snapshot))) : noConsumption(vocabulary);
    const actualView = toAggregateDto(actual, active.length);

    // Target: current local day only.
    const resolvedTarget = isCurrentDay ? await this.targets.resolve(auth, profileId) : null;
    const { mapped, unmapped } = resolvedTarget ? mapTargets(resolvedTarget.resolved, vocabulary) : { mapped: [], unmapped: [] };
    const actualById = new Map(actual.map((a) => [a.nutrient.id, a]));

    return {
      profile_id: profileId,
      date: query.date,
      timezone: query.timezone,
      is_current_day: isCurrentDay,
      meal_count: logs.length,
      active_item_count: active.length,
      actual: {
        basis: active.length ? ('recorded_snapshots' as const) : ('no_consumption' as const),
        precision: { decimal_places: NUTRITION_DECIMAL_PLACES, rounding: ROUNDING_MODE },
        conversion_version: CONVERSION_VERSION,
        summary: projectAggregateSummary(actual, active.length),
        item_count: actualView.item_count,
        coverage_summary: actualView.coverage_summary,
        nutrients: actualView.nutrients,
      },
      target: resolvedTarget
        ? {
            status: 'current' as const,
            resolver_version: resolvedTarget.resolver_version,
            resolved_at: resolvedTarget.resolved_at,
            implemented_sources: resolvedTarget.implemented_sources,
            fields: Object.entries(resolvedTarget.resolved)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([field_name, f]) => ({ field_name, value: f.value, unit: f.unit, source: f.source, source_reference: f.source_reference })),
          }
        : { status: 'historical_target_unavailable' as const, resolver_version: null, resolved_at: null, implemented_sources: [], fields: [] },
      comparison: {
        status: resolvedTarget ? ('available' as const) : ('historical_target_unavailable' as const),
        nutrients: mapped
          .map((t) => compareToTarget(actualById.get(t.nutrient.id), t))
          .sort((a, b) => (a.nutrient_key < b.nutrient_key ? -1 : a.nutrient_key > b.nutrient_key ? 1 : 0)),
        unmapped_targets: unmapped.map((u) => ({ field_name: u.field_name, value: u.resolved.value, unit: u.resolved.unit, source: u.resolved.source, reason: u.reason })),
      },
      meal_groups: MEAL_TYPES.flatMap((mealType) => {
        const meals = logs.filter((l) => l.meal_type === mealType);
        if (!meals.length) return [];
        return [
          {
            meal_type: mealType,
            meals: meals.map((log) => {
              const mealItems = items.filter((i) => i.meal_log_id === log.id);
              const nutrition = toMealNutritionDto(mealItems, { includeNutrients: false });
              return {
                id: log.id,
                meal_type: log.meal_type,
                logged_date: log.logged_date,
                local_timezone: log.local_timezone,
                notes: log.notes,
                created_at: log.created_at,
                active_item_count: nutrition.active_item_ids.length,
                items: mealItems.filter(isActive).map((i) => toMealItemDto(i)),
                nutrition: { summary: nutrition.summary, item_count: nutrition.item_count, coverage_summary: nutrition.coverage_summary },
              };
            }),
          },
        ];
      }),
    };
  }
}
