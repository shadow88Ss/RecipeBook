// Layer 12B.4 — per-nutrient lists the server already returns (docs/30_API.md
// §15, §19, §32). The vocabulary is OPEN: `nutrient_key` is any string, so a
// nutrient added on the server (e.g. Layer 12B.3's available_carbohydrate)
// is shown, not dropped. Values are the server's own; the app never derives one.

import { z } from 'zod';

import { coverageSchema, roundedValueSchema } from './common';

/** One nutrient of an aggregate (a day, a meal): coverage across its items. */
export const aggregateNutrientSchema = roundedValueSchema.extend({
  nutrient_key: z.string(),
  unit: z.string(),
  coverage: coverageSchema,
  resolved_item_count: z.number(),
  item_count: z.number(),
});
export type AggregateNutrient = z.infer<typeof aggregateNutrientSchema>;

/** One nutrient of a single item preview (Food or Product): its status and source. */
export const itemNutrientSchema = roundedValueSchema.extend({
  nutrient_key: z.string(),
  unit: z.string(),
  /** Layer 5B status: resolved | no_data | not_authoritative | ambiguous_nutrient_source | … */
  status: z.string(),
  source: z.object({ source: z.string(), authority: z.string() }).nullable().optional(),
});
export type ItemNutrient = z.infer<typeof itemNutrientSchema>;
