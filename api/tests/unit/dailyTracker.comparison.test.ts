// Layer 7B unit tests — target mapping and the actual-vs-target contract.
// TEST FIXTURES ONLY.
import { describe, expect, it } from 'vitest';
import { parseDecimal } from '../../src/domain/conversion/decimal';
import type { AggregateNutrient, NutrientDefinition } from '../../src/domain/nutrition/nutrition.engine';
import type { ResolvedField } from '../../src/domain/effectiveTarget/effectiveTarget.schemas';
import { compareToTarget, mapTargets } from '../../src/domain/dailyTracker/dailyTracker.comparison';

const V: Record<string, NutrientDefinition> = {
  energy: { id: 'n-energy', canonical_key: 'energy', unit: 'kcal', role: 'energy' },
  protein: { id: 'n-protein', canonical_key: 'protein', unit: 'g', role: 'macronutrient' },
  fat: { id: 'n-fat', canonical_key: 'fat', unit: 'g', role: 'macronutrient' },
  carbohydrate: { id: 'n-carb', canonical_key: 'carbohydrate', unit: 'g', role: 'macronutrient' },
  iron: { id: 'n-iron', canonical_key: 'iron', unit: 'mg', role: 'micronutrient' },
  vitamin_d: { id: 'n-vitd', canonical_key: 'vitamin_d', unit: 'mcg', role: 'micronutrient' },
};
const VOCAB = Object.values(V);
const field = (value: number, unit: string, source: ResolvedField['source'] = 'user_target'): ResolvedField => ({
  value,
  unit,
  source,
  source_reference: '00000000-0000-4000-8000-000000000001',
});
const actual = (key: string, value: string | null, coverage: AggregateNutrient['coverage']): AggregateNutrient => ({
  nutrient: V[key] as NutrientDefinition,
  value: value === null ? null : parseDecimal(value),
  coverage,
  resolved_item_count: 1,
  item_count: 1,
  missing: [],
});
const target = (key: string, value: number, unit: string) => {
  const { mapped } = mapTargets({ [key]: field(value, unit) }, VOCAB);
  const t = mapped[0];
  if (!t) throw new Error('not mapped');
  return t;
};

describe('mapTargets: explicit, exact mapping only', () => {
  it('maps canonical keys (with exact g/mg/mcg conversion) and Layer 5C summary fields', () => {
    const { mapped, unmapped } = mapTargets(
      { protein: field(110, 'g'), energy_kcal: field(2000, 'kcal'), iron: field(0.018, 'g'), vitamin_d: field(0.015, 'mg') },
      VOCAB,
    );
    expect(unmapped).toEqual([]);
    const byKey = Object.fromEntries(mapped.map((m) => [m.nutrient.canonical_key, m]));
    expect(byKey.energy?.field_name).toBe('energy_kcal');
    expect(compareToTarget(undefined, byKey.iron as never).target.value).toBe(18); // 0.018 g -> 18 mg
    expect(compareToTarget(undefined, byKey.vitamin_d as never).target.value).toBe(15); // 0.015 mg -> 15 mcg
  });

  it('never guesses: unknown names, incompatible units, alias unit mismatch, duplicates and invalid values are unmapped', () => {
    const { mapped, unmapped } = mapTargets(
      {
        calories: field(2000, 'kcal'), // not an approved key or summary field
        carbohydrate: field(300, 'kcal'), // g <-> kcal never converted
        energy_kcal: field(8000, 'kJ'), // alias bound to kcal
        fat: field(70, 'g'),
        fat_g: field(65, 'g'), // two targets for one nutrient
        iron: field(-1, 'mg'),
      },
      VOCAB,
    );
    expect(mapped).toEqual([]);
    expect(Object.fromEntries(unmapped.map((u) => [u.field_name, u.reason]))).toEqual({
      calories: 'unknown_field',
      carbohydrate: 'incompatible_unit',
      energy_kcal: 'incompatible_unit',
      fat: 'duplicate_target_for_nutrient',
      fat_g: 'duplicate_target_for_nutrient',
      iron: 'invalid_value',
    });
  });
});

describe('compareToTarget contract', () => {
  it('P: complete actual below target -> exact remaining', () => {
    expect(compareToTarget(actual('protein', '91', 'complete'), target('protein', 110, 'g'))).toMatchObject({
      comparison_status: 'below_target',
      actual: { value: 91, coverage: 'complete' },
      target: { value: 110, source: 'user_target' },
      remaining: 19,
      over_target_by: 0,
      remaining_at_most: null,
    });
  });

  it('Q: complete actual exactly at target', () => {
    expect(compareToTarget(actual('protein', '110', 'complete'), target('protein', 110, 'g'))).toMatchObject({ comparison_status: 'at_target', remaining: 0, over_target_by: 0 });
  });

  it('R: complete actual above target -> remaining 0 and over_target_by, never negative', () => {
    const c = compareToTarget(actual('protein', '125.5', 'complete'), target('protein', 110, 'g'));
    expect(c).toMatchObject({ comparison_status: 'above_target', remaining: 0, over_target_by: 15.5 });
  });

  it('T: partial actual below target -> no exact remaining, only an upper bound', () => {
    expect(compareToTarget(actual('protein', '70', 'partial'), target('protein', 110, 'g'))).toMatchObject({
      comparison_status: 'undetermined',
      actual: { value: 70, coverage: 'partial' },
      remaining: null,
      remaining_at_most: 40,
      over_target_by: null,
    });
  });

  it('partial actual at or over target: known to have reached it, exact excess unknown', () => {
    expect(compareToTarget(actual('protein', '110', 'partial'), target('protein', 110, 'g'))).toMatchObject({ comparison_status: 'at_or_above_target', remaining: 0, over_target_by: null });
    expect(compareToTarget(actual('protein', '120', 'partial'), target('protein', 110, 'g'))).toMatchObject({
      comparison_status: 'above_target',
      remaining: 0,
      over_target_by: null,
      over_target_by_at_least: 10,
    });
  });

  it('U: unavailable actual -> actual_unavailable, nothing derived; missing nutrient treated the same', () => {
    for (const a of [actual('iron', null, 'unavailable'), undefined]) {
      expect(compareToTarget(a, target('iron', 18, 'mg'))).toMatchObject({
        comparison_status: 'actual_unavailable',
        actual: { value: null, coverage: 'unavailable' },
        remaining: null,
        remaining_at_most: null,
        over_target_by: null,
      });
    }
  });

  it('known zero actual (e.g. a day with no consumption) compares exactly', () => {
    expect(compareToTarget(actual('iron', '0', 'complete'), target('iron', 18, 'mg'))).toMatchObject({ comparison_status: 'below_target', actual: { value: 0, is_zero: true }, remaining: 18 });
  });

  it('comparison uses exact decimal arithmetic on stored values', () => {
    // 0.1 + 0.2 stored as exact decimals: 0.3 target vs 0.1 + 0.2 actual is exactly at target
    expect(compareToTarget(actual('protein', '0.3', 'complete'), target('protein', 0.3, 'g'))).toMatchObject({ comparison_status: 'at_target', remaining: 0 });
    expect(compareToTarget(actual('protein', '109.999999', 'complete'), target('protein', 110, 'g'))).toMatchObject({ comparison_status: 'below_target', remaining: 0.000001 });
  });
});
