import { describe, expect, it } from 'vitest';
import { parseDecimal, roundHalfUp, div, mul } from '../../src/domain/conversion/decimal';
import { resolveUnit, UNITS, unitFactor } from '../../src/domain/conversion/units';

describe('unit registry', () => {
  it('defines every unit against exactly one of the two canonical base units', () => {
    for (const unit of UNITS.values()) {
      expect(['mass', 'volume']).toContain(unit.dimension);
      expect(parseDecimal(unit.factor).n > 0n).toBe(true);
    }
    expect(UNITS.get('g')?.factor).toBe('1');
    expect(UNITS.get('ml')?.factor).toBe('1');
  });

  it('uses the exact legal definitions for customary/imperial units', () => {
    expect(UNITS.get('lb')?.factor).toBe('453.59237');
    expect(UNITS.get('oz')?.factor).toBe('28.349523125');
    expect(UNITS.get('cup_us')?.factor).toBe('236.5882365');
    expect(UNITS.get('gallon_imp')?.factor).toBe('4546.09');
  });

  it('keeps the US customary chain internally consistent (exact ratios)', () => {
    const f = (code: string) => unitFactor(code);
    const ratio = (a: string, b: string) => roundHalfUp(div(f(a), f(b)), 12);
    expect(ratio('tbsp_us', 'tsp_us')).toBe('3');
    expect(ratio('cup_us', 'fl_oz_us')).toBe('8');
    expect(ratio('pint_us', 'cup_us')).toBe('2');
    expect(ratio('gallon_us', 'quart_us')).toBe('4');
    expect(ratio('pint_imp', 'fl_oz_imp')).toBe('20');
    expect(ratio('lb', 'oz')).toBe('16');
    expect(roundHalfUp(mul(f('fl_oz_us'), parseDecimal('128')), 12)).toBe(UNITS.get('gallon_us')?.factor);
  });
});

describe('resolveUnit', () => {
  it('resolves codes and unambiguous synonyms case- and whitespace-insensitively', () => {
    expect(resolveUnit('g')).toMatchObject({ ok: true, unit: { code: 'g' } });
    expect(resolveUnit(' Grams ')).toMatchObject({ ok: true, unit: { code: 'g' } });
    expect(resolveUnit('µg')).toMatchObject({ ok: true, unit: { code: 'mcg' } });
    expect(resolveUnit('Litres')).toMatchObject({ ok: true, unit: { code: 'l' } });
    expect(resolveUnit('lbs')).toMatchObject({ ok: true, unit: { code: 'lb' } });
    expect(resolveUnit('CUP-US')).toMatchObject({ ok: true, unit: { code: 'cup_us' } });
  });

  it('never picks a default measurement system for regionally ambiguous measures', () => {
    expect(resolveUnit('cup')).toEqual({ ok: false, reason: 'ambiguous_unit', candidates: ['cup_us', 'cup_metric', 'cup_us_legal'] });
    expect(resolveUnit('Tablespoons')).toEqual({ ok: false, reason: 'ambiguous_unit', candidates: ['tbsp_us', 'tbsp_metric', 'tbsp_au'] });
    expect(resolveUnit('fl oz')).toMatchObject({ ok: false, reason: 'ambiguous_unit' });
  });

  it('reports unknown units rather than guessing', () => {
    expect(resolveUnit('handful')).toEqual({ ok: false, reason: 'unknown_unit' });
    expect(resolveUnit('slice')).toEqual({ ok: false, reason: 'unknown_unit' });
    expect(resolveUnit('')).toEqual({ ok: false, reason: 'unknown_unit' });
  });
});
