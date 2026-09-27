// Layer 5C — the high-level nutrition summary: a PROJECTION of Layer 5B
// results, not a calculator. It looks up five canonical vocabulary keys in
// an already-calculated result and copies their value, coverage/status and
// counts. There is no arithmetic here: no summing, no scaling, no energy
// derivation, no unit conversion. A missing nutrient stays unavailable
// (value null), a partial one stays partial, a known zero stays a known
// zero.
//
// Stable field names for recipe cards, meal logs, the daily tracker, meal
// plans and progress screens. Each field is bound to one canonical key AND
// its reporting unit; if the nutrient is absent from the vocabulary or its
// unit differs, the field is unavailable rather than mislabeled.

import type { AggregateNutrient, Coverage, ItemCalculation, NutrientStatus } from './nutrition.engine';
import { roundValue } from './nutrition.engine';
import { NUTRIENT_KEYS } from './vocabulary';

export const SUMMARY_FIELDS = [
  { field: 'energy_kcal', key: NUTRIENT_KEYS.energy, unit: 'kcal' },
  { field: 'protein_g', key: NUTRIENT_KEYS.protein, unit: 'g' },
  { field: 'carbohydrate_g', key: NUTRIENT_KEYS.carbohydrate, unit: 'g' },
  { field: 'fat_g', key: NUTRIENT_KEYS.fat, unit: 'g' },
  { field: 'fiber_g', key: NUTRIENT_KEYS.fiber, unit: 'g' },
] as const;

export type SummaryField = (typeof SUMMARY_FIELDS)[number]['field'];

export interface SummaryValue {
  nutrient_key: string;
  value: number | null;
  is_zero: boolean;
  below_output_precision: boolean;
  coverage: Coverage;
  /** Why the value is absent or incomplete; null when complete. */
  status: NutrientStatus | 'partial' | 'not_in_vocabulary' | 'unit_mismatch' | null;
  resolved_item_count: number;
  item_count: number;
}

export type NutritionSummary = Record<SummaryField, SummaryValue>;

const UNAVAILABLE = { value: null, is_zero: false, below_output_precision: false } as const;

/** Projects the Layer 5B aggregate onto the five summary fields. */
export function projectAggregateSummary(aggregate: readonly AggregateNutrient[], itemCount: number): NutritionSummary {
  const summary = {} as NutritionSummary;
  for (const { field, key, unit } of SUMMARY_FIELDS) {
    const entry = aggregate.find((n) => n.nutrient.canonical_key === key);
    if (!entry || entry.nutrient.unit !== unit) {
      summary[field] = {
        nutrient_key: key,
        ...UNAVAILABLE,
        coverage: 'unavailable',
        status: entry ? 'unit_mismatch' : 'not_in_vocabulary',
        resolved_item_count: 0,
        item_count: itemCount,
      };
      continue;
    }
    summary[field] = {
      nutrient_key: key,
      ...(entry.value !== null ? roundValue(entry.value) : UNAVAILABLE),
      coverage: entry.coverage,
      status: entry.coverage === 'complete' ? null : entry.coverage === 'partial' ? 'partial' : 'no_data',
      resolved_item_count: entry.resolved_item_count,
      item_count: entry.item_count,
    };
  }
  return summary;
}

/** Projects one Layer 5B item onto the five summary fields. */
export function projectItemSummary(item: ItemCalculation): NutritionSummary {
  const summary = {} as NutritionSummary;
  for (const { field, key, unit } of SUMMARY_FIELDS) {
    const entry = item.nutrients.find((n) => n.nutrient.canonical_key === key);
    if (!entry || entry.unit !== unit) {
      summary[field] = {
        nutrient_key: key,
        ...UNAVAILABLE,
        coverage: 'unavailable',
        status: entry ? 'unit_mismatch' : 'not_in_vocabulary',
        resolved_item_count: 0,
        item_count: 1,
      };
      continue;
    }
    const resolved = entry.status === 'resolved' && entry.value !== null;
    summary[field] = {
      nutrient_key: key,
      ...(resolved && entry.value !== null ? roundValue(entry.value) : UNAVAILABLE),
      coverage: resolved ? 'complete' : 'unavailable',
      status: resolved ? null : entry.status,
      resolved_item_count: resolved ? 1 : 0,
      item_count: 1,
    };
  }
  return summary;
}
