// Response fixtures shaped like docs/30_API.md §12, §19, §26.

import type { AppConfig } from '../../src/config';

export const TEST_CONFIG: AppConfig = {
  environment: 'development',
  apiBaseUrl: 'https://api.test.example',
  supabaseUrl: 'https://proj.supabase.test',
  supabaseAnonKey: 'sb_publishable_test_key',
  oauthProviders: [],
};

export const USER_ID = '11111111-1111-4111-8111-111111111111';
export const ACCOUNT_ID = '22222222-2222-4222-8222-222222222222';
export const PROFILE_A = '33333333-3333-4333-8333-333333333333';
export const PROFILE_B = '44444444-4444-4444-8444-444444444444';

export function profileDto(id: string, name: string, scope = 'full_management') {
  return scope === 'pediatric_weight_management'
    ? { id, display_name: name, is_child: true, date_of_birth: '2016-05-01', access_scope: scope }
    : { id, account_id: ACCOUNT_ID, display_name: name, is_child: false, date_of_birth: null, created_at: '2026-01-01T00:00:00Z', access_scope: scope };
}

export function profilePage(items: object[], nextCursor: string | null = null) {
  return { data: items, pagination: { nextCursor, limit: 100 } };
}

type Cov = 'complete' | 'partial' | 'unavailable';
export function summaryEntry(key: string, value: number | null, coverage: Cov, resolved = 1, count = 1) {
  return {
    nutrient_key: key,
    value,
    is_zero: value === 0,
    below_output_precision: false,
    coverage,
    status: coverage === 'complete' ? null : coverage === 'partial' ? 'partial' : 'no_data',
    resolved_item_count: resolved,
    item_count: count,
  };
}

export function trackerDto(overrides: Record<string, unknown> = {}) {
  return {
    profile_id: PROFILE_A,
    date: '2026-09-30',
    timezone: 'UTC',
    is_current_day: true,
    meal_count: 2,
    active_item_count: 3,
    actual: {
      basis: 'recorded_snapshots',
      precision: { decimal_places: 6, rounding: 'half_up' },
      conversion_version: 'x',
      summary: {
        energy_kcal: summaryEntry('energy', 1234.5, 'complete', 3, 3),
        protein_g: summaryEntry('protein', 40, 'partial', 2, 3),
        carbohydrate_g: summaryEntry('carbohydrate', null, 'unavailable', 0, 3),
        fat_g: summaryEntry('fat', 50, 'complete', 3, 3),
        fiber_g: summaryEntry('fiber', 10, 'complete', 3, 3),
      },
      item_count: 3,
      coverage_summary: {},
      nutrients: [],
    },
    target: {
      status: 'current',
      context: 'live_current_target',
      daily_snapshot: null,
      resolver_version: 'r1',
      resolved_at: '2026-09-30T08:00:00Z',
      implemented_sources: ['clinician_target', 'user_target'],
      unresolved_fields: [],
      fields: [{ field_name: 'energy', value: 2000, unit: 'kcal', source: 'user_target', source_reference: 't1' }],
    },
    comparison: {
      status: 'available',
      nutrients: [
        {
          nutrient_key: 'energy',
          nutrient_role: 'energy',
          unit: 'kcal',
          actual: { value: 1234.5, is_zero: false, below_output_precision: false, coverage: 'complete' },
          target: { value: 2000, field_name: 'energy', source: 'user_target', source_reference: 't1', original_value: 2000, original_unit: 'kcal' },
          comparison_status: 'below_target',
          remaining: 765.5,
          remaining_at_most: null,
          over_target_by: 0,
          over_target_by_at_least: null,
        },
        {
          nutrient_key: 'protein',
          nutrient_role: 'macronutrient',
          unit: 'g',
          actual: { value: 40, is_zero: false, below_output_precision: false, coverage: 'partial' },
          target: { value: 100, field_name: 'protein', source: 'clinician_target', source_reference: 't2', original_value: 100, original_unit: 'g' },
          comparison_status: 'undetermined',
          remaining: null,
          remaining_at_most: 60,
          over_target_by: null,
          over_target_by_at_least: null,
        },
      ],
      unmapped_targets: [],
    },
    meal_groups: [{ meal_type: 'breakfast', meals: [{ id: 'm1', meal_type: 'breakfast', active_item_count: 2, items: [] }] }],
    ...overrides,
  };
}

export function noConsumptionTrackerDto() {
  const zero = (key: string) => ({ ...summaryEntry(key, 0, 'complete', 0, 0), is_zero: true });
  return trackerDto({
    meal_count: 0,
    active_item_count: 0,
    actual: {
      basis: 'no_consumption',
      summary: { energy_kcal: zero('energy'), protein_g: zero('protein'), carbohydrate_g: zero('carbohydrate'), fat_g: zero('fat'), fiber_g: zero('fiber') },
      item_count: 0,
    },
    meal_groups: [],
  });
}

export function historicalUnavailableTrackerDto() {
  return trackerDto({
    is_current_day: false,
    date: '2026-09-20',
    target: { status: 'historical_target_unavailable', context: 'historical_target_unavailable', daily_snapshot: null, resolver_version: null, resolved_at: null, implemented_sources: [], unresolved_fields: [], fields: [] },
    comparison: { status: 'historical_target_unavailable', nutrients: [], unmapped_targets: [] },
  });
}

const rate = (count: number, denominator: number, percentage: number | null) => ({ count, denominator, percentage });

export function progressDto(overrides: Record<string, unknown> = {}) {
  return {
    profile_id: PROFILE_A,
    range: { from: '2026-09-24', to: '2026-09-30', timezone: 'UTC', days_requested: 7 },
    rules_version: 'progress-analytics-10b.2',
    combined_score: null,
    plan_fulfillment: {
      source: 'layer_8b_derived_fulfillment',
      plan_count: 1,
      counts: {},
      rates: {
        denominator: { name: 'eligible_current_confirmed_planned_items', value: 8 },
        status: 'computed',
        exact_fulfillment_rate: rate(4, 8, 50),
        substitution_rate: rate(1, 8, 12.5),
        above_planned_quantity_rate: rate(0, 8, 0),
        partial_rate: rate(1, 8, 12.5),
        skip_rate: rate(1, 8, 12.5),
        unlinked_rate: rate(1, 8, 12.5),
        not_comparable_rate: rate(0, 8, 0),
      },
      fulfilled_item_rate: { value: null, status: 'deprecated_no_combined_classification' },
      unplanned_actual_item_count: 2,
      unplanned_actual_items: [],
      unplanned_actual_nutrition: null,
      plans: [],
    },
    nutrition_adherence: {
      daily: [],
      range_summary: { days_requested: 7, days_with_consumption: 5, days_with_historical_target: 4, days_without_historical_target: 3, days_with_consumption_and_target: 4, days_with_consumption_without_target: 1 },
      nutrient_summary: [
        { nutrient_key: 'energy', unit: 'kcal', days_with_target: 4, days_comparable: 3, days_partial_actual: 1, days_actual_unavailable: 0, days_no_consumption_logged: 0, comparison_status_counts: {}, average_actual: 1800, average_target: 2000, average_percentage_of_target: 90, averages_basis: 'comparable_days_only' },
        { nutrient_key: 'fiber', unit: 'g', days_with_target: 4, days_comparable: 0, days_partial_actual: 4, days_actual_unavailable: 0, days_no_consumption_logged: 0, comparison_status_counts: {}, average_actual: null, average_target: null, average_percentage_of_target: null, averages_basis: 'comparable_days_only' },
      ],
    },
    goal_progress: {
      measurement_type: 'body_weight',
      interpretation: 'none',
      measurements: [],
      active_measurement_count: 2,
      excluded: {},
      first_active: { id: 'w1', measured_at: '2026-09-24T07:00:00Z', local_date: '2026-09-24', value: 80.4, unit: 'kg', source: 'manual', corrects_measurement_id: null, state: 'active' },
      latest_active: { id: 'w2', measured_at: '2026-09-30T07:00:00Z', local_date: '2026-09-30', value: 79.9, unit: 'kg', source: 'manual', corrects_measurement_id: null, state: 'active' },
      absolute_change_kg: -0.5,
      goals: [{ goal_id: 'g1', goal_type: 'weight_loss', target_weight_kg: 75, target_date: null, measurement_comparison: 'latest_measurement_vs_target', latest_measurement: { id: 'w2', measured_at: '2026-09-30T07:00:00Z', value: 79.9, unit: 'kg' }, difference_from_target_kg: 4.9, progress_percentage: null, progress_percentage_status: 'not_computable_goal_has_no_start_value' }],
      inactive_goal_count: 0,
    },
    ...overrides,
  };
}
