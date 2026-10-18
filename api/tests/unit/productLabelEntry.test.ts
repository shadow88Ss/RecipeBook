// Layer 12B.2a unit tests — manufacturer label validation and planning (pure).
// All label values here are invented test data, not real products.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLabelArgs } from '../../src/ingestion/products/cli';
import { buildLabelPlan, LabelPlanError, type LabelFile } from '../../src/ingestion/products/plan';

const EXAMPLE = path.resolve(__dirname, '../../src/ingestion/products/examples/SYNTHETIC-EXAMPLE.label.json');
type Input = Omit<LabelFile, 'label'> & { label: Record<string, unknown> };

const base = (): Input => ({
  schema: 'myrecipebook-product-label-1',
  synthetic: false,
  product: { brand_name: 'Fixture Dairy', product_name: 'Test Labneh', variant_name: null, manufacturer_name: null, market: 'AE', package: { quantity: 400, unit: 'g' } },
  barcode: { code: '4006381333931', format: 'ean_13' },
  label: {
    source: 'physical_manufacturer_label',
    observed_on: '2026-10-18',
    observed_at: null,
    manufacturer_effective_date: null,
    basis: 'per_100g',
    serving: null,
    servings_per_package: null,
    carbohydrate_definition: 'total',
    nutrients: [
      { key: 'energy', amount: 150, unit: 'kcal' },
      { key: 'protein', amount: 8, unit: 'g' },
      { key: 'carbohydrate', amount: 4, unit: 'g' },
      { key: 'fat', amount: 0, unit: 'g' },
    ],
    notes: null,
  },
});
const withLabel = (patch: Record<string, unknown>) => {
  const b = base();
  b.label = { ...b.label, ...patch };
  return b;
};
const problems = (input: unknown) => {
  try {
    buildLabelPlan(input);
  } catch (e) {
    if (e instanceof LabelPlanError) return e.problems.join('\n');
    throw e;
  }
  throw new Error('expected the label to be refused');
};

describe('barcode (C, D, E)', () => {
  it.each([
    ['4006381333931', 'ean_13', '04006381333931'],
    ['036000291452', 'upc_a', '00036000291452'],
    ['96385074', 'ean_8', '00000096385074'],
    ['01234565', 'upc_e', '00012345000065'],
    ['10036000291459', 'gtin_14', '10036000291459'],
    ['4006 3813-33931', 'ean_13', '04006381333931'],
  ])('normalizes %s (%s) to canonical GTIN %s and keeps the submitted digits', (code, format, gtin) => {
    const b = base();
    b.barcode = { code, format: format as LabelFile['barcode']['format'] };
    const plan = buildLabelPlan(b);
    expect(plan.barcode).toEqual({ gtin, barcode_type: format, submitted_code: code.replace(/[\s-]/g, '') });
  });

  it('rejects an invalid GS1 check digit', () => {
    const b = base();
    b.barcode.code = '4006381333932';
    expect(problems(b)).toMatch(/check digit/);
  });

  it.each([
    ['2012345678903', 'store-internal / variable-measure 2x'],
    ['0412345678903', 'restricted circulation 04'],
    ['9812345678902', 'coupon 981'],
    ['02345673', 'restricted-circulation EAN-8 (0 prefix)'],
  ])('rejects the check-digit-valid code %s (%s)', (code) => {
    const b = base();
    b.barcode = { code, format: code.length === 8 ? 'ean_8' : 'ean_13' };
    expect(problems(b)).toMatch(/restricted_circulation/);
  });

  it('rejects a format that does not match the digits', () => {
    const b = base();
    b.barcode.format = 'upc_a';
    expect(problems(b)).toMatch(/upc_a code has 12 digits/);
  });
});

describe('nutrients (K, L, M, N, O)', () => {
  it('stores only canonical keys in their unit, per the label basis; a stated 0 is kept, a missing optional is absent', () => {
    const plan = buildLabelPlan(base());
    expect(plan.label.nutrients).toEqual([
      { key: 'carbohydrate', amount: 4, basis_quantity: 100, basis_unit: 'g' },
      { key: 'energy', amount: 150, basis_quantity: 100, basis_unit: 'g' },
      { key: 'fat', amount: 0, basis_quantity: 100, basis_unit: 'g' },
      { key: 'protein', amount: 8, basis_quantity: 100, basis_unit: 'g' },
    ]);
    expect(plan.label.nutrients.some((n) => n.key === 'fiber')).toBe(false);
  });

  it.each(['energy', 'protein', 'carbohydrate', 'fat'])('refuses a label without %s instead of inventing it', (key) => {
    const b = base();
    (b.label.nutrients as Array<{ key: string }>).splice(
      (b.label.nutrients as Array<{ key: string }>).findIndex((n) => n.key === key),
      1,
    );
    expect(problems(b)).toMatch(new RegExp(`${key}: required`));
  });

  it('refuses kJ-only energy; never converts kJ or computes kcal from macros', () => {
    const b = base();
    (b.label.nutrients as Array<{ key: string; unit: string; amount: number }>)[0] = { key: 'energy', amount: 628, unit: 'kJ' };
    expect(problems(b)).toMatch(/energy in kJ only/);
  });

  it('keeps kcal and reports kJ as not stored when both are on the label', () => {
    const b = base();
    (b.label.nutrients as unknown[]).push({ key: 'energy', amount: 628, unit: 'kJ' });
    const plan = buildLabelPlan(b);
    expect(plan.label.nutrients.find((n) => n.key === 'energy')?.amount).toBe(150);
    expect(plan.notMapped).toEqual(['energy 628 kJ: no approved kJ to kcal conversion']);
  });

  it('does not map "available" carbohydrate to total carbohydrate', () => {
    expect(problems(withLabel({ carbohydrate_definition: 'available' }))).toMatch(/total carbohydrate is required; the label states available/);
  });

  it('reports non-canonical and review-required declarations as not stored; refuses a wrong unit', () => {
    const b = base();
    (b.label.nutrients as unknown[]).push({ key: 'Sugars', amount: 3, unit: 'g' }, { key: 'Salt', amount: 0.5, unit: 'g' }, { key: 'vitamin_d', amount: 1, unit: 'mcg' });
    const plan = buildLabelPlan(b);
    expect(plan.notMapped).toEqual([
      'Sugars 3 g: not a canonical nutrient',
      'Salt 0.5 g: not a canonical nutrient',
      'vitamin_d 1 mcg: the measure needs a mapping review; not mapped by operator entry',
    ]);
    (b.label.nutrients as unknown[]).push({ key: 'sodium', amount: 0.2, unit: 'g' });
    expect(problems(b)).toMatch(/sodium must be in mg/);
  });

  it('refuses a duplicate nutrient', () => {
    const b = base();
    (b.label.nutrients as unknown[]).push({ key: 'protein', amount: 9, unit: 'g' });
    expect(problems(b)).toMatch(/protein is listed twice/);
  });
});

describe('basis and servings (P, Q, R)', () => {
  it('per 100 ml labels use an ml basis', () => {
    const plan = buildLabelPlan(withLabel({ basis: 'per_100ml', serving: { description: '1 glass', quantity: 250, unit: 'ml' } }));
    expect(plan.label.nutrients.every((n) => n.basis_quantity === 100 && n.basis_unit === 'ml')).toBe(true);
    expect(plan.label.servings).toEqual([{ description: '1 glass', quantity: 250, unit: 'ml' }]);
  });

  it('per-serving labels store nutrients per the stated serving mass, with no conversion', () => {
    const plan = buildLabelPlan(withLabel({ basis: 'per_serving', serving: { description: '1 bar', quantity: 45, unit: 'g' } }));
    expect(plan.label.nutrients.every((n) => n.basis_quantity === 45 && n.basis_unit === 'g')).toBe(true);
    expect(plan.label.nutrients.find((n) => n.key === 'energy')?.amount).toBe(150);
    expect(plan.label.servings).toEqual([{ description: '1 bar', quantity: 45, unit: 'g' }]);
  });

  it('refuses a per-serving label whose serving has no stated mass or volume', () => {
    expect(problems(withLabel({ basis: 'per_serving', serving: { description: '1 piece', quantity: null, unit: null } }))).toMatch(/per-serving label needs the serving mass or volume/);
    expect(problems(withLabel({ basis: 'per_serving', serving: null }))).toMatch(/per-serving label needs/);
  });

  it('a per-100 label with an unquantified serving publishes without that serving (warned)', () => {
    const plan = buildLabelPlan(withLabel({ serving: { description: '2 pieces', quantity: null, unit: null } }));
    expect(plan.label.servings).toEqual([]);
    expect(plan.warnings[0]).toMatch(/states no mass or volume/);
  });

  it('does not store a serving in ml when nutrition is per 100 g (no Product density); the label still publishes', () => {
    const plan = buildLabelPlan(withLabel({ serving: { description: '1 tbsp (15ml)', quantity: 15, unit: 'ml' } }));
    expect(plan.label.servings).toEqual([]);
    expect(plan.label.nutrients.every((n) => n.basis_unit === 'g')).toBe(true);
    expect(plan.notMapped).toContain('serving "1 tbsp (15ml)" = 15 ml: nutrition is per g and a Product has no density, so this serving is not stored');
    expect(plan.warnings).toContain('log this Product by g; its ml serving cannot be used');
  });
});

describe('authority and file guards (S, T)', () => {
  it('accepts only a physical manufacturer label as the source', () => {
    for (const source of ['open_food_facts', 'fatsecret', 'usda', 'ai_estimate', 'manufacturer_label']) {
      expect(problems(withLabel({ source }))).toMatch(/label.source/);
    }
  });

  it('has no field for a generic Food, a provider id or a candidate (strict schema)', () => {
    const b = base() as unknown as { product: Record<string, unknown> };
    b.product.food_id = 'a11a0000-0000-4000-8000-000000000001';
    expect(problems(b)).toMatch(/Unrecognized key/);
    const c = base() as unknown as Record<string, unknown>;
    c.external_candidate = { provider_key: 'open_food_facts' };
    expect(problems(c)).toMatch(/Unrecognized key/);
  });

  it('records the provenance (observed date, basis, input hash) and never invents an effective date', () => {
    const plan = buildLabelPlan(withLabel({ observed_at: 'Example shop' }));
    expect(plan.label.effective_from).toBeNull();
    expect(plan.label.provenance_reference).toMatch(/^manufacturer_label \(operator transcription of the physical label\); observed 2026-10-18; at Example shop; basis per_100g; input sha256 [0-9a-f]{16}$/);
  });

  it('the committed example is marked synthetic and plans cleanly', () => {
    const text = readFileSync(EXAMPLE, 'utf8');
    const plan = buildLabelPlan(JSON.parse(text), text);
    expect(plan.synthetic).toBe(true);
    expect(plan.notMapped).toHaveLength(3);
  });

  it('the operator command is a dry run unless --apply with --confirm <gtin>', () => {
    expect(parseLabelArgs(['--file', 'x.json', '--project-ref', 'psundpxqgiknxnjudmxv'])).toMatchObject({ apply: false, confirm: null, newLabelVersion: false });
    expect(() => parseLabelArgs(['--file', 'x.json', '--project-ref', 'psundpxqgiknxnjudmxv', '--apply'])).toThrow(/--confirm/);
    expect(parseLabelArgs(['--file', 'x', '--project-ref', 'local', '--apply', '--confirm', '04006381333931', '--new-label-version'])).toMatchObject({ apply: true, confirm: '04006381333931', newLabelVersion: true });
  });

  it('the label entry code does not import provider integrations', () => {
    for (const f of ['plan.ts', 'apply.ts', 'cli.ts']) {
      expect(readFileSync(path.resolve(__dirname, `../../src/ingestion/products/${f}`), 'utf8')).not.toMatch(/integrations|externalProducts|openFoodFacts|fatsecret/i);
    }
  });
});
