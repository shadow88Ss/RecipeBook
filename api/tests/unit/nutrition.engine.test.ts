// TEST FIXTURES ONLY — illustrative values, not real nutrition data.
import { describe, expect, it } from 'vitest';
import { fromNumber, parseDecimal, roundHalfUp, type Rational } from '../../src/domain/conversion/decimal';
import {
  aggregateNutrients,
  calculateItem,
  calculateNutrition,
  roundValue,
  type CalculationItemInput,
  type FoodNutritionData,
  type NutrientDefinition,
} from '../../src/domain/nutrition/nutrition.engine';
import type { FoodNutrientRecord } from '../../src/domain/nutrition/sourceResolution';

const N = {
  energy: { id: 'n-energy', canonical_key: 'energy', unit: 'kcal' },
  protein: { id: 'n-protein', canonical_key: 'protein', unit: 'g' },
  carbohydrate: { id: 'n-carbohydrate', canonical_key: 'carbohydrate', unit: 'g' },
  fat: { id: 'n-fat', canonical_key: 'fat', unit: 'g' },
  fiber: { id: 'n-fiber', canonical_key: 'fiber', unit: 'g' },
  iron: { id: 'n-iron', canonical_key: 'iron', unit: 'mg' },
  vitaminD: { id: 'n-vitamin-d', canonical_key: 'vitamin_d', unit: 'mcg' },
} satisfies Record<string, NutrientDefinition>;
const VOCAB: NutrientDefinition[] = Object.values(N);

let seq = 0;
const fn = (nutrient: NutrientDefinition, amount: number, extra: Partial<FoodNutrientRecord> = {}): FoodNutrientRecord => ({
  id: `fn-${++seq}`,
  nutrient_id: nutrient.id,
  amount,
  basis_quantity: 100,
  basis_unit: 'g',
  source: 'trusted_database',
  ...extra,
});

const food = (id: string, nutrients: FoodNutrientRecord[], extra: Partial<FoodNutritionData> = {}): FoodNutritionData => ({
  food_id: id,
  canonical_name: `fixture_${id}`,
  density: null,
  servings: [],
  nutrients,
  ...extra,
});

const item = (f: FoodNutritionData, quantity: number, amount: CalculationItemInput['amount']): CalculationItemInput => ({ food: f, quantity, amount });

const calc = (f: FoodNutritionData, quantity: number, amount: CalculationItemInput['amount']) => calculateItem(0, item(f, quantity, amount), VOCAB);
const nutrientOf = (result: ReturnType<typeof calc>, n: NutrientDefinition) => {
  const entry = result.nutrients.find((x) => x.nutrient.id === n.id);
  if (!entry) throw new Error('missing nutrient entry');
  return entry;
};
const num = (value: Rational | null) => (value === null ? null : Number(roundHalfUp(value, 6)));

const complete = food('complete', [fn(N.energy, 130), fn(N.protein, 10), fn(N.carbohydrate, 28.2), fn(N.fat, 0.3), fn(N.fiber, 0.4), fn(N.iron, 1.2), fn(N.vitaminD, 0)]);

describe('A/B/G/H: basis scaling', () => {
  it('A: 10 g protein per 100 g x 150 g = 15 g', () => {
    expect(num(nutrientOf(calc(complete, 150, { unit: 'g' }), N.protein).value)).toBe(15);
  });

  it('B: a non-100 basis is read, not assumed', () => {
    const per30g = food('per30', [fn(N.protein, 3, { basis_quantity: 30 })]);
    expect(num(nutrientOf(calc(per30g, 45, { unit: 'g' }), N.protein).value)).toBe(4.5);
    const per1g = food('per1', [fn(N.protein, 0.25, { basis_quantity: 1 })]);
    expect(num(nutrientOf(calc(per1g, 150, { unit: 'g' }), N.protein).value)).toBe(37.5);
    const perKgInput = calc(per30g, 1, { unit: 'kg' });
    expect(num(nutrientOf(perKgInput, N.protein).value)).toBe(100);
  });

  it('G/H: macros, fiber and micronutrients scale through the same arithmetic', () => {
    const result = calc(complete, 150, { unit: 'g' });
    expect(num(nutrientOf(result, N.energy).value)).toBe(195);
    expect(num(nutrientOf(result, N.carbohydrate).value)).toBe(42.3);
    expect(num(nutrientOf(result, N.fat).value)).toBe(0.45);
    expect(num(nutrientOf(result, N.fiber).value)).toBe(0.6);
    expect(num(nutrientOf(result, N.iron).value)).toBe(1.8);
    expect(nutrientOf(result, N.iron).unit).toBe('mg');
  });

  it('is deterministic: identical input gives identical output', () => {
    const a = calculateNutrition([item(complete, 137.3, { unit: 'g' })], VOCAB);
    const b = calculateNutrition([item(complete, 137.3, { unit: 'g' })], VOCAB);
    expect(JSON.stringify(a, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(
      JSON.stringify(b, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    );
  });
});

describe('C: serving calculation', () => {
  it('2 slices of a 30 g slice = 60 g, then scaled from the nutrient basis', () => {
    const bread = food('bread', [fn(N.protein, 10)], {
      servings: [{ id: 'slice', serving_description: '1 slice', region: null, canonical_quantity: 30, canonical_unit: 'g', source: 'trusted_database' }],
    });
    const result = calc(bread, 2, { serving_id: 'slice' });
    expect(result.normalized).toMatchObject({ status: 'converted', unit: 'g', authoritative: true });
    expect(result.normalized.status === 'converted' && num(result.normalized.value)).toBe(60);
    expect(num(nutrientOf(result, N.protein).value)).toBe(6);
  });

  it('an ai_matched serving weight never yields authoritative nutrition', () => {
    const scoop = food('scoop', [fn(N.protein, 80)], {
      servings: [{ id: 'scoop', serving_description: '1 scoop', region: null, canonical_quantity: 30, canonical_unit: 'g', source: 'ai_matched' }],
    });
    const protein = nutrientOf(calc(scoop, 1, { serving_id: 'scoop' }), N.protein);
    expect(protein).toMatchObject({ status: 'non_authoritative_quantity', value: null });
  });
});

describe('D/E/F: volume and mass/volume', () => {
  const milk = food('milk', [fn(N.protein, 3.4, { basis_unit: 'ml' })]);

  it('D: volume basis with volume input', () => {
    expect(num(nutrientOf(calc(milk, 250, { unit: 'ml' }), N.protein).value)).toBe(8.5);
    expect(num(nutrientOf(calc(milk, 1, { unit: 'cup_us' }), N.protein).value)).toBe(8.044);
  });

  it('E: mass <-> volume works with a trusted density', () => {
    const dense = food('dense', [fn(N.protein, 3.4, { basis_unit: 'ml' }), fn(N.fat, 1)], { density: { g_per_ml: 1.03, source: 'trusted_database' } });
    // 257.5 g / 1.03 = 250 ml -> 8.5 g protein; 250 ml x 1.03 = 257.5 g -> 2.575 g fat
    expect(num(nutrientOf(calc(dense, 257.5, { unit: 'g' }), N.protein).value)).toBe(8.5);
    expect(num(nutrientOf(calc(dense, 250, { unit: 'ml' }), N.fat).value)).toBe(2.575);
  });

  it('E: an ai_matched density is not authoritative', () => {
    const aiDensity = food('ai-density', [fn(N.fat, 1)], { density: { g_per_ml: 1.03, source: 'ai_matched' } });
    expect(nutrientOf(calc(aiDensity, 250, { unit: 'ml' }), N.fat)).toMatchObject({ status: 'non_authoritative_quantity', value: null });
  });

  it('F: without density a volume input against a mass basis is unresolved, never 1 ml = 1 g', () => {
    const result = calc(complete, 250, { unit: 'ml' });
    expect(nutrientOf(result, N.protein)).toMatchObject({ status: 'basis_unreconcilable', value: null, conversion_reason: 'density_unavailable' });
    expect(result.normalized).toMatchObject({ status: 'converted', unit: 'ml' });
  });

  it('bases are reconciled per nutrient record', () => {
    const mixed = food('mixed', [fn(N.protein, 3.4, { basis_unit: 'ml' }), fn(N.fat, 1)]);
    const result = calc(mixed, 100, { unit: 'g' });
    expect(nutrientOf(result, N.fat).status).toBe('resolved');
    expect(nutrientOf(result, N.protein).status).toBe('basis_unreconcilable');
  });
});

describe('L/M/T: known zero, missing, energy', () => {
  it('L: a stored zero stays a known zero', () => {
    const vitaminD = nutrientOf(calc(complete, 150, { unit: 'g' }), N.vitaminD);
    expect(vitaminD.status).toBe('resolved');
    expect(vitaminD.value && roundValue(vitaminD.value)).toEqual({ value: 0, is_zero: true, below_output_precision: false });
  });

  it('M: a nutrient with no record is no_data with a null value, never 0', () => {
    const sparse = food('sparse', [fn(N.protein, 5)]);
    expect(nutrientOf(calc(sparse, 100, { unit: 'g' }), N.iron)).toMatchObject({ status: 'no_data', value: null });
  });

  it('T: energy is never derived from macros when no energy value is stored', () => {
    const noEnergy = food('no-energy', [fn(N.protein, 10), fn(N.carbohydrate, 20), fn(N.fat, 5)]);
    expect(nutrientOf(calc(noEnergy, 100, { unit: 'g' }), N.energy)).toMatchObject({ status: 'no_data', value: null });
  });

  it('a tiny non-zero value is flagged rather than shown as a known zero', () => {
    expect(roundValue(parseDecimal('0.0000001'))).toEqual({ value: 0, is_zero: false, below_output_precision: true });
  });
});

describe('P/Q/R/S: source resolution and provenance', () => {
  it('P/Q: competing authoritative sources are neither summed nor averaged, and surface as ambiguous', () => {
    const competing = food('competing', [fn(N.protein, 9), fn(N.protein, 11, { source: 'manufacturer_label' })]);
    const protein = nutrientOf(calc(competing, 100, { unit: 'g' }), N.protein);
    expect(protein).toMatchObject({ status: 'ambiguous_nutrient_source', value: null, selected: null });
    expect(protein.candidates.map((c) => c.source)).toEqual(['manufacturer_label', 'trusted_database']);
  });

  it('an ai_matched value alongside a trusted one is excluded, not combined', () => {
    const mixed = food('mixed-src', [fn(N.protein, 9), fn(N.protein, 50, { source: 'ai_matched' })]);
    const protein = nutrientOf(calc(mixed, 100, { unit: 'g' }), N.protein);
    expect(num(protein.value)).toBe(9);
    expect(protein.excluded).toEqual([expect.objectContaining({ source: 'ai_matched', reason: 'ai_matched_not_authoritative' })]);
  });

  it('R: AI-matched identity with no trusted nutrient data produces no nutrition', () => {
    const aiOnly = food('ai-only', [fn(N.protein, 12, { source: 'ai_matched' }), fn(N.energy, 300, { source: 'user_entered' })]);
    const result = calc(aiOnly, 100, { unit: 'g' });
    expect(result.nutrients.every((n) => n.value === null)).toBe(true);
    expect(nutrientOf(result, N.protein).status).toBe('not_authoritative');
    expect(nutrientOf(result, N.energy).excluded[0]?.reason).toBe('user_entered_not_permitted');
    expect(nutrientOf(result, N.fat).status).toBe('no_data');
  });

  it('S: the selected record, its source and basis survive calculation', () => {
    const labelled = food('labelled', [fn(N.protein, 3, { basis_quantity: 30, source: 'manufacturer_label' })]);
    const protein = nutrientOf(calc(labelled, 45, { unit: 'g' }), N.protein);
    expect(protein.selected).toMatchObject({
      source: 'manufacturer_label',
      amount_per_basis: 3,
      basis_quantity: 30,
      basis_unit: 'g',
    });
    expect(protein.selected?.food_nutrient_id).toMatch(/^fn-/);
    expect(num(protein.selected?.quantity_in_basis_unit ?? null)).toBe(45);
  });
});

describe('I/J/K/N/O/U: aggregation', () => {
  const partialFood = food('partial', [fn(N.protein, 20), fn(N.iron, 2)]);
  const thirdFood = food('third', [fn(N.protein, 5)]);

  it('K/N/O: sums resolved values and marks coverage complete / partial / unavailable', () => {
    const result = calculateNutrition(
      [item(complete, 100, { unit: 'g' }), item(partialFood, 50, { unit: 'g' }), item(thirdFood, 200, { unit: 'g' })],
      VOCAB,
    );
    const agg = (n: NutrientDefinition) => result.aggregate.find((a) => a.nutrient.id === n.id);
    expect(agg(N.protein)).toMatchObject({ coverage: 'complete', resolved_item_count: 3, item_count: 3, missing: [] });
    expect(num(agg(N.protein)?.value ?? null)).toBe(30); // 10 + 10 + 10
    expect(agg(N.iron)).toMatchObject({ coverage: 'partial', resolved_item_count: 2, missing: [{ index: 2, status: 'no_data' }] });
    expect(num(agg(N.iron)?.value ?? null)).toBe(2.2); // 1.2 + 1.0, a lower bound
    const noVitD = calculateNutrition([item(partialFood, 50, { unit: 'g' }), item(thirdFood, 200, { unit: 'g' })], VOCAB);
    expect(noVitD.aggregate.find((a) => a.nutrient.id === N.vitaminD.id)).toMatchObject({ coverage: 'unavailable', value: null });
  });

  it('L: known zeros aggregate to a complete known zero', () => {
    const result = calculateNutrition([item(complete, 100, { unit: 'g' }), item(complete, 50, { unit: 'g' })], VOCAB);
    const vitD = result.aggregate.find((a) => a.nutrient.id === N.vitaminD.id);
    expect(vitD?.coverage).toBe('complete');
    expect(vitD?.value && roundValue(vitD.value)).toEqual({ value: 0, is_zero: true, below_output_precision: false });
  });

  it('P: an ambiguous item is excluded from the total, not summed twice', () => {
    const competing = food('competing2', [fn(N.protein, 9), fn(N.protein, 11, { source: 'manufacturer_label' })]);
    const result = calculateNutrition([item(competing, 100, { unit: 'g' }), item(thirdFood, 100, { unit: 'g' })], VOCAB);
    const protein = result.aggregate.find((a) => a.nutrient.id === N.protein.id);
    expect(num(protein?.value ?? null)).toBe(5);
    expect(protein).toMatchObject({ coverage: 'partial', missing: [{ index: 0, status: 'ambiguous_nutrient_source' }] });
  });

  it('U: no intermediate-rounding drift — three exact thirds sum to exactly 1', () => {
    const third = food('thirds', [fn(N.protein, 1, { basis_quantity: 300 })]);
    const result = calculateNutrition([0, 1, 2].map(() => item(third, 100, { unit: 'g' })), VOCAB);
    for (const i of result.items) expect(num(i.nutrients.find((n) => n.nutrient.id === N.protein.id)?.value ?? null)).toBe(0.333333);
    const total = result.aggregate.find((a) => a.nutrient.id === N.protein.id)?.value;
    expect(total).toEqual({ n: 1n, d: 1n });
  });

  it('U: repeated decimal accumulation stays exact (0.1 x 10 = 1, not 0.9999999999999999)', () => {
    const tenth = food('tenth', [fn(N.protein, 0.1, { basis_quantity: 1 })]);
    const result = calculateNutrition(Array.from({ length: 10 }, () => item(tenth, 1, { unit: 'g' })), VOCAB);
    expect(result.aggregate.find((a) => a.nutrient.id === N.protein.id)?.value).toEqual({ n: 1n, d: 1n });
  });

  it('I: mg and µg contributions are normalized to the nutrient unit before adding', () => {
    const agg = aggregateNutrients(
      [N.iron],
      [
        { index: 0, nutrients: [{ nutrient_id: N.iron.id, status: 'resolved', value: fromNumber(1.5), unit: 'mg' }] },
        { index: 1, nutrients: [{ nutrient_id: N.iron.id, status: 'resolved', value: fromNumber(250), unit: 'µg' }] },
        { index: 2, nutrients: [{ nutrient_id: N.iron.id, status: 'resolved', value: fromNumber(0.001), unit: 'g' }] },
      ],
    );
    expect(num(agg[0]?.value ?? null)).toBe(2.75); // 1.5 + 0.25 + 1
    expect(agg[0]?.coverage).toBe('complete');
  });

  it('J: incompatible units are never added', () => {
    const energy = aggregateNutrients(
      [N.energy],
      [
        { index: 0, nutrients: [{ nutrient_id: N.energy.id, status: 'resolved', value: fromNumber(100), unit: 'kcal' }] },
        { index: 1, nutrients: [{ nutrient_id: N.energy.id, status: 'resolved', value: fromNumber(418.4), unit: 'kJ' }] },
      ],
    );
    expect(num(energy[0]?.value ?? null)).toBe(100);
    expect(energy[0]).toMatchObject({ coverage: 'partial', missing: [{ index: 1, status: 'incompatible_unit' }] });

    const vitD = aggregateNutrients(
      [N.vitaminD],
      [{ index: 0, nutrients: [{ nutrient_id: N.vitaminD.id, status: 'resolved', value: fromNumber(400), unit: 'IU' }] }],
    );
    expect(vitD[0]).toMatchObject({ coverage: 'unavailable', value: null, missing: [{ index: 0, status: 'incompatible_unit' }] });
  });
});
