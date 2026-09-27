// Layer 5A — exact decimal arithmetic for the deterministic conversion
// engine (Master §5: unit/serving conversion is calculated, never
// estimated).
//
// Every conversion factor is an exact decimal (e.g. 1 US cup =
// 236.5882365 ml exactly, by definition), and every input quantity is
// parsed from its shortest decimal representation. Working in exact
// rationals (BigInt numerator/denominator) means a chain like
// cup -> ml -> g -> oz accumulates no binary floating-point error, so the
// same input always produces the same output on every platform. Rounding
// happens exactly once, at the end (roundHalfUp below).

export interface Rational {
  readonly n: bigint;
  /** Always > 0. */
  readonly d: bigint;
}

const DECIMAL_PATTERN = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i;

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b;
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x === 0n ? 1n : x;
}

function make(n: bigint, d: bigint): Rational {
  if (d === 0n) throw new Error('Division by zero.');
  const sign = d < 0n ? -1n : 1n;
  const g = gcd(n, d);
  return { n: (sign * n) / g, d: (sign * d) / g };
}

/** Parses a non-negative decimal string ("240", "0.593", "1e-7"). */
export function parseDecimal(text: string): Rational {
  const match = DECIMAL_PATTERN.exec(text.trim());
  if (!match) throw new Error(`Not a non-negative decimal: ${text}`);
  const [, intPart = '0', fracPart = '', expPart] = match;
  let n = BigInt(intPart + fracPart);
  let d = 10n ** BigInt(fracPart.length);
  const exp = expPart ? Number.parseInt(expPart, 10) : 0;
  if (exp > 0) n *= 10n ** BigInt(exp);
  if (exp < 0) d *= 10n ** BigInt(-exp);
  return make(n, d);
}

/** A finite, non-negative JS number, taken at its shortest round-trip
 * decimal representation (so 0.1 means exactly 1/10, not the nearest
 * binary double). */
export function fromNumber(value: number): Rational {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Not a finite non-negative number: ${value}`);
  return parseDecimal(String(value));
}

export const ZERO: Rational = { n: 0n, d: 1n };

export function add(a: Rational, b: Rational): Rational {
  return make(a.n * b.d + b.n * a.d, a.d * b.d);
}

export function mul(a: Rational, b: Rational): Rational {
  return make(a.n * b.n, a.d * b.d);
}

export function div(a: Rational, b: Rational): Rational {
  if (b.n === 0n) throw new Error('Division by zero.');
  return make(a.n * b.d, a.d * b.n);
}

export function isZero(a: Rational): boolean {
  return a.n === 0n;
}

/**
 * Rounds a non-negative rational to `places` decimal places, ROUND_HALF_UP
 * (a tie rounds away from zero — the conventional rule for displayed
 * nutrition quantities), and returns the fixed-point decimal string with
 * trailing zeros removed ("2.5", "240", "0.000001").
 */
export function roundHalfUp(value: Rational, places: number): string {
  if (value.n < 0n) throw new Error('roundHalfUp expects a non-negative value.');
  const scale = 10n ** BigInt(places);
  const scaled = value.n * scale;
  let quotient = scaled / value.d;
  const remainder = scaled % value.d;
  if (remainder * 2n >= value.d) quotient += 1n;

  const digits = quotient.toString().padStart(places + 1, '0');
  const intPart = digits.slice(0, digits.length - places);
  const fracPart = places > 0 ? digits.slice(digits.length - places).replace(/0+$/, '') : '';
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

/** Exact decimal string of a rational whose denominator has only 2/5
 * factors (true of every factor in the unit registry); otherwise rounds to
 * 12 places. Used only to report the factors a conversion applied. */
export function toDecimalString(value: Rational): string {
  let d = value.d;
  let places = 0;
  while (d % 10n === 0n) {
    d /= 10n;
    places += 1;
  }
  while (d % 2n === 0n || d % 5n === 0n) {
    d /= d % 2n === 0n ? 2n : 5n;
    places += 1;
  }
  return roundHalfUp(value, d === 1n ? places : 12);
}
