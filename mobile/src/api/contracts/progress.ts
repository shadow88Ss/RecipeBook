// docs/30_API.md §26 — GET /v1/profiles/{id}/progress. Three separate factual
// sections; the app shows them as reported and adds no score or judgement.

import { z } from 'zod';

import { localDateSchema } from './common';

const rateSchema = z.object({ count: z.number(), denominator: z.number(), percentage: z.number().nullable() });

export const RATE_KEYS = [
  'exact_fulfillment_rate',
  'substitution_rate',
  'above_planned_quantity_rate',
  'partial_rate',
  'skip_rate',
  'unlinked_rate',
  'not_comparable_rate',
] as const;
export type RateKey = (typeof RATE_KEYS)[number];

const measurementSchema = z.object({ measured_at: z.string(), local_date: z.string(), value: z.number(), unit: z.literal('kg') });

export const progressSchema = z.object({
  profile_id: z.string(),
  range: z.object({ from: localDateSchema, to: localDateSchema, timezone: z.string(), days_requested: z.number() }),
  rules_version: z.string(),
  combined_score: z.null(),
  plan_fulfillment: z.object({
    plan_count: z.number(),
    rates: z.object({
      denominator: z.object({ value: z.number() }),
      status: z.enum(['computed', 'no_eligible_planned_items']),
      exact_fulfillment_rate: rateSchema,
      substitution_rate: rateSchema,
      above_planned_quantity_rate: rateSchema,
      partial_rate: rateSchema,
      skip_rate: rateSchema,
      unlinked_rate: rateSchema,
      not_comparable_rate: rateSchema,
    }),
    unplanned_actual_item_count: z.number(),
  }),
  nutrition_adherence: z.object({
    range_summary: z.object({
      days_requested: z.number(),
      days_with_consumption: z.number(),
      days_with_historical_target: z.number(),
      days_without_historical_target: z.number(),
    }),
    nutrient_summary: z.array(
      z.object({
        nutrient_key: z.string(),
        unit: z.string().nullable(),
        days_with_target: z.number(),
        days_comparable: z.number(),
        average_actual: z.number().nullable(),
        average_target: z.number().nullable(),
        average_percentage_of_target: z.number().nullable(),
      }),
    ),
  }),
  goal_progress: z.object({
    active_measurement_count: z.number(),
    first_active: measurementSchema.nullable(),
    latest_active: measurementSchema.nullable(),
    absolute_change_kg: z.number().nullable(),
    goals: z.array(
      z.object({
        goal_id: z.string(),
        goal_type: z.string(),
        target_weight_kg: z.number().nullable(),
        measurement_comparison: z.string(),
        difference_from_target_kg: z.number().nullable(),
      }),
    ),
  }),
});
export type Progress = z.infer<typeof progressSchema>;
