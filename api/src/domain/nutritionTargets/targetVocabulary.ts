// Layer 7C — the canonical nutrition target vocabulary.
//
// A target key IS a canonical nutrient key (Layer 5C, vocabulary.ts) and a
// target is stored in that nutrient's reporting unit: energy -> kcal,
// protein/carbohydrate/fat/fiber -> g, micronutrients -> mg or mcg. There is
// no separate target identity for "calories", "energy_kcal", "protein_g",
// "carbs", ... — those are INPUT ALIASES only, mapped deterministically
// (exact string match, never fuzzy) to the canonical key before storage.
//
// Accepted aliases:
//   explicit:  calories, calorie -> energy (kcal);
//              carbs, carbohydrates -> carbohydrate
//   generated: <canonical_key>_<canonical_unit> for every canonical
//              nutrient (energy_kcal, protein_g, carbohydrate_g, fat_g,
//              fiber_g, iron_mg, vitamin_d_mcg, ...)
// An alias that names a unit ("calories", "*_g", "*_mg", ...) requires
// exactly that unit.
//
// Units: the submitted unit must convert exactly to the key's reporting
// unit — within g/mg/mcg only (e.g. 8000 mcg iron -> 8 mg). kcal <-> kJ, IU
// and any mass <-> energy pairing are never converted (Layer 5B/5C).
//
// The same mapping must exist in the database (target_field_alias, seeded
// by 20261003120000_canonical_target_vocabulary.sql); a test keeps the two
// identical.

import { AppError } from '../../lib/errors';
import { fromNumber, toDecimalString, type Rational } from '../conversion/decimal';
import { convertNutrientAmount, normalizeNutrientUnit } from '../nutrition/nutrientUnits';
import { CANONICAL_NUTRIENT_BY_KEY, CANONICAL_NUTRIENTS, type CanonicalNutrient } from '../nutrition/vocabulary';

export interface TargetAlias {
  key: string;
  /** The unit the alias itself names, if any; the submitted unit must match. */
  unit: string | null;
}

const EXPLICIT_ALIASES: Record<string, TargetAlias> = {
  calories: { key: 'energy', unit: 'kcal' },
  calorie: { key: 'energy', unit: 'kcal' },
  carbs: { key: 'carbohydrate', unit: null },
  carbohydrates: { key: 'carbohydrate', unit: null },
};

export const TARGET_ALIASES: Readonly<Record<string, TargetAlias>> = Object.freeze({
  ...Object.fromEntries(CANONICAL_NUTRIENTS.map((n) => [`${n.key}_${n.unit}`, { key: n.key, unit: n.unit }])),
  ...EXPLICIT_ALIASES,
});

export const TARGET_KEYS: readonly string[] = CANONICAL_NUTRIENTS.map((n) => n.key);

export type TargetRejection = 'unknown_target_key' | 'incompatible_unit' | 'invalid_value';

export type NormalizedTarget =
  | {
      ok: true;
      key: string;
      nutrient: CanonicalNutrient;
      unit: CanonicalNutrient['unit'];
      /** Exact value in the canonical unit. */
      exact: Rational;
      /** The same value as a JS number (exact: g/mg/mcg factors are powers of ten). */
      value: number;
      /** The alias that was submitted, or null for a canonical key. */
      normalized_from: string | null;
    }
  | { ok: false; reason: TargetRejection; message: string };

export function resolveTargetKey(fieldName: string): { key: string; alias: TargetAlias | null } | null {
  if (CANONICAL_NUTRIENT_BY_KEY.has(fieldName)) return { key: fieldName, alias: null };
  const alias = TARGET_ALIASES[fieldName];
  return alias ? { key: alias.key, alias } : null;
}

/** Canonicalizes a (field_name, value, unit) triple, or says exactly why not. */
export function normalizeTarget(fieldName: string, value: number, unit: string): NormalizedTarget {
  const resolved = resolveTargetKey(fieldName);
  const nutrient = resolved ? CANONICAL_NUTRIENT_BY_KEY.get(resolved.key) : undefined;
  if (!resolved || !nutrient) {
    return { ok: false, reason: 'unknown_target_key', message: `"${fieldName}" is not a canonical target key or accepted alias.` };
  }
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, reason: 'invalid_value', message: 'value must be a finite number greater than 0.' };
  }
  const submitted = normalizeNutrientUnit(unit);
  if (resolved.alias?.unit && submitted !== resolved.alias.unit) {
    return { ok: false, reason: 'incompatible_unit', message: `"${fieldName}" is expressed in ${resolved.alias.unit}.` };
  }
  const exact = convertNutrientAmount(fromNumber(value), submitted, nutrient.unit);
  if (exact === null) {
    return { ok: false, reason: 'incompatible_unit', message: `${nutrient.key} targets are in ${nutrient.unit}; "${unit}" cannot be converted to it.` };
  }
  return {
    ok: true,
    key: nutrient.key,
    nutrient,
    unit: nutrient.unit,
    exact,
    value: Number(toDecimalString(exact)),
    normalized_from: resolved.alias ? fieldName : null,
  };
}

/** Every stored field_name that denotes this canonical key (the key itself
 * and its aliases) — for reading history that predates Layer 7C. */
export function storedNamesFor(key: string): string[] {
  return [key, ...Object.entries(TARGET_ALIASES).filter(([, a]) => a.key === key).map(([alias]) => alias)].sort();
}

/** For write paths: the canonical (field_name, value, unit) to store, or a
 * 400 naming the offending field. */
export function canonicalTargetOrThrow(input: { field_name: string; value: number; unit: string }): { field_name: string; value: number; unit: string } {
  const normalized = normalizeTarget(input.field_name, input.value, input.unit);
  if (!normalized.ok) {
    const path = normalized.reason === 'unknown_target_key' ? 'field_name' : normalized.reason === 'incompatible_unit' ? 'unit' : 'value';
    throw AppError.validation('Invalid nutrition target.', { issues: [{ path, message: normalized.message }] });
  }
  return { field_name: normalized.key, value: normalized.value, unit: normalized.unit };
}

/** History filter: a canonical key or alias selects every stored name of
 * that key (legacy rows included); any other well-formed name is matched
 * exactly (e.g. a pre-7C free-form row). */
export function historyFieldNames(fieldName: string): string[] {
  const resolved = resolveTargetKey(fieldName);
  return resolved ? storedNamesFor(resolved.key) : [fieldName];
}
