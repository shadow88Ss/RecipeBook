// Layer 5B — nutrient-unit normalization for aggregation.
//
// `Nutrient.unit` is the canonical reporting unit of each nutrient, and a
// FoodNutrient amount is always expressed in its Nutrient's unit (FoodNutrient
// has no unit column of its own), so every value of one nutrient already
// shares one unit. Aggregation still normalizes every contribution to the
// nutrient's canonical unit through this module rather than assuming it, so
// mg is never added to µg even if a future value arrives in another unit.
//
// Only genuinely compatible units convert:
//   mass family:   g, mg, mcg (µg / μg / ug are spellings of mcg) — exact SI
//   energy:        kcal and kJ are NOT converted into each other. Several
//                  kcal<->kJ factors are in use (4.184 thermochemical,
//                  4.1868 International Table) and no approved nutrition
//                  specification fixes one, so energy values in different
//                  units stay separate rather than being guessed.
//   anything else (e.g. IU, whose mass equivalent differs per vitamin):
//                  compatible only with the identical unit.

import { div, mul, parseDecimal, type Rational } from '../conversion/decimal';

const MASS_FACTORS_IN_G: Record<string, string> = { g: '1', mg: '0.001', mcg: '0.000001' };

const SPELLINGS: Record<string, string> = {
  g: 'g',
  gram: 'g',
  grams: 'g',
  mg: 'mg',
  milligram: 'mg',
  milligrams: 'mg',
  mcg: 'mcg',
  'µg': 'mcg',
  'μg': 'mcg',
  ug: 'mcg',
  microgram: 'mcg',
  micrograms: 'mcg',
  kcal: 'kcal',
  kj: 'kJ',
};

/** Canonical spelling ("µg" -> "mcg", "KJ" -> "kJ"); an unrecognized unit is
 * returned trimmed but otherwise unchanged. */
export function normalizeNutrientUnit(unit: string): string {
  const trimmed = unit.normalize('NFKC').trim();
  // NFKC folds U+00B5 MICRO SIGN to U+03BC GREEK SMALL MU.
  return SPELLINGS[trimmed.toLowerCase()] ?? trimmed;
}

/**
 * Converts `value` from one nutrient unit to another. Returns null when the
 * units are not compatible — the caller must then treat the value as not
 * aggregatable, never add it anyway.
 */
export function convertNutrientAmount(value: Rational, fromUnit: string, toUnit: string): Rational | null {
  const from = normalizeNutrientUnit(fromUnit);
  const to = normalizeNutrientUnit(toUnit);
  if (from === to) return value;
  const fromFactor = MASS_FACTORS_IN_G[from];
  const toFactor = MASS_FACTORS_IN_G[to];
  if (fromFactor === undefined || toFactor === undefined) return null;
  return div(mul(value, parseDecimal(fromFactor)), parseDecimal(toFactor));
}
