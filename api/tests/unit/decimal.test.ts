import { describe, expect, it } from 'vitest';
import { div, fromNumber, mul, parseDecimal, roundHalfUp, toDecimalString } from '../../src/domain/conversion/decimal';

describe('parseDecimal / fromNumber', () => {
  it('parses integers, fractions and exponent notation exactly', () => {
    expect(parseDecimal('240')).toEqual({ n: 240n, d: 1n });
    expect(parseDecimal('0.593')).toEqual({ n: 593n, d: 1000n });
    expect(parseDecimal('2.50')).toEqual({ n: 5n, d: 2n });
    expect(parseDecimal('1e-7')).toEqual({ n: 1n, d: 10_000_000n });
    expect(parseDecimal('1.5e3')).toEqual({ n: 1500n, d: 1n });
  });

  it('takes a JS number at its shortest decimal form (0.1 is exactly 1/10)', () => {
    expect(fromNumber(0.1)).toEqual({ n: 1n, d: 10n });
    expect(fromNumber(1e-7)).toEqual({ n: 1n, d: 10_000_000n });
  });

  it('rejects negative, non-finite and non-numeric input', () => {
    expect(() => parseDecimal('-1')).toThrow();
    expect(() => parseDecimal('abc')).toThrow();
    expect(() => fromNumber(Number.NaN)).toThrow();
    expect(() => fromNumber(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => fromNumber(-0.5)).toThrow();
  });
});

describe('exact arithmetic', () => {
  it('has no binary floating-point drift (0.1 x 3 = 0.3 exactly)', () => {
    expect(roundHalfUp(mul(fromNumber(0.1), fromNumber(3)), 20)).toBe('0.3');
  });

  it('round-trips through multiply then divide exactly', () => {
    const cup = parseDecimal('236.5882365');
    const value = div(mul(fromNumber(3), cup), cup);
    expect(value).toEqual({ n: 3n, d: 1n });
  });

  it('refuses division by zero', () => {
    expect(() => div(fromNumber(1), fromNumber(0))).toThrow();
  });
});

describe('roundHalfUp', () => {
  it('rounds a tie away from zero', () => {
    expect(roundHalfUp(parseDecimal('2.5'), 0)).toBe('3');
    expect(roundHalfUp(parseDecimal('0.0000005'), 6)).toBe('0.000001');
    expect(roundHalfUp(parseDecimal('1.2345665'), 6)).toBe('1.234567');
  });

  it('rounds below a tie down', () => {
    expect(roundHalfUp(parseDecimal('1.23456649'), 6)).toBe('1.234566');
  });

  it('strips trailing zeros and keeps leading zeros', () => {
    expect(roundHalfUp(parseDecimal('240'), 6)).toBe('240');
    expect(roundHalfUp(parseDecimal('0.05'), 6)).toBe('0.05');
    expect(roundHalfUp(parseDecimal('0.0000004'), 6)).toBe('0');
  });

  it('handles repeating fractions deterministically', () => {
    expect(roundHalfUp(div(fromNumber(1), fromNumber(3)), 6)).toBe('0.333333');
    expect(roundHalfUp(div(fromNumber(2), fromNumber(3)), 6)).toBe('0.666667');
  });
});

describe('toDecimalString', () => {
  it('prints terminating decimals exactly', () => {
    expect(toDecimalString(parseDecimal('14.78676478125'))).toBe('14.78676478125');
    expect(toDecimalString(parseDecimal('0.000001'))).toBe('0.000001');
  });
});
