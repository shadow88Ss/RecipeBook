// Layer 5A — the deterministic conversion engine (Master §5, §13.3, §32).
//
// Pure functions only: no I/O, no clock, no randomness, no AI. The same
// input always yields byte-identical output. Food-specific reference data
// (servings, density) is loaded by the caller (food.service.ts) under the
// caller's own RLS-scoped token and passed in.
//
// Conversion path, always in this order:
//   1. source -> canonical base quantity (g or ml)
//        unit:    quantity x unit factor
//        serving: quantity x serving.canonical_quantity (in its canonical_unit)
//   2. if source and target dimensions differ (mass <-> volume):
//        only via the food's stored density_g_per_ml; never assumed
//   3. canonical base quantity -> target
//        unit:    / unit factor
//        serving: / serving.canonical_quantity
//   4. round once, at the end (6 decimal places, ROUND_HALF_UP)
//
// A conversion that cannot be performed without guessing is never
// approximated — it returns `status: 'unresolved'` with a stable reason.

import { div, fromNumber, isZero, mul, roundHalfUp, toDecimalString, type Rational } from './decimal';
import { BASE_UNIT, resolveUnit, unitFactor, type BaseUnit, type Dimension, type UnitDefinition } from './units';

export const CONVERSION_VERSION = 'conversion-5a.1';
export const RESULT_DECIMAL_PLACES = 6;
export const ROUNDING_MODE = 'half_up';

export type ReferenceSource = 'trusted_database' | 'manufacturer_label' | 'user_entered' | 'ai_matched';

export interface ServingReference {
  id: string;
  serving_description: string;
  region: string | null;
  canonical_quantity: number;
  canonical_unit: string;
  source: ReferenceSource;
}

export interface FoodConversionData {
  food_id: string;
  density: { g_per_ml: number; source: ReferenceSource } | null;
  servings: ServingReference[];
}

export type ConversionEndpoint = { unit: string; serving_id?: undefined } | { serving_id: string; unit?: undefined };

export type UnresolvedReason =
  | 'unknown_unit'
  | 'ambiguous_unit'
  | 'incompatible_dimensions'
  | 'density_unavailable'
  | 'serving_not_found'
  | 'invalid_reference_data'
  | 'result_rounds_to_zero';

export interface ConversionStep {
  operation: 'unit_to_base' | 'serving_to_base' | 'density' | 'base_to_unit' | 'base_to_serving';
  from_unit: string;
  to_unit: string;
  /** Exact decimal factor applied at this step (multiply, or divide for
   * base_to_* and density volume<-mass steps — see `applied_as`). */
  factor: string;
  applied_as: 'multiply' | 'divide';
  reference_id?: string;
}

export interface ProvenanceEntry {
  kind: 'unit_definition' | 'food_serving' | 'food_density';
  reference: string;
  source: ReferenceSource | 'unit_registry';
}

export interface ConvertedResult {
  status: 'converted';
  quantity: number;
  unit: string;
  serving_id: string | null;
  precision: { decimal_places: number; rounding: typeof ROUNDING_MODE };
  steps: ConversionStep[];
  provenance: ProvenanceEntry[];
  /** True when any reference value used is `ai_matched` — an unvalidated
   * match may not silently become authoritative (Master §16). */
  confirmation_required: boolean;
  /** False whenever confirmation_required is true: a result derived from an
   * AI-generated serving weight or density is never authoritative, and a
   * nutrition calculation must not treat it as such (Layer 5A final
   * alignment, item 8). */
  authoritative: boolean;
  conversion_version: string;
}

export interface UnresolvedResult {
  status: 'unresolved';
  reason: UnresolvedReason;
  message: string;
  /** Present for `ambiguous_unit`: the explicit unit codes to choose from. */
  candidates?: string[];
  conversion_version: string;
}

export type ConversionResult = ConvertedResult | UnresolvedResult;

function unresolved(reason: UnresolvedReason, message: string, candidates?: string[]): UnresolvedResult {
  return candidates
    ? { status: 'unresolved', reason, message, candidates, conversion_version: CONVERSION_VERSION }
    : { status: 'unresolved', reason, message, conversion_version: CONVERSION_VERSION };
}

const DIMENSION_OF_BASE: Record<BaseUnit, Dimension> = { g: 'mass', ml: 'volume' };

function isBaseUnit(unit: string): unit is BaseUnit {
  return unit === 'g' || unit === 'ml';
}

interface ResolvedEndpoint {
  base: BaseUnit;
  /** Base units per one of this endpoint. */
  factor: Rational;
  unit: string;
  serving_id: string | null;
  provenance: ProvenanceEntry;
  confirmation_required: boolean;
}

function resolveEndpoint(endpoint: ConversionEndpoint, food: FoodConversionData | null): ResolvedEndpoint | UnresolvedResult {
  if (endpoint.serving_id !== undefined) {
    const serving = food?.servings.find((s) => s.id === endpoint.serving_id);
    if (!serving) {
      return unresolved('serving_not_found', 'The serving does not exist for this food.');
    }
    if (!isBaseUnit(serving.canonical_unit) || !(serving.canonical_quantity > 0)) {
      return unresolved('invalid_reference_data', 'The serving has no usable canonical quantity.');
    }
    return {
      base: serving.canonical_unit,
      factor: fromNumber(serving.canonical_quantity),
      unit: 'serving',
      serving_id: serving.id,
      provenance: { kind: 'food_serving', reference: serving.id, source: serving.source },
      confirmation_required: serving.source === 'ai_matched',
    };
  }

  const resolution = resolveUnit(endpoint.unit);
  if (!resolution.ok) {
    return resolution.reason === 'ambiguous_unit'
      ? unresolved(
          'ambiguous_unit',
          `"${endpoint.unit}" differs between measurement systems; specify one of the candidate units.`,
          resolution.candidates,
        )
      : unresolved('unknown_unit', `"${endpoint.unit}" is not a supported unit.`);
  }
  const unit: UnitDefinition = resolution.unit;
  return {
    base: BASE_UNIT[unit.dimension],
    factor: unitFactor(unit.code),
    unit: unit.code,
    serving_id: null,
    provenance: { kind: 'unit_definition', reference: unit.code, source: 'unit_registry' },
    confirmation_required: false,
  };
}

export interface ConversionRequest {
  quantity: number;
  from: ConversionEndpoint;
  to: ConversionEndpoint;
}

/**
 * Converts `quantity` of `from` into `to`. `food` is required for serving
 * endpoints and for any mass <-> volume conversion; pass null for a
 * food-independent unit conversion.
 */
export function convert(request: ConversionRequest, food: FoodConversionData | null): ConversionResult {
  const from = resolveEndpoint(request.from, food);
  if ('status' in from) return from;
  const to = resolveEndpoint(request.to, food);
  if ('status' in to) return to;

  const steps: ConversionStep[] = [];
  const provenance: ProvenanceEntry[] = [from.provenance];
  if (to.provenance.reference !== from.provenance.reference || to.provenance.kind !== from.provenance.kind) {
    provenance.push(to.provenance);
  }
  let confirmationRequired = from.confirmation_required || to.confirmation_required;

  // 1. source -> base
  let value = mul(fromNumber(request.quantity), from.factor);
  steps.push({
    operation: from.serving_id ? 'serving_to_base' : 'unit_to_base',
    from_unit: from.unit,
    to_unit: from.base,
    factor: toDecimalString(from.factor),
    applied_as: 'multiply',
    ...(from.serving_id ? { reference_id: from.serving_id } : {}),
  });

  // 2. mass <-> volume, only through stored density
  if (from.base !== to.base) {
    if (!food) {
      return unresolved(
        'incompatible_dimensions',
        `Cannot convert ${DIMENSION_OF_BASE[from.base]} to ${DIMENSION_OF_BASE[to.base]} without a food's density.`,
      );
    }
    if (!food.density || !(food.density.g_per_ml > 0)) {
      return unresolved(
        'density_unavailable',
        `This food has no stored density, so ${DIMENSION_OF_BASE[from.base]} cannot be converted to ${DIMENSION_OF_BASE[to.base]}.`,
      );
    }
    const density = fromNumber(food.density.g_per_ml);
    // ml -> g multiplies by g/ml; g -> ml divides by it.
    const appliedAs = from.base === 'ml' ? 'multiply' : 'divide';
    value = appliedAs === 'multiply' ? mul(value, density) : div(value, density);
    steps.push({
      operation: 'density',
      from_unit: from.base,
      to_unit: to.base,
      factor: toDecimalString(density),
      applied_as: appliedAs,
      reference_id: food.food_id,
    });
    provenance.push({ kind: 'food_density', reference: food.food_id, source: food.density.source });
    confirmationRequired ||= food.density.source === 'ai_matched';
  }

  // 3. base -> target
  value = div(value, to.factor);
  steps.push({
    operation: to.serving_id ? 'base_to_serving' : 'base_to_unit',
    from_unit: to.base,
    to_unit: to.unit,
    factor: toDecimalString(to.factor),
    applied_as: 'divide',
    ...(to.serving_id ? { reference_id: to.serving_id } : {}),
  });

  // 4. round once
  const rounded = roundHalfUp(value, RESULT_DECIMAL_PLACES);
  if (!isZero(value) && Number(rounded) === 0) {
    return unresolved(
      'result_rounds_to_zero',
      `The result is smaller than ${RESULT_DECIMAL_PLACES} decimal places of ${to.unit}; choose a smaller target unit.`,
    );
  }

  return {
    status: 'converted',
    quantity: Number(rounded),
    unit: to.unit,
    serving_id: to.serving_id,
    precision: { decimal_places: RESULT_DECIMAL_PLACES, rounding: ROUNDING_MODE },
    steps,
    provenance,
    confirmation_required: confirmationRequired,
    authoritative: !confirmationRequired,
    conversion_version: CONVERSION_VERSION,
  };
}
