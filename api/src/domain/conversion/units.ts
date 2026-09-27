// Layer 5A — the deterministic unit registry.
//
// Two dimensions only, each with one canonical base unit — the same two
// units `food_serving.canonical_unit` and `food_nutrient.basis_unit` are
// constrained to (20260927120000_food_conversion_foundation.sql):
//   mass   -> g
//   volume -> ml
// Every factor is an exact, legally defined value (SI; the international
// avoirdupois pound of 1959 = 453.59237 g; US customary volume from the
// US gallon = 231 in³ = 3785.411784 ml; imperial from the imperial gallon =
// 4546.09 ml; US nutrition-labeling "legal" cup = 240 ml, 21 CFR
// 101.9(b)(5)(viii)). No factor is rounded or approximated.
//
// Count-style measures ("1 slice", "1 medium apple", "1 piece") are NOT
// units: they only have meaning for a specific food and are modeled as
// FoodServing rows.
//
// Regionally ambiguous kitchen measures ("cup", "tbsp", "tsp", "fl oz",
// "pint", ...) are deliberately not resolved to a default system — a US cup
// is 236.59 ml, a metric cup 250 ml, and an Australian tablespoon 20 ml, so
// silently picking one would be a guess. They resolve to `ambiguous_unit`
// with the explicit candidates the caller (or a later confirmation step)
// must choose from.

import { parseDecimal, type Rational } from './decimal';

export type Dimension = 'mass' | 'volume';
export type BaseUnit = 'g' | 'ml';

export const BASE_UNIT: Record<Dimension, BaseUnit> = { mass: 'g', volume: 'ml' };

export interface UnitDefinition {
  code: string;
  dimension: Dimension;
  /** Exact decimal: how many base units (g or ml) one of this unit is. */
  factor: string;
  system: 'metric' | 'avoirdupois' | 'us_customary' | 'us_nutrition_labeling' | 'imperial' | 'australian';
  label: string;
}

const DEFINITIONS: UnitDefinition[] = [
  // Mass (base: g)
  { code: 'mcg', dimension: 'mass', factor: '0.000001', system: 'metric', label: 'microgram' },
  { code: 'mg', dimension: 'mass', factor: '0.001', system: 'metric', label: 'milligram' },
  { code: 'g', dimension: 'mass', factor: '1', system: 'metric', label: 'gram' },
  { code: 'kg', dimension: 'mass', factor: '1000', system: 'metric', label: 'kilogram' },
  { code: 'oz', dimension: 'mass', factor: '28.349523125', system: 'avoirdupois', label: 'ounce (avoirdupois)' },
  { code: 'lb', dimension: 'mass', factor: '453.59237', system: 'avoirdupois', label: 'pound (avoirdupois)' },

  // Volume (base: ml)
  { code: 'ml', dimension: 'volume', factor: '1', system: 'metric', label: 'millilitre' },
  { code: 'cl', dimension: 'volume', factor: '10', system: 'metric', label: 'centilitre' },
  { code: 'dl', dimension: 'volume', factor: '100', system: 'metric', label: 'decilitre' },
  { code: 'l', dimension: 'volume', factor: '1000', system: 'metric', label: 'litre' },
  { code: 'tsp_metric', dimension: 'volume', factor: '5', system: 'metric', label: 'metric teaspoon' },
  { code: 'tbsp_metric', dimension: 'volume', factor: '15', system: 'metric', label: 'metric tablespoon' },
  { code: 'cup_metric', dimension: 'volume', factor: '250', system: 'metric', label: 'metric cup' },
  { code: 'tsp_us', dimension: 'volume', factor: '4.92892159375', system: 'us_customary', label: 'US teaspoon' },
  { code: 'tbsp_us', dimension: 'volume', factor: '14.78676478125', system: 'us_customary', label: 'US tablespoon' },
  { code: 'fl_oz_us', dimension: 'volume', factor: '29.5735295625', system: 'us_customary', label: 'US fluid ounce' },
  { code: 'cup_us', dimension: 'volume', factor: '236.5882365', system: 'us_customary', label: 'US customary cup' },
  { code: 'pint_us', dimension: 'volume', factor: '473.176473', system: 'us_customary', label: 'US liquid pint' },
  { code: 'quart_us', dimension: 'volume', factor: '946.352946', system: 'us_customary', label: 'US liquid quart' },
  { code: 'gallon_us', dimension: 'volume', factor: '3785.411784', system: 'us_customary', label: 'US liquid gallon' },
  { code: 'cup_us_legal', dimension: 'volume', factor: '240', system: 'us_nutrition_labeling', label: 'US nutrition-labeling cup' },
  { code: 'fl_oz_imp', dimension: 'volume', factor: '28.4130625', system: 'imperial', label: 'imperial fluid ounce' },
  { code: 'pint_imp', dimension: 'volume', factor: '568.26125', system: 'imperial', label: 'imperial pint' },
  { code: 'quart_imp', dimension: 'volume', factor: '1136.5225', system: 'imperial', label: 'imperial quart' },
  { code: 'gallon_imp', dimension: 'volume', factor: '4546.09', system: 'imperial', label: 'imperial gallon' },
  { code: 'tbsp_au', dimension: 'volume', factor: '20', system: 'australian', label: 'Australian tablespoon' },
];

export const UNITS: ReadonlyMap<string, UnitDefinition> = new Map(DEFINITIONS.map((u) => [u.code, u]));

const FACTORS: ReadonlyMap<string, Rational> = new Map(DEFINITIONS.map((u) => [u.code, parseDecimal(u.factor)]));

export function unitFactor(code: string): Rational {
  const factor = FACTORS.get(code);
  if (!factor) throw new Error(`Unknown unit code: ${code}`);
  return factor;
}

/** Unambiguous spellings that map onto exactly one unit code. */
const SYNONYMS: Record<string, string> = {
  microgram: 'mcg', micrograms: 'mcg', ug: 'mcg', µg: 'mcg', μg: 'mcg',
  milligram: 'mg', milligrams: 'mg',
  gram: 'g', grams: 'g',
  kilogram: 'kg', kilograms: 'kg', kgs: 'kg',
  ounce: 'oz', ounces: 'oz',
  pound: 'lb', pounds: 'lb', lbs: 'lb',
  milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml',
  centiliter: 'cl', centilitre: 'cl',
  deciliter: 'dl', decilitre: 'dl',
  liter: 'l', liters: 'l', litre: 'l', litres: 'l',
};

/** Measures whose size depends on the measurement system in use. */
const AMBIGUOUS: Record<string, string[]> = {
  cup: ['cup_us', 'cup_metric', 'cup_us_legal'],
  tbsp: ['tbsp_us', 'tbsp_metric', 'tbsp_au'],
  tsp: ['tsp_us', 'tsp_metric'],
  fl_oz: ['fl_oz_us', 'fl_oz_imp'],
  pint: ['pint_us', 'pint_imp'],
  quart: ['quart_us', 'quart_imp'],
  gallon: ['gallon_us', 'gallon_imp'],
};
const AMBIGUOUS_SYNONYMS: Record<string, string> = {
  cups: 'cup',
  tablespoon: 'tbsp', tablespoons: 'tbsp', tbs: 'tbsp', tbl: 'tbsp',
  teaspoon: 'tsp', teaspoons: 'tsp',
  fluid_ounce: 'fl_oz', fluid_ounces: 'fl_oz', floz: 'fl_oz',
  pints: 'pint', pt: 'pint',
  quarts: 'quart', qt: 'quart',
  gallons: 'gallon', gal: 'gallon',
};

export type UnitResolution =
  | { ok: true; unit: UnitDefinition }
  | { ok: false; reason: 'unknown_unit' }
  | { ok: false; reason: 'ambiguous_unit'; candidates: string[] };

export function normalizeUnitInput(input: string): string {
  return input.normalize('NFKC').trim().toLowerCase().replace(/\.$/, '').replace(/[\s-]+/g, '_');
}

export function resolveUnit(input: string): UnitResolution {
  const key = normalizeUnitInput(input);
  const code = UNITS.has(key) ? key : SYNONYMS[key];
  if (code) {
    const unit = UNITS.get(code);
    if (unit) return { ok: true, unit };
  }
  const ambiguousKey = AMBIGUOUS[key] ? key : AMBIGUOUS_SYNONYMS[key];
  const candidates = ambiguousKey ? AMBIGUOUS[ambiguousKey] : undefined;
  if (candidates) return { ok: false, reason: 'ambiguous_unit', candidates: [...candidates] };
  return { ok: false, reason: 'unknown_unit' };
}
