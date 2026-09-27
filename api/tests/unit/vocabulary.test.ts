// TEST FIXTURES ONLY in the projection/engine cases below — illustrative values.
import { describe, expect, it } from 'vitest';
import { fromNumber, parseDecimal } from '../../src/domain/conversion/decimal';
import { convert, type FoodConversionData } from '../../src/domain/conversion/conversion.engine';
import { authorityOf, isGlobalReferenceAuthority } from '../../src/domain/authority/authority';
import {
  aggregateNutrients,
  calculateItem,
  calculateNutrition,
  type AggregateNutrient,
  type FoodNutritionData,
  type NutrientDefinition,
} from '../../src/domain/nutrition/nutrition.engine';
import { projectAggregateSummary, projectItemSummary, SUMMARY_FIELDS } from '../../src/domain/nutrition/nutritionSummary';
import { CANONICAL_NUTRIENT_BY_KEY, CANONICAL_NUTRIENTS, NUTRIENT_KEYS } from '../../src/domain/nutrition/vocabulary';

const REQUIRED_KEYS = [
  'energy', 'protein', 'carbohydrate', 'fat', 'fiber',
  'sodium', 'potassium', 'calcium', 'iron', 'magnesium', 'zinc',
  'vitamin_a', 'vitamin_c', 'vitamin_d', 'vitamin_e', 'vitamin_k',
  'thiamin', 'riboflavin', 'niacin', 'vitamin_b6', 'folate', 'vitamin_b12',
];

describe('A-D: canonical nutrient vocabulary', () => {
  it('A: has exactly one energy identity: energy, in kcal', () => {
    const energy = CANONICAL_NUTRIENTS.filter((n) => n.role === 'energy');
    expect(energy).toHaveLength(1);
    expect(energy[0]).toMatchObject({ key: 'energy', unit: 'kcal' });
  });

  it('B: protein, carbohydrate and fat are macronutrients; fiber has its own role', () => {
    for (const key of ['protein', 'carbohydrate', 'fat']) expect(CANONICAL_NUTRIENT_BY_KEY.get(key)?.role).toBe('macronutrient');
    expect(CANONICAL_NUTRIENT_BY_KEY.get('fiber')?.role).toBe('fiber');
    expect(CANONICAL_NUTRIENTS.filter((n) => n.role === 'macronutrient').map((n) => n.key)).toEqual(['protein', 'carbohydrate', 'fat']);
  });

  it('C: every required identity exists exactly once, with a stable language-neutral key', () => {
    const keys = CANONICAL_NUTRIENTS.map((n) => n.key);
    expect([...keys].sort()).toEqual([...REQUIRED_KEYS].sort());
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(NUTRIENT_KEYS[key as keyof typeof NUTRIENT_KEYS]).toBe(key);
    }
    for (const key of REQUIRED_KEYS.slice(5)) expect(CANONICAL_NUTRIENT_BY_KEY.get(key)?.role).toBe('micronutrient');
  });

  it('D: reporting units are deterministic and follow the role rules (no IU, no kJ)', () => {
    const units = Object.fromEntries(CANONICAL_NUTRIENTS.map((n) => [n.key, n.unit]));
    expect(units).toEqual({
      energy: 'kcal', protein: 'g', carbohydrate: 'g', fat: 'g', fiber: 'g',
      sodium: 'mg', potassium: 'mg', calcium: 'mg', iron: 'mg', magnesium: 'mg', zinc: 'mg',
      vitamin_a: 'mcg', vitamin_c: 'mg', vitamin_d: 'mcg', vitamin_e: 'mg', vitamin_k: 'mcg',
      thiamin: 'mg', riboflavin: 'mg', niacin: 'mg', vitamin_b6: 'mg', folate: 'mcg', vitamin_b12: 'mcg',
    });
    for (const n of CANONICAL_NUTRIENTS) {
      if (n.role === 'micronutrient') expect(['mg', 'mcg']).toContain(n.unit);
      if (n.role === 'macronutrient' || n.role === 'fiber') expect(n.unit).toBe('g');
    }
  });

  it('documents the carbohydrate meaning and flags measures needing mapping review', () => {
    expect(CANONICAL_NUTRIENT_BY_KEY.get('carbohydrate')?.definition).toMatch(/INCLUDING dietary fiber/);
    const review = CANONICAL_NUTRIENTS.filter((n) => n.measure_requires_mapping_review).map((n) => n.key);
    expect(review).toEqual(['carbohydrate', 'vitamin_a', 'vitamin_d', 'vitamin_e', 'niacin', 'folate']);
  });
});

describe('authority classification', () => {
  it('maps every source to exactly one class', () => {
    expect(authorityOf('trusted_database')).toBe('global_reference');
    expect(authorityOf('manufacturer_label')).toBe('exact_product');
    expect(authorityOf('user_entered')).toBe('personal_user_confirmed');
    expect(authorityOf('ai_matched')).toBe('non_authoritative_inference');
    expect(isGlobalReferenceAuthority('user_entered')).toBe(false);
    expect(isGlobalReferenceAuthority('ai_matched')).toBe(false);
  });
});

// --- summary projection -------------------------------------------------------

const V: Record<string, NutrientDefinition> = Object.fromEntries(
  CANONICAL_NUTRIENTS.map((n) => [n.key, { id: `id-${n.key}`, canonical_key: n.key, unit: n.unit, role: n.role }]),
);
const VOCAB = Object.values(V);

const agg = (key: string, value: string | null, coverage: AggregateNutrient['coverage'], resolved: number, count: number): AggregateNutrient => ({
  nutrient: V[key] as NutrientDefinition,
  value: value === null ? null : parseDecimal(value),
  coverage,
  resolved_item_count: resolved,
  item_count: count,
  missing: [],
});

describe('E-J: summary projection', () => {
  it('E: copies the Layer 5B aggregate verbatim — no recalculation', () => {
    // Values chosen so they could not come from any recomputation of items:
    // the projection receives only the aggregate.
    const summary = projectAggregateSummary(
      [
        agg('energy', '514.1234564', 'complete', 3, 3),
        agg('protein', '17.95', 'complete', 3, 3),
        agg('carbohydrate', '99', 'partial', 2, 3),
        agg('fat', null, 'unavailable', 0, 3),
        agg('fiber', '0', 'complete', 3, 3),
      ],
      3,
    );
    expect(summary.energy_kcal).toEqual({
      nutrient_key: 'energy',
      value: 514.123456,
      is_zero: false,
      below_output_precision: false,
      coverage: 'complete',
      status: null,
      resolved_item_count: 3,
      item_count: 3,
    });
    expect(summary.protein_g.value).toBe(17.95);
    expect(Object.keys(summary)).toEqual(SUMMARY_FIELDS.map((f) => f.field));
  });

  it('F/G/H: unavailable stays null, partial stays partial, known zero stays zero', () => {
    const summary = projectAggregateSummary(
      [agg('energy', '10', 'complete', 1, 1), agg('carbohydrate', '99', 'partial', 2, 3), agg('fat', null, 'unavailable', 0, 3), agg('fiber', '0', 'complete', 3, 3)],
      3,
    );
    expect(summary.fat_g).toMatchObject({ value: null, is_zero: false, coverage: 'unavailable', status: 'no_data' });
    expect(summary.carbohydrate_g).toMatchObject({ value: 99, coverage: 'partial', status: 'partial', resolved_item_count: 2, item_count: 3 });
    expect(summary.fiber_g).toMatchObject({ value: 0, is_zero: true, coverage: 'complete' });
    // protein absent from the aggregate entirely
    expect(summary.protein_g).toMatchObject({ value: null, coverage: 'unavailable', status: 'not_in_vocabulary' });
  });

  it('I: no 4/4/9 derivation — energy stays unavailable when only macros are known', () => {
    const food: FoodNutritionData = {
      food_id: 'f',
      canonical_name: 'fixture_macros_only',
      density: null,
      servings: [],
      nutrients: ['protein', 'carbohydrate', 'fat'].map((key, i) => ({
        id: `fn-${i}`,
        nutrient_id: `id-${key}`,
        amount: 10,
        basis_quantity: 100,
        basis_unit: 'g',
        source: 'trusted_database' as const,
      })),
    };
    const result = calculateNutrition([{ food, quantity: 100, amount: { unit: 'g' } }], VOCAB);
    const summary = projectAggregateSummary(result.aggregate, 1);
    expect(summary.protein_g.value).toBe(10);
    expect(summary.fat_g.value).toBe(10);
    expect(summary.energy_kcal).toMatchObject({ value: null, coverage: 'unavailable' });
    expect(projectItemSummary(result.items[0]!).energy_kcal).toMatchObject({ value: null, status: 'no_data' });
  });

  it('J: kcal and kJ are never combined, and a non-kcal energy is not summarized', () => {
    const energy = V.energy as NutrientDefinition;
    const combined = aggregateNutrients([energy], [
      { index: 0, nutrients: [{ nutrient_id: energy.id, status: 'resolved', value: fromNumber(100), unit: 'kcal' }] },
      { index: 1, nutrients: [{ nutrient_id: energy.id, status: 'resolved', value: fromNumber(418.4), unit: 'kJ' }] },
    ]);
    expect(combined[0]).toMatchObject({ coverage: 'partial', missing: [{ index: 1, status: 'incompatible_unit' }] });
    expect(projectAggregateSummary(combined, 2).energy_kcal).toMatchObject({ value: 100, coverage: 'partial' });

    const kjEnergy = { ...energy, unit: 'kJ' };
    const kjAgg: AggregateNutrient = { nutrient: kjEnergy, value: fromNumber(418.4), coverage: 'complete', resolved_item_count: 1, item_count: 1, missing: [] };
    expect(projectAggregateSummary([kjAgg], 1).energy_kcal).toMatchObject({ value: null, coverage: 'unavailable', status: 'unit_mismatch' });
  });

  it('M: an ambiguous source stays ambiguous in the item summary and unavailable in the total', () => {
    const food: FoodNutritionData = {
      food_id: 'c',
      canonical_name: 'fixture_competing',
      density: null,
      servings: [],
      nutrients: [
        { id: 'a', nutrient_id: 'id-protein', amount: 9, basis_quantity: 100, basis_unit: 'g', source: 'trusted_database' },
        { id: 'b', nutrient_id: 'id-protein', amount: 11, basis_quantity: 100, basis_unit: 'g', source: 'manufacturer_label' },
      ],
    };
    const result = calculateNutrition([{ food, quantity: 100, amount: { unit: 'g' } }], VOCAB);
    expect(projectItemSummary(result.items[0]!).protein_g).toMatchObject({ value: null, status: 'ambiguous_nutrient_source' });
    expect(projectAggregateSummary(result.aggregate, 1).protein_g).toMatchObject({ value: null, coverage: 'unavailable' });
  });
});

describe('K/L: serving authority', () => {
  const food = (source: 'user_entered' | 'ai_matched' | 'trusted_database'): FoodNutritionData => ({
    food_id: 'f',
    canonical_name: 'fixture_serving_authority',
    density: null,
    servings: [{ id: 's', serving_description: '1 bowl', region: null, canonical_quantity: 250, canonical_unit: 'g', source }],
    nutrients: [{ id: 'p', nutrient_id: 'id-protein', amount: 10, basis_quantity: 100, basis_unit: 'g', source: 'trusted_database' }],
  });

  it('K: a user-entered serving is personal data, never global reference authority', () => {
    const conversion = convert({ quantity: 1, from: { serving_id: 's' }, to: { unit: 'g' } }, food('user_entered'));
    expect(conversion).toMatchObject({ status: 'converted', quantity: 250, authoritative: false, confirmation_required: false });
    expect(conversion.status === 'converted' && conversion.provenance[0]).toMatchObject({ authority: 'personal_user_confirmed' });
    const protein = calculateItem(0, { food: food('user_entered'), quantity: 1, amount: { serving_id: 's' } }, VOCAB).nutrients.find(
      (n) => n.nutrient.canonical_key === 'protein',
    );
    expect(protein).toMatchObject({ status: 'non_authoritative_quantity', value: null });
  });

  it('K: a user-entered density is not global reference authority either', () => {
    const data: FoodConversionData = { food_id: 'd', density: { g_per_ml: 1.1, source: 'user_entered' }, servings: [] };
    expect(convert({ quantity: 100, from: { unit: 'ml' }, to: { unit: 'g' } }, data)).toMatchObject({ authoritative: false });
  });

  it('L: an AI-matched serving remains non-authoritative', () => {
    const protein = calculateItem(0, { food: food('ai_matched'), quantity: 1, amount: { serving_id: 's' } }, VOCAB).nutrients.find(
      (n) => n.nutrient.canonical_key === 'protein',
    );
    expect(protein).toMatchObject({ status: 'non_authoritative_quantity', value: null });
  });

  it('a trusted serving is authoritative', () => {
    const protein = calculateItem(0, { food: food('trusted_database'), quantity: 1, amount: { serving_id: 's' } }, VOCAB).nutrients.find(
      (n) => n.nutrient.canonical_key === 'protein',
    );
    expect(protein?.status).toBe('resolved');
  });
});
