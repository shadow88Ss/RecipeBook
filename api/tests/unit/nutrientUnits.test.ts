import { describe, expect, it } from 'vitest';
import { fromNumber, roundHalfUp } from '../../src/domain/conversion/decimal';
import { convertNutrientAmount, normalizeNutrientUnit } from '../../src/domain/nutrition/nutrientUnits';
import { resolveNutrientSource, type FoodNutrientRecord } from '../../src/domain/nutrition/sourceResolution';

describe('nutrient-unit normalization', () => {
  it('normalizes spellings of compatible units', () => {
    expect(normalizeNutrientUnit('µg')).toBe('mcg'); // U+00B5 micro sign
    expect(normalizeNutrientUnit('μg')).toBe('mcg'); // U+03BC Greek mu
    expect(normalizeNutrientUnit('ug')).toBe('mcg');
    expect(normalizeNutrientUnit(' MG ')).toBe('mg');
    expect(normalizeNutrientUnit('KJ')).toBe('kJ');
    expect(normalizeNutrientUnit('IU')).toBe('IU');
  });

  it('converts exactly within the mass family', () => {
    const to = (v: number, from: string, target: string) => {
      const r = convertNutrientAmount(fromNumber(v), from, target);
      return r === null ? null : roundHalfUp(r, 12);
    };
    expect(to(1, 'g', 'mg')).toBe('1000');
    expect(to(1, 'mg', 'mcg')).toBe('1000');
    expect(to(250, 'µg', 'mg')).toBe('0.25');
    expect(to(0.1, 'mg', 'g')).toBe('0.0001');
  });

  it('refuses incompatible conversions', () => {
    expect(convertNutrientAmount(fromNumber(1), 'kcal', 'kJ')).toBeNull();
    expect(convertNutrientAmount(fromNumber(1), 'IU', 'mcg')).toBeNull();
    expect(convertNutrientAmount(fromNumber(1), 'g', 'kcal')).toBeNull();
  });
});

describe('resolveNutrientSource', () => {
  const rec = (id: string, source: FoodNutrientRecord['source']): FoodNutrientRecord => ({
    id,
    nutrient_id: 'n',
    amount: 1,
    basis_quantity: 100,
    basis_unit: 'g',
    source,
  });

  it('selects the single authoritative record', () => {
    expect(resolveNutrientSource([rec('a', 'trusted_database')])).toMatchObject({ status: 'selected', record: { id: 'a' } });
    expect(resolveNutrientSource([rec('b', 'manufacturer_label')])).toMatchObject({ status: 'selected', record: { id: 'b' } });
  });

  it('reports no data, non-authoritative-only and ambiguity', () => {
    expect(resolveNutrientSource([])).toEqual({ status: 'no_data', excluded: [] });
    expect(resolveNutrientSource([rec('c', 'ai_matched'), rec('d', 'user_entered')])).toMatchObject({ status: 'not_authoritative' });
    const ambiguous = resolveNutrientSource([rec('e', 'trusted_database'), rec('f', 'manufacturer_label'), rec('g', 'ai_matched')]);
    expect(ambiguous).toMatchObject({ status: 'ambiguous_nutrient_source', excluded: [{ food_nutrient_id: 'g' }] });
  });

  it('is order-independent', () => {
    const a = resolveNutrientSource([rec('x', 'ai_matched'), rec('y', 'trusted_database')]);
    const b = resolveNutrientSource([rec('y', 'trusted_database'), rec('x', 'ai_matched')]);
    expect(a).toEqual(b);
  });
});
