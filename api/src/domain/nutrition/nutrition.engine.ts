// Layer 5B — the single deterministic nutrition-calculation engine (Master §5).
//
// Pure functions: no I/O, no clock, no randomness, no AI. Reference data is
// loaded by nutrition.service.ts under the caller's own RLS-scoped token and
// passed in. Every later feature (food logging, recipes, daily tracker, meal
// planning, analytics, coach) must call this engine rather than doing its
// own nutrition arithmetic.
//
// Pipeline, per item:
//   input amount (canonical unit code or FoodServing reference)
//   -> normalize quantity             (Layer 5A convertExact, no rounding)
//   -> per nutrient: resolve the one authoritative FoodNutrient record
//                    (sourceResolution.ts)
//   -> read that record's explicit basis (basis_quantity basis_unit)
//   -> convert the input into basis_unit (Layer 5A; mass<->volume only via
//      stored density)
//   -> scale: amount x (quantity in basis_unit / basis_quantity)
// then across items:
//   -> aggregate resolved values only, in the nutrient's canonical unit
//   -> round once, at the output boundary (toNutritionResultDto)
//
// Nothing is ever estimated. A nutrient with no authoritative value is
// reported with a status explaining why and a null value — never 0. There
// is no energy formula: energy is whatever authoritative energy nutrient is
// stored, like any other nutrient, or unavailable.

import { add, div, fromNumber, isZero, mul, roundHalfUp, ZERO, type Rational } from '../conversion/decimal';
import {
  convertExact,
  type ConversionEndpoint,
  type ConversionStep,
  type ExactConversion,
  type FoodConversionData,
  type ProvenanceEntry,
  type UnresolvedReason,
  type UnresolvedResult,
} from '../conversion/conversion.engine';
import { BASE_UNIT, resolveUnit } from '../conversion/units';
import { convertNutrientAmount } from './nutrientUnits';
import { resolveNutrientSource, type ExcludedRecord, type FoodNutrientRecord } from './sourceResolution';

export const NUTRITION_CALCULATION_VERSION = 'nutrition-calculation-5b.1';
export const NUTRITION_DECIMAL_PLACES = 6;

export interface NutrientDefinition {
  id: string;
  canonical_key: string;
  unit: string;
}

export interface FoodNutritionData extends FoodConversionData {
  canonical_name: string;
  nutrients: FoodNutrientRecord[];
}

export interface CalculationItemInput {
  food: FoodNutritionData;
  quantity: number;
  amount: ConversionEndpoint;
}

export type NutrientStatus =
  /** An authoritative value was found and scaled. May be exactly zero. */
  | 'resolved'
  /** No FoodNutrient record exists for this food and nutrient. */
  | 'no_data'
  /** Only ai_matched / user_entered records exist. */
  | 'not_authoritative'
  /** More than one authoritative source; the schema cannot choose safely. */
  | 'ambiguous_nutrient_source'
  /** The input cannot be expressed in the record's basis unit (e.g. volume
   * input, per-100 g basis, no stored density). */
  | 'basis_unreconcilable'
  /** The only path to the basis unit uses an ai_matched serving weight or
   * density. */
  | 'non_authoritative_quantity'
  /** The item quantity itself could not be normalized. */
  | 'quantity_unresolved';

export interface SelectedSource {
  food_nutrient_id: string;
  source: FoodNutrientRecord['source'];
  amount_per_basis: number;
  basis_quantity: number;
  basis_unit: string;
  quantity_in_basis_unit: Rational;
}

export interface ItemNutrient {
  nutrient: NutrientDefinition;
  status: NutrientStatus;
  /** In `unit`; present only when status is 'resolved'. */
  value: Rational | null;
  unit: string;
  selected: SelectedSource | null;
  candidates: Array<{ food_nutrient_id: string; source: FoodNutrientRecord['source'] }>;
  excluded: ExcludedRecord[];
  conversion_reason: UnresolvedReason | null;
}

export interface ItemCalculation {
  index: number;
  food_id: string;
  canonical_name: string;
  input: { quantity: number; unit: string | null; serving_id: string | null };
  normalized:
    | { status: 'converted'; value: Rational; unit: string; steps: ConversionStep[]; provenance: ProvenanceEntry[]; authoritative: boolean }
    | { status: 'unresolved'; reason: UnresolvedReason; message: string };
  nutrients: ItemNutrient[];
}

export type Coverage = 'complete' | 'partial' | 'unavailable';

export interface AggregateContribution {
  nutrient_id: string;
  status: NutrientStatus;
  value: Rational | null;
  unit: string;
}

export interface AggregateNutrient {
  nutrient: NutrientDefinition;
  /** Sum of resolved contributions, in the nutrient's canonical unit; null
   * when coverage is 'unavailable'. A 'partial' value is a lower bound, not
   * a total. */
  value: Rational | null;
  coverage: Coverage;
  resolved_item_count: number;
  item_count: number;
  /** Items whose value is not included, with why. */
  missing: Array<{ index: number; status: NutrientStatus | 'incompatible_unit' }>;
}

function baseUnitOf(amount: ConversionEndpoint, food: FoodConversionData): string | null {
  if (amount.serving_id !== undefined) {
    return food.servings.find((s) => s.id === amount.serving_id)?.canonical_unit ?? null;
  }
  const resolution = resolveUnit(amount.unit);
  return resolution.ok ? BASE_UNIT[resolution.unit.dimension] : null;
}

export function calculateItem(index: number, item: CalculationItemInput, vocabulary: readonly NutrientDefinition[]): ItemCalculation {
  const { food, quantity, amount } = item;
  const input = { quantity, unit: amount.unit ?? null, serving_id: amount.serving_id ?? null };

  const conversions = new Map<string, ExactConversion | UnresolvedResult>();
  const toUnit = (unit: string): ExactConversion | UnresolvedResult => {
    let result = conversions.get(unit);
    if (!result) {
      result = convertExact({ quantity, from: amount, to: { unit } }, food);
      conversions.set(unit, result);
    }
    return result;
  };

  const base = baseUnitOf(amount, food);
  const normalizedResult = base
    ? toUnit(base)
    : convertExact({ quantity, from: amount, to: { unit: 'g' } }, food);
  const normalized: ItemCalculation['normalized'] =
    normalizedResult.status === 'converted'
      ? {
          status: 'converted',
          value: normalizedResult.value,
          unit: normalizedResult.unit,
          steps: normalizedResult.steps,
          provenance: normalizedResult.provenance,
          authoritative: normalizedResult.authoritative,
        }
      : { status: 'unresolved', reason: normalizedResult.reason, message: normalizedResult.message };

  const recordsByNutrient = new Map<string, FoodNutrientRecord[]>();
  for (const record of food.nutrients) {
    const list = recordsByNutrient.get(record.nutrient_id) ?? [];
    list.push(record);
    recordsByNutrient.set(record.nutrient_id, list);
  }

  const nutrients = vocabulary.map((nutrient): ItemNutrient => {
    const empty: ItemNutrient = {
      nutrient,
      status: 'no_data',
      value: null,
      unit: nutrient.unit,
      selected: null,
      candidates: [],
      excluded: [],
      conversion_reason: null,
    };
    const resolution = resolveNutrientSource(recordsByNutrient.get(nutrient.id) ?? []);
    if (resolution.status === 'no_data') return empty;
    if (resolution.status === 'not_authoritative') return { ...empty, status: 'not_authoritative', excluded: resolution.excluded };
    if (resolution.status === 'ambiguous_nutrient_source') {
      return {
        ...empty,
        status: 'ambiguous_nutrient_source',
        candidates: resolution.candidates.map((c) => ({ food_nutrient_id: c.id, source: c.source })),
        excluded: resolution.excluded,
      };
    }

    const record = resolution.record;
    const withSource = { ...empty, excluded: resolution.excluded, candidates: [{ food_nutrient_id: record.id, source: record.source }] };
    if (normalized.status === 'unresolved') {
      return { ...withSource, status: 'quantity_unresolved', conversion_reason: normalized.reason };
    }
    const inBasisUnit = toUnit(record.basis_unit);
    if (inBasisUnit.status === 'unresolved') {
      return { ...withSource, status: 'basis_unreconcilable', conversion_reason: inBasisUnit.reason };
    }
    if (!inBasisUnit.authoritative) {
      return { ...withSource, status: 'non_authoritative_quantity' };
    }

    // amount (per basis_quantity basis_unit) x quantity_in_basis_unit / basis_quantity
    const value = div(mul(fromNumber(record.amount), inBasisUnit.value), fromNumber(record.basis_quantity));
    return {
      ...withSource,
      status: 'resolved',
      value,
      selected: {
        food_nutrient_id: record.id,
        source: record.source,
        amount_per_basis: record.amount,
        basis_quantity: record.basis_quantity,
        basis_unit: record.basis_unit,
        quantity_in_basis_unit: inBasisUnit.value,
      },
    };
  });

  return { index, food_id: food.food_id, canonical_name: food.canonical_name, input, normalized, nutrients };
}

/**
 * Aggregates per-item contributions for every nutrient in the vocabulary.
 * Only resolved values are summed, each first normalized to the nutrient's
 * canonical unit; a value in an incompatible unit is left out (and listed
 * in `missing`), never added.
 */
export function aggregateNutrients(
  vocabulary: readonly NutrientDefinition[],
  items: ReadonlyArray<{ index: number; nutrients: readonly AggregateContribution[] }>,
): AggregateNutrient[] {
  return vocabulary.map((nutrient) => {
    let total: Rational = ZERO;
    let resolved = 0;
    const missing: AggregateNutrient['missing'] = [];
    for (const item of items) {
      const entry = item.nutrients.find((n) => n.nutrient_id === nutrient.id);
      if (!entry || entry.status !== 'resolved' || entry.value === null) {
        missing.push({ index: item.index, status: entry?.status ?? 'no_data' });
        continue;
      }
      const normalized = convertNutrientAmount(entry.value, entry.unit, nutrient.unit);
      if (normalized === null) {
        missing.push({ index: item.index, status: 'incompatible_unit' });
        continue;
      }
      total = add(total, normalized);
      resolved += 1;
    }
    const coverage: Coverage = resolved === 0 ? 'unavailable' : resolved === items.length ? 'complete' : 'partial';
    return {
      nutrient,
      value: resolved === 0 ? null : total,
      coverage,
      resolved_item_count: resolved,
      item_count: items.length,
      missing,
    };
  });
}

export interface NutritionCalculation {
  items: ItemCalculation[];
  aggregate: AggregateNutrient[];
}

export function calculateNutrition(items: readonly CalculationItemInput[], vocabulary: readonly NutrientDefinition[]): NutritionCalculation {
  const calculated = items.map((item, index) => calculateItem(index, item, vocabulary));
  const aggregate = aggregateNutrients(
    vocabulary,
    calculated.map((item) => ({
      index: item.index,
      nutrients: item.nutrients.map((n) => ({ nutrient_id: n.nutrient.id, status: n.status, value: n.value, unit: n.unit })),
    })),
  );
  return { items: calculated, aggregate };
}

// ---------------------------------------------------------------------------
// Output boundary: the only place values are rounded.

export interface RoundedValue {
  value: number;
  /** True only for an exact zero — a known zero, not an unknown. */
  is_zero: boolean;
  /** True when a non-zero value rounds to 0 at the output precision. */
  below_output_precision: boolean;
}

export function roundValue(value: Rational): RoundedValue {
  const rounded = Number(roundHalfUp(value, NUTRITION_DECIMAL_PLACES));
  return { value: rounded, is_zero: isZero(value), below_output_precision: !isZero(value) && rounded === 0 };
}

export function roundedNumber(value: Rational): number {
  return Number(roundHalfUp(value, NUTRITION_DECIMAL_PLACES));
}
