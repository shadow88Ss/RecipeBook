// docs/30_API.md §19, §25 — GET /v1/profiles/{id}/daily-tracker.
// The app renders what the server computed: coverage states, the target
// context and the comparison. It does no nutrition arithmetic.

import { z } from 'zod';

import { coverageSchema, localDateSchema, roundedValueSchema } from './common';

export const SUMMARY_FIELDS = ['energy_kcal', 'protein_g', 'carbohydrate_g', 'fat_g', 'fiber_g'] as const;
export type SummaryField = (typeof SUMMARY_FIELDS)[number];

export const summaryEntrySchema = roundedValueSchema.extend({
  nutrient_key: z.string(),
  coverage: coverageSchema,
  status: z.string().nullable(),
  resolved_item_count: z.number(),
  item_count: z.number(),
});
export type SummaryEntry = z.infer<typeof summaryEntrySchema>;

export const nutritionSummarySchema = z.object({
  energy_kcal: summaryEntrySchema,
  protein_g: summaryEntrySchema,
  carbohydrate_g: summaryEntrySchema,
  fat_g: summaryEntrySchema,
  fiber_g: summaryEntrySchema,
});

export const COMPARISON_STATUSES = ['below_target', 'at_target', 'above_target', 'at_or_above_target', 'undetermined', 'actual_unavailable'] as const;

export const comparisonEntrySchema = z.object({
  nutrient_key: z.string(),
  unit: z.string(),
  actual: roundedValueSchema.extend({ coverage: coverageSchema }),
  target: z.object({ value: z.number().nullable(), field_name: z.string(), source: z.string() }),
  comparison_status: z.enum(COMPARISON_STATUSES),
  remaining: z.number().nullable(),
  remaining_at_most: z.number().nullable(),
  over_target_by: z.number().nullable(),
  over_target_by_at_least: z.number().nullable(),
});
export type ComparisonEntry = z.infer<typeof comparisonEntrySchema>;

export const TARGET_CONTEXTS = ['live_current_target', 'daily_snapshot', 'historical_target_unavailable'] as const;
export type TargetContext = (typeof TARGET_CONTEXTS)[number];

export const dailyTrackerSchema = z.object({
  profile_id: z.string(),
  date: localDateSchema,
  timezone: z.string(),
  is_current_day: z.boolean(),
  meal_count: z.number(),
  active_item_count: z.number(),
  actual: z.object({
    basis: z.enum(['recorded_snapshots', 'no_consumption']),
    summary: nutritionSummarySchema,
    item_count: z.number(),
  }),
  target: z.object({
    status: z.enum(['current', 'daily_snapshot', 'historical_target_unavailable']),
    context: z.enum(TARGET_CONTEXTS),
    daily_snapshot: z.object({ local_date: z.string(), captured_at: z.string() }).nullable(),
    fields: z.array(z.object({ field_name: z.string() })),
    unresolved_fields: z.array(z.unknown()),
  }),
  comparison: z.object({
    status: z.enum(['available', 'historical_target_unavailable']),
    nutrients: z.array(comparisonEntrySchema),
    unmapped_targets: z.array(z.unknown()),
  }),
  meal_groups: z.array(
    z.object({
      meal_type: z.string(),
      meals: z.array(z.object({ id: z.string(), meal_type: z.string(), active_item_count: z.number() })),
    }),
  ),
});
export type DailyTracker = z.infer<typeof dailyTrackerSchema>;
