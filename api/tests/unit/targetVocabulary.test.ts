// Layer 7C unit tests — canonical nutrition target vocabulary.
import { describe, expect, it } from 'vitest';
import { CANONICAL_NUTRIENTS } from '../../src/domain/nutrition/vocabulary';
import { AppError } from '../../src/lib/errors';
import {
  canonicalTargetOrThrow,
  historyFieldNames,
  normalizeTarget,
  TARGET_ALIASES,
  TARGET_KEYS,
} from '../../src/domain/nutritionTargets/targetVocabulary';

const ok = (field: string, value: number, unit: string) => {
  const n = normalizeTarget(field, value, unit);
  if (!n.ok) throw new Error(`${field}: ${n.reason}`);
  return { key: n.key, value: n.value, unit: n.unit, normalized_from: n.normalized_from };
};
const reason = (field: string, value: number, unit: string) => {
  const n = normalizeTarget(field, value, unit);
  return n.ok ? 'ok' : n.reason;
};

describe('canonical target keys', () => {
  it('are exactly the Layer 5C canonical nutrient keys, each with its reporting unit', () => {
    expect(TARGET_KEYS).toEqual(CANONICAL_NUTRIENTS.map((n) => n.key));
    for (const n of CANONICAL_NUTRIENTS) expect(ok(n.key, 1, n.unit)).toEqual({ key: n.key, value: 1, unit: n.unit, normalized_from: null });
  });

  it('A/B/C: energy is the one energy identity; calories, calorie and energy_kcal are aliases of it', () => {
    expect(ok('energy', 1500, 'kcal')).toMatchObject({ key: 'energy', unit: 'kcal', normalized_from: null });
    for (const alias of ['calories', 'calorie', 'energy_kcal']) expect(ok(alias, 1500, 'kcal')).toEqual({ key: 'energy', value: 1500, unit: 'kcal', normalized_from: alias });
  });

  it('D + macros: carbs/carbohydrates and the *_g aliases map to canonical keys', () => {
    expect(ok('carbs', 250, 'g').key).toBe('carbohydrate');
    expect(ok('carbohydrates', 250, 'g').key).toBe('carbohydrate');
    expect(ok('carbohydrate_g', 250, 'g').key).toBe('carbohydrate');
    expect(ok('protein_g', 110, 'g').key).toBe('protein');
    expect(ok('fat_g', 70, 'g').key).toBe('fat');
    expect(ok('fiber_g', 30, 'g').key).toBe('fiber');
  });

  it('H: micronutrients use Layer 5C identities and convert exactly within g/mg/mcg', () => {
    expect(ok('iron', 8000, 'mcg')).toMatchObject({ key: 'iron', value: 8, unit: 'mg' });
    expect(ok('iron_mg', 18, 'mg')).toMatchObject({ key: 'iron', value: 18 });
    expect(ok('vitamin_d', 0.015, 'mg')).toMatchObject({ key: 'vitamin_d', value: 15, unit: 'mcg' });
    expect(ok('vitamin_b12', 2.4, 'µg')).toMatchObject({ key: 'vitamin_b12', value: 2.4, unit: 'mcg' });
    expect(ok('sodium', 1.5, 'g')).toMatchObject({ key: 'sodium', value: 1500, unit: 'mg' });
  });

  it('F/G/I: incompatible units are rejected, never converted', () => {
    expect(reason('protein', 100, 'kcal')).toBe('incompatible_unit');
    expect(reason('energy', 8000, 'kJ')).toBe('incompatible_unit');
    expect(reason('energy', 2000, 'g')).toBe('incompatible_unit');
    expect(reason('vitamin_d', 600, 'IU')).toBe('incompatible_unit');
    expect(reason('calories', 2000, 'g')).toBe('incompatible_unit'); // the alias names kcal
    expect(reason('protein_g', 110000, 'mg')).toBe('incompatible_unit'); // the alias names g
  });

  it('J: unknown keys are rejected — no fuzzy matching', () => {
    for (const name of ['phosphorus', 'protein_target', 'Calories', 'calorie_kcal', 'kcal', 'fibre', 'carb', 'energy_kj', 'resolver_calories']) {
      expect(reason(name, 1, 'g')).toBe('unknown_target_key');
    }
  });

  it('rejects non-positive and non-finite values', () => {
    for (const v of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(reason('protein', v, 'g')).toBe('invalid_value');
  });

  it('the alias set is exactly the documented one and never shadows a canonical key', () => {
    const generated = CANONICAL_NUTRIENTS.map((n) => `${n.key}_${n.unit}`);
    expect(Object.keys(TARGET_ALIASES).sort()).toEqual([...generated, 'calories', 'calorie', 'carbs', 'carbohydrates'].sort());
    for (const alias of Object.keys(TARGET_ALIASES)) expect(TARGET_KEYS).not.toContain(alias);
  });

  it('write paths get canonical triples or a 400 naming the field', () => {
    expect(canonicalTargetOrThrow({ field_name: 'calories', value: 1500, unit: 'kcal' })).toEqual({ field_name: 'energy', value: 1500, unit: 'kcal' });
    try {
      canonicalTargetOrThrow({ field_name: 'protein', value: 100, unit: 'kcal' });
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).details).toMatchObject({ issues: [{ path: 'unit' }] });
    }
  });

  it('history filters cover every stored name of a key', () => {
    expect(historyFieldNames('calories')).toEqual(['calorie', 'calories', 'energy', 'energy_kcal']);
    expect(historyFieldNames('legacy_free_form')).toEqual(['legacy_free_form']);
  });
});
