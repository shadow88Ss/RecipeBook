// Layer 7B — actual-vs-target comparison. Pure; measurement only.
//
// Targets come from the single EffectiveTargetResolver, which (Layer 7C)
// returns them keyed by canonical target key — the Layer 5C nutrient key —
// in that nutrient's reporting unit. The tracker therefore maps a target to
// the nutrient with the same key, re-checking the unit defensively; rows the
// resolver could not interpret arrive as its `unresolved_fields` and are
// passed through as unmapped targets, never compared.
//
// Comparison contract (one per mapped nutrient):
//   actual complete, target T, actual A:
//     A < T  -> below_target  remaining = T - A   over_target_by = 0
//     A = T  -> at_target     remaining = 0       over_target_by = 0
//     A > T  -> above_target  remaining = 0       over_target_by = A - T
//   actual partial (A is a lower bound):
//     A < T  -> undetermined  remaining = null, remaining_at_most = T - A
//     A = T  -> at_or_above_target  remaining = 0, over_target_by = null
//     A > T  -> above_target  remaining = 0, over_target_by = null,
//                             over_target_by_at_least = A - T
//   actual unavailable -> actual_unavailable (all derived values null)
// `remaining` is never negative and never presented as exact from partial
// data. Exact rational arithmetic; rounded once at output.

import { add, isZero, roundHalfUp, fromNumber, type Rational } from '../conversion/decimal';
import { roundValue, NUTRITION_DECIMAL_PLACES, type AggregateNutrient, type NutrientDefinition } from '../nutrition/nutrition.engine';
import { convertNutrientAmount } from '../nutrition/nutrientUnits';
import type { ResolvedField, UnresolvedTargetField } from '../effectiveTarget/effectiveTarget.schemas';

export type ComparisonStatus = 'below_target' | 'at_target' | 'above_target' | 'at_or_above_target' | 'undetermined' | 'actual_unavailable';

export interface MappedTarget {
  field_name: string;
  nutrient: NutrientDefinition;
  /** In the nutrient's reporting unit. */
  value: Rational;
  resolved: ResolvedField;
}

export type UnmappedReason = UnresolvedTargetField['reason'];

export interface UnmappedTarget {
  field_name: string;
  value: number | null;
  unit: string | null;
  source: ResolvedField['source'];
  reason: UnmappedReason;
}

function negate(r: Rational): Rational {
  return { n: -r.n, d: r.d };
}

function compare(a: Rational, b: Rational): number {
  const left = a.n * b.d;
  const right = b.n * a.d;
  return left < right ? -1 : left > right ? 1 : 0;
}

function subtract(a: Rational, b: Rational): Rational {
  return add(a, negate(b));
}

/** Maps the resolver's canonical target keys onto nutrients. */
export function mapTargets(
  resolved: Record<string, ResolvedField>,
  unresolved: readonly UnresolvedTargetField[],
  vocabulary: readonly NutrientDefinition[],
): { mapped: MappedTarget[]; unmapped: UnmappedTarget[] } {
  const byKey = new Map(vocabulary.map((n) => [n.canonical_key, n]));
  const mapped: MappedTarget[] = [];
  const unmapped: UnmappedTarget[] = unresolved.map((u) => ({ field_name: u.field_name, value: null, unit: null, source: u.source, reason: u.reason }));

  for (const [field_name, field] of Object.entries(resolved).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const nutrient = byKey.get(field_name);
    const converted = nutrient && Number.isFinite(field.value) && field.value > 0 ? convertNutrientAmount(fromNumber(field.value), field.unit, nutrient.unit) : null;
    if (!nutrient || converted === null) {
      unmapped.push({ field_name, value: field.value, unit: field.unit, source: field.source, reason: nutrient ? 'incompatible_unit' : 'unknown_target_key' });
      continue;
    }
    mapped.push({ field_name, nutrient, value: converted, resolved: field });
  }
  return { mapped, unmapped };
}

const num = (r: Rational | null) => (r === null ? null : Number(roundHalfUp(r, NUTRITION_DECIMAL_PLACES)));

/** Compares one nutrient's actual aggregate with its target. */
export function compareToTarget(actual: AggregateNutrient | undefined, target: MappedTarget) {
  const base = {
    nutrient_key: target.nutrient.canonical_key,
    nutrient_role: target.nutrient.role ?? 'other',
    unit: target.nutrient.unit,
    actual: actual && actual.value !== null ? { ...roundValue(actual.value), coverage: actual.coverage } : { value: null, is_zero: false, below_output_precision: false, coverage: 'unavailable' as const },
    target: {
      value: num(target.value),
      field_name: target.field_name,
      source: target.resolved.source,
      source_reference: target.resolved.source_reference,
      original_value: target.resolved.value,
      original_unit: target.resolved.unit,
    },
  };
  const none = { remaining: null, remaining_at_most: null, over_target_by: null, over_target_by_at_least: null };

  if (!actual || actual.value === null || actual.coverage === 'unavailable') {
    return { ...base, comparison_status: 'actual_unavailable' as ComparisonStatus, ...none };
  }
  const order = compare(actual.value, target.value);
  if (actual.coverage === 'complete') {
    if (order < 0) return { ...base, comparison_status: 'below_target' as ComparisonStatus, ...none, remaining: num(subtract(target.value, actual.value)), over_target_by: 0 };
    if (order === 0) return { ...base, comparison_status: 'at_target' as ComparisonStatus, ...none, remaining: 0, over_target_by: 0 };
    return { ...base, comparison_status: 'above_target' as ComparisonStatus, ...none, remaining: 0, over_target_by: num(subtract(actual.value, target.value)) };
  }
  // partial: actual.value is a lower bound
  if (order < 0) return { ...base, comparison_status: 'undetermined' as ComparisonStatus, ...none, remaining_at_most: num(subtract(target.value, actual.value)) };
  if (order === 0) return { ...base, comparison_status: 'at_or_above_target' as ComparisonStatus, ...none, remaining: 0 };
  const over = subtract(actual.value, target.value);
  return { ...base, comparison_status: 'above_target' as ComparisonStatus, ...none, remaining: 0, over_target_by_at_least: isZero(over) ? 0 : num(over) };
}
