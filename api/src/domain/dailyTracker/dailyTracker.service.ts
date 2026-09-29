// Layer 7B — Daily Nutrition Tracker. A READ MODEL: it computes nothing
// authoritative and writes nothing.
//
//   actual  = the day's MealLogs (logged_date = the requested Profile-local
//             day) -> active consumed MealItems (consumed, not superseded)
//             -> their immutable Layer 7A snapshots -> aggregateSnapshots
//             (engine aggregateCoverage) -> Layer 5C summary.
//             Never recalculated from Food/FoodServing/FoodNutrient/density
//             or recipes.
//   target  = Layer 10A target context for the requested local date:
//             1. the day's `daily_tracking` EffectiveTargetSnapshot, if one
//                was captured (first capture freezes the day — also TODAY:
//                later target edits do not change a frozen day);
//             2. otherwise, for the CURRENT local day only, the live
//                EffectiveTargetResolver (`live_current_target`);
//             3. otherwise `historical_target_unavailable` — never today's
//                target, never reconstructed from target-row history.
//             GET never captures a snapshot: viewing cannot freeze a day.
//
// Read scopes: every table read here (meal_log, meal_item, nutrition_target,
// clinician_target, nutrient) is readable by full_management, view_only and
// pediatric_weight_management under the existing RLS — never broadened.
//
// Queries per request: profile scope, meal_log, meal_item (one query for
// the whole day), nutrient vocabulary, the day's daily snapshot lookup, and
// — current day without a snapshot only — the resolver's two target
// queries. No per-item queries.

import { requireProfileScope } from '../../lib/authorize';
import { AppError } from '../../lib/errors';
import { IN_MEMORY_PAGE_FETCH_CAP } from '../../lib/pagination';
import type { ScopedDbFactory } from '../../lib/scopedDb';
import type { AuthContext } from '../../types/express';
import { CONVERSION_VERSION, ROUNDING_MODE } from '../conversion/conversion.engine';
import { ZERO } from '../conversion/decimal';
import { findDailySnapshot, IMPLEMENTED_SOURCES, RESOLVER_VERSION, type EffectiveTargetService } from '../effectiveTarget/effectiveTarget.service';
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

    // Target context (Layer 10A): frozen daily snapshot > live (today only) > unavailable.
    const snapshot = await findDailySnapshot(db, profileId, query.date);
    const live = !snapshot && isCurrentDay ? await this.targets.resolve(auth, profileId) : null;
    const resolvedTarget = snapshot
      ? { resolved: snapshot.snapshot_payload, unresolved_fields: snapshot.unresolved_fields ?? [], resolver_version: snapshot.resolver_version, resolved_at: snapshot.resolved_at, implemented_sources: snapshot.resolver_version === RESOLVER_VERSION ? [...IMPLEMENTED_SOURCES] : [] }
      : live;
    const { mapped, unmapped } = resolvedTarget ? mapTargets(resolvedTarget.resolved, resolvedTarget.unresolved_fields, vocabulary) : { mapped: [], unmapped: [] };
    const context = snapshot ? ('daily_snapshot' as const) : live ? ('live_current_target' as const) : ('historical_target_unavailable' as const);
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
            status: snapshot ? ('daily_snapshot' as const) : ('current' as const),
            context,
            daily_snapshot: snapshot
              ? { id: snapshot.id, local_date: snapshot.local_date, local_timezone: snapshot.local_timezone, snapshot_reason: snapshot.snapshot_reason, captured_at: snapshot.created_at }
              : null,
            resolver_version: resolvedTarget.resolver_version,
            resolved_at: resolvedTarget.resolved_at,
            implemented_sources: resolvedTarget.implemented_sources,
            unresolved_fields: resolvedTarget.unresolved_fields,
            fields: Object.entries(resolvedTarget.resolved)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([field_name, f]) => ({ field_name, value: f.value, unit: f.unit, source: f.source, source_reference: f.source_reference })),
          }
        : {
            status: 'historical_target_unavailable' as const,
            context,
            daily_snapshot: null,
            resolver_version: null,
            resolved_at: null,
            implemented_sources: [],
            unresolved_fields: [],
            fields: [],
          },
      comparison: {
        status: resolvedTarget ? ('available' as const) : ('historical_target_unavailable' as const),
        nutrients: mapped
          .map((t) => compareToTarget(actualById.get(t.nutrient.id), t))
          .sort((a, b) => (a.nutrient_key < b.nutrient_key ? -1 : a.nutrient_key > b.nutrient_key ? 1 : 0)),
        unmapped_targets: unmapped,
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
