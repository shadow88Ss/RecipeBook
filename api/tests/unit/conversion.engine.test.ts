import { describe, expect, it } from 'vitest';
import { convert, CONVERSION_VERSION, type FoodConversionData } from '../../src/domain/conversion/conversion.engine';
import { foodConversionSchema, unitConversionSchema } from '../../src/domain/conversion/conversion.schemas';

// Illustrative reference data for unit tests only — not real food data.
const SLICE = '11111111-1111-4111-8111-111111111111';
const CUP_SERVING = '22222222-2222-4222-8222-222222222222';
const AI_SERVING = '33333333-3333-4333-8333-333333333333';
const BAD_SERVING = '44444444-4444-4444-8444-444444444444';

const food: FoodConversionData = {
  food_id: 'f0000000-0000-4000-8000-000000000001',
  density: { g_per_ml: 0.593, source: 'trusted_database' },
  servings: [
    { id: SLICE, serving_description: '1 slice', region: null, canonical_quantity: 28, canonical_unit: 'g', source: 'trusted_database' },
    { id: CUP_SERVING, serving_description: '1 cup', region: 'US', canonical_quantity: 240, canonical_unit: 'ml', source: 'trusted_database' },
    { id: AI_SERVING, serving_description: '1 scoop', region: null, canonical_quantity: 30, canonical_unit: 'g', source: 'ai_matched' },
    { id: BAD_SERVING, serving_description: '1 bad', region: null, canonical_quantity: 1, canonical_unit: 'cup', source: 'trusted_database' },
  ],
};
const noDensity: FoodConversionData = { ...food, density: null };

const ok = (result: ReturnType<typeof convert>) => {
  if (result.status !== 'converted') throw new Error(`expected converted, got ${result.reason}`);
  return result;
};

describe('unit -> unit (same dimension, no food needed)', () => {
  it('converts mass exactly', () => {
    expect(ok(convert({ quantity: 1, from: { unit: 'lb' }, to: { unit: 'g' } }, null)).quantity).toBe(453.59237);
    expect(ok(convert({ quantity: 1, from: { unit: 'kg' }, to: { unit: 'lb' } }, null)).quantity).toBe(2.204623);
    expect(ok(convert({ quantity: 16, from: { unit: 'oz' }, to: { unit: 'lb' } }, null)).quantity).toBe(1);
    expect(ok(convert({ quantity: 250, from: { unit: 'mg' }, to: { unit: 'g' } }, null)).quantity).toBe(0.25);
    expect(ok(convert({ quantity: 1, from: { unit: 'g' }, to: { unit: 'mcg' } }, null)).quantity).toBe(1_000_000);
  });

  it('converts volume exactly', () => {
    expect(ok(convert({ quantity: 1, from: { unit: 'cup_us' }, to: { unit: 'ml' } }, null)).quantity).toBe(236.588237);
    expect(ok(convert({ quantity: 3, from: { unit: 'tsp_us' }, to: { unit: 'tbsp_us' } }, null)).quantity).toBe(1);
    expect(ok(convert({ quantity: 2, from: { unit: 'cup_metric' }, to: { unit: 'l' } }, null)).quantity).toBe(0.5);
    expect(ok(convert({ quantity: 1, from: { unit: 'pint_imp' }, to: { unit: 'fl_oz_imp' } }, null)).quantity).toBe(20);
  });

  it('is exactly reversible at the stated precision for exact factors', () => {
    const there = ok(convert({ quantity: 2.5, from: { unit: 'kg' }, to: { unit: 'g' } }, null));
    const back = ok(convert({ quantity: there.quantity, from: { unit: 'g' }, to: { unit: 'kg' } }, null));
    expect(back.quantity).toBe(2.5);
  });

  it('is deterministic: identical input gives identical output', () => {
    const a = convert({ quantity: 1.37, from: { unit: 'cup_us' }, to: { unit: 'tbsp_metric' } }, null);
    const b = convert({ quantity: 1.37, from: { unit: 'cup_us' }, to: { unit: 'tbsp_metric' } }, null);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('reports the exact factors and registry provenance it used', () => {
    const result = ok(convert({ quantity: 1, from: { unit: 'tbsp_us' }, to: { unit: 'tsp_metric' } }, null));
    expect(result.steps).toEqual([
      { operation: 'unit_to_base', from_unit: 'tbsp_us', to_unit: 'ml', factor: '14.78676478125', applied_as: 'multiply' },
      { operation: 'base_to_unit', from_unit: 'ml', to_unit: 'tsp_metric', factor: '5', applied_as: 'divide' },
    ]);
    expect(result.provenance).toEqual([
      { kind: 'unit_definition', reference: 'tbsp_us', source: 'unit_registry' },
      { kind: 'unit_definition', reference: 'tsp_metric', source: 'unit_registry' },
    ]);
    expect(result.precision).toEqual({ decimal_places: 6, rounding: 'half_up' });
    expect(result.conversion_version).toBe(CONVERSION_VERSION);
    expect(result.confirmation_required).toBe(false);
  });
});

describe('unresolved outcomes (never approximated)', () => {
  it('mass <-> volume without a food is incompatible', () => {
    expect(convert({ quantity: 1, from: { unit: 'g' }, to: { unit: 'ml' } }, null)).toMatchObject({
      status: 'unresolved',
      reason: 'incompatible_dimensions',
    });
  });

  it('mass <-> volume for a food without stored density is unresolved, never assumed to be water', () => {
    expect(convert({ quantity: 1, from: { unit: 'cup_us' }, to: { unit: 'g' } }, noDensity)).toMatchObject({
      status: 'unresolved',
      reason: 'density_unavailable',
    });
  });

  it('ambiguous measures return explicit candidates', () => {
    expect(convert({ quantity: 1, from: { unit: 'cup' }, to: { unit: 'g' } }, food)).toMatchObject({
      status: 'unresolved',
      reason: 'ambiguous_unit',
      candidates: ['cup_us', 'cup_metric', 'cup_us_legal'],
    });
  });

  it('unknown units are reported on either side', () => {
    expect(convert({ quantity: 1, from: { unit: 'handful' }, to: { unit: 'g' } }, food)).toMatchObject({ reason: 'unknown_unit' });
    expect(convert({ quantity: 1, from: { unit: 'g' }, to: { unit: 'pinch' } }, food)).toMatchObject({ reason: 'unknown_unit' });
  });

  it('a serving id that is not one of this food\'s servings is not found', () => {
    expect(convert({ quantity: 1, from: { serving_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }, to: { unit: 'g' } }, food)).toMatchObject({
      reason: 'serving_not_found',
    });
    expect(convert({ quantity: 1, from: { serving_id: SLICE }, to: { unit: 'g' } }, null)).toMatchObject({ reason: 'serving_not_found' });
  });

  it('a serving with a non-canonical unit is invalid reference data', () => {
    expect(convert({ quantity: 1, from: { serving_id: BAD_SERVING }, to: { unit: 'g' } }, food)).toMatchObject({
      reason: 'invalid_reference_data',
    });
  });

  it('a non-zero result that would round to zero is refused rather than returned as 0', () => {
    expect(convert({ quantity: 1, from: { unit: 'mcg' }, to: { unit: 'kg' } }, null)).toMatchObject({
      reason: 'result_rounds_to_zero',
    });
  });
});

describe('serving conversions', () => {
  it('serving -> grams uses the canonical quantity', () => {
    const result = ok(convert({ quantity: 2, from: { serving_id: SLICE }, to: { unit: 'g' } }, food));
    expect(result.quantity).toBe(56);
    expect(result.provenance[0]).toEqual({ kind: 'food_serving', reference: SLICE, source: 'trusted_database' });
  });

  it('grams -> servings divides by the canonical quantity', () => {
    const result = ok(convert({ quantity: 70, from: { unit: 'g' }, to: { serving_id: SLICE } }, food));
    expect(result.quantity).toBe(2.5);
    expect(result.unit).toBe('serving');
    expect(result.serving_id).toBe(SLICE);
  });

  it('serving -> ounces (non-base target)', () => {
    expect(ok(convert({ quantity: 1, from: { serving_id: SLICE }, to: { unit: 'oz' } }, food)).quantity).toBe(0.987671);
  });

  it('volume serving -> grams goes through stored density, with density provenance', () => {
    const result = ok(convert({ quantity: 1, from: { serving_id: CUP_SERVING }, to: { unit: 'g' } }, food));
    expect(result.quantity).toBe(142.32); // 240 ml x 0.593 g/ml
    expect(result.steps.map((s) => s.operation)).toEqual(['serving_to_base', 'density', 'base_to_unit']);
    expect(result.provenance).toContainEqual({ kind: 'food_density', reference: food.food_id, source: 'trusted_database' });
  });

  it('mass -> volume divides by density', () => {
    const result = ok(convert({ quantity: 100, from: { unit: 'g' }, to: { unit: 'ml' } }, food));
    expect(result.quantity).toBe(168.634064); // 100 / 0.593
    expect(result.steps[1]).toMatchObject({ operation: 'density', applied_as: 'divide', factor: '0.593' });
  });

  it('cup_us of a food -> grams', () => {
    expect(ok(convert({ quantity: 1, from: { unit: 'cup_us' }, to: { unit: 'g' } }, food)).quantity).toBe(140.296824);
  });

  it('serving -> serving across dimensions', () => {
    // 1 cup serving (240 ml) = 142.32 g = 5.082857... slices of 28 g
    expect(ok(convert({ quantity: 1, from: { serving_id: CUP_SERVING }, to: { serving_id: SLICE } }, food)).quantity).toBe(5.082857);
  });

  it('flags ai_matched reference data as requiring confirmation', () => {
    const result = ok(convert({ quantity: 1, from: { serving_id: AI_SERVING }, to: { unit: 'g' } }, food));
    expect(result.quantity).toBe(30);
    expect(result.confirmation_required).toBe(true);
    const viaDensity = ok(convert({ quantity: 1, from: { unit: 'ml' }, to: { unit: 'g' } }, { ...food, density: { g_per_ml: 1.03, source: 'ai_matched' } }));
    expect(viaDensity.confirmation_required).toBe(true);
  });
});

describe('request schemas', () => {
  it('requires exactly one of unit / serving_id per endpoint', () => {
    expect(foodConversionSchema.safeParse({ quantity: 1, from: { unit: 'g' }, to: { unit: 'oz' } }).success).toBe(true);
    expect(foodConversionSchema.safeParse({ quantity: 1, from: { unit: 'g', serving_id: SLICE }, to: { unit: 'oz' } }).success).toBe(false);
    expect(foodConversionSchema.safeParse({ quantity: 1, from: {}, to: { unit: 'oz' } }).success).toBe(false);
  });

  it('requires a positive, finite, bounded quantity', () => {
    for (const quantity of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1_000_001, '5']) {
      expect(unitConversionSchema.safeParse({ quantity, from_unit: 'g', to_unit: 'kg' }).success).toBe(false);
    }
    expect(unitConversionSchema.safeParse({ quantity: 1_000_000, from_unit: 'g', to_unit: 'kg' }).success).toBe(true);
  });
});
