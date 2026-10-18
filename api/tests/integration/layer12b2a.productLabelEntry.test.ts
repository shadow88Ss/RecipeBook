// Layer 12B.2a integration tests — trusted branded Product label entry
// against the real migration chain (Supabase default privileges emulated),
// RLS and the Layer 11A publishing function. Labels here are invented test
// data with brand names prefixed "Fixture" — not real products.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app';
import { logger } from '../../src/lib/logger';
import { applyLabelPlan, LabelConflictError } from '../../src/ingestion/products/apply';
import { buildLabelPlan, type LabelPlan } from '../../src/ingestion/products/plan';
import { PgHarnessProfileRepository } from '../helpers/pgHarnessProfileRepository';
import { PgHarnessScopedDbFactory } from '../helpers/pgHarnessScopedDb';
import { rebuildTestDatabase } from '../helpers/testDb';
import { seedScenario, SEED } from '../helpers/seed';
import { seedNutritionFixtures } from '../helpers/nutritionFixtures';
import { BARCODE, seedProductFixtures } from '../helpers/productFixtures';
import { signTestToken, TEST_JWT_SECRET } from '../helpers/jwt';

let pool: Pool;
let app: ReturnType<typeof createApp>;
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${signTestToken(SEED.accountA)}`);
const get = (p: string, q: Record<string, string> = {}) => auth(request(app).get(p).query(q));
const post = (p: string, body: object) => auth(request(app).post(p)).send(body);

const CODE = { labneh: '6291111111110', bar: '6291111111127', race: '6291111111134', retired: '6291111111141', rollback: '6291111111158', twin: '6291111111165' };
const gtin = (code: string) => `0${code}`;

function label(code: string, overrides: { product?: Record<string, unknown>; label?: Record<string, unknown> } = {}) {
  return buildLabelPlan({
    schema: 'myrecipebook-product-label-1',
    product: { brand_name: 'Fixture Dairy', product_name: `Test Labneh ${code}`, variant_name: 'Full Fat', manufacturer_name: null, market: 'AE', package: { quantity: 400, unit: 'g' }, ...overrides.product },
    barcode: { code, format: 'ean_13' },
    label: {
      source: 'physical_manufacturer_label',
      observed_on: '2026-10-18',
      observed_at: 'Fixture shop',
      basis: 'per_100g',
      serving: { description: '2 tbsp', quantity: 30, unit: 'g' },
      servings_per_package: null,
      carbohydrate_definition: 'total',
      nutrients: [
        { key: 'energy', amount: 180, unit: 'kcal' },
        { key: 'protein', amount: 7, unit: 'g' },
        { key: 'carbohydrate', amount: 4.5, unit: 'g' },
        { key: 'fat', amount: 15, unit: 'g' },
        { key: 'fiber', amount: 0, unit: 'g' },
        { key: 'sodium', amount: 410, unit: 'mg' },
      ],
      ...overrides.label,
    },
  });
}

async function run(plan: LabelPlan, options: { dryRun?: boolean; confirmNewLabelVersion?: boolean } = {}) {
  const client = await pool.connect();
  try {
    return await applyLabelPlan(client, plan, { dryRun: options.dryRun ?? false, confirmNewLabelVersion: options.confirmNewLabelVersion ?? false });
  } finally {
    client.release();
  }
}
async function conflictOf(plan: LabelPlan, options: { confirmNewLabelVersion?: boolean } = {}) {
  try {
    await run(plan, options);
  } catch (e) {
    if (e instanceof LabelConflictError) return e;
    throw e;
  }
  throw new Error('expected a conflict');
}
const counts = async () =>
  (
    await pool.query(
      'select (select count(*)::int from product) as product, (select count(*)::int from barcode) as barcode, (select count(*)::int from product_label_version) as label, (select count(*)::int from product_nutrient) as nutrient, (select count(*)::int from product_serving) as serving',
    )
  ).rows[0] as { product: number; barcode: number; label: number; nutrient: number; serving: number };
const productOf = async (code: string) => (await pool.query('select p.* from product p join barcode b on b.product_id = p.id where b.gtin = $1', [gtin(code)])).rows[0];

beforeAll(async () => {
  pool = await rebuildTestDatabase('recipebook_api_test_layer12b2a');
  await seedScenario(pool);
  await seedNutritionFixtures(pool);
  await seedProductFixtures(pool);
  app = createApp({ profileRepository: new PgHarnessProfileRepository(pool), scopedDbFactory: new PgHarnessScopedDbFactory(pool), jwtSecret: TEST_JWT_SECRET, logger });
}, 120_000);

afterAll(async () => {
  await pool.end();
});

describe('publication (A, B, K, L, M, S, V)', () => {
  it('V: a dry run checks and writes inside a transaction, then leaves nothing behind', async () => {
    const before = await counts();
    const result = await run(label(CODE.labneh), { dryRun: true });
    expect(result).toMatchObject({ outcome: 'created', committed: false, version_number: 1 });
    expect(await counts()).toEqual(before);
  });

  it('A/B: creates the Product, its barcode and label version 1 from the manufacturer label', async () => {
    const before = await counts();
    const result = await run(label(CODE.labneh));
    expect(result).toMatchObject({ outcome: 'created', committed: true, version_number: 1 });
    expect(await counts()).toEqual({ ...before, product: before.product + 1, barcode: before.barcode + 1, label: before.label + 1, nutrient: before.nutrient + 6, serving: before.serving + 1 });

    const p = await productOf(CODE.labneh);
    expect(p).toMatchObject({ brand_name: 'Fixture Dairy', variant_name: 'Full Fat', market: 'AE', package_unit: 'g', food_id: null, source: 'manufacturer_data', status: 'active', current_label_version_id: result.label_version_id });
    expect(Number(p.package_quantity)).toBe(400);
    const { rows: barcodes } = await pool.query('select gtin, barcode_type::text, submitted_code, status::text, source::text from barcode where product_id = $1', [p.id]);
    expect(barcodes).toEqual([{ gtin: gtin(CODE.labneh), barcode_type: 'ean_13', submitted_code: CODE.labneh, status: 'active', source: 'manufacturer_data' }]);
    const { rows: versions } = await pool.query("select version_number, status::text, nutrition_source::text, effective_from, provenance_reference from product_label_version where product_id = $1", [p.id]);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ version_number: 1, status: 'current', nutrition_source: 'manufacturer_label', effective_from: null });
    expect(versions[0].provenance_reference).toMatch(/^manufacturer_label \(operator transcription of the physical label\); observed 2026-10-18; at Fixture shop/);
  });

  it('K/L/M: nutrients keep the label basis; a stated 0 stays 0; an unstated nutrient is absent', async () => {
    const p = await productOf(CODE.labneh);
    const { rows } = await pool.query(
      "select n.canonical_key as key, pn.amount::float as amount, pn.basis_quantity::float as bq, pn.basis_unit, pn.source::text from product_nutrient pn join nutrient n on n.id = pn.nutrient_id where pn.product_id = $1 order by 1",
      [p.id],
    );
    expect(rows.map((r) => [r.key, r.amount])).toEqual([
      ['carbohydrate', 4.5],
      ['energy', 180],
      ['fat', 15],
      ['fiber', 0],
      ['protein', 7],
      ['sodium', 410],
    ]);
    expect(rows.every((r) => r.bq === 100 && r.basis_unit === 'g' && r.source === 'manufacturer_label')).toBe(true);
  });

  it('S: the Product has no generic Food link; nutrition comes only from its label', async () => {
    const p = await productOf(CODE.labneh);
    const calc = await post(`/v1/products/${p.id}/nutrition/calculate`, { quantity: 50, unit: 'g' });
    expect(calc.status).toBe(200);
    expect(calc.body.summary.energy_kcal).toMatchObject({ value: 90 });
    expect(calc.body.summary.fiber_g).toMatchObject({ value: 0, is_zero: true });
    expect(calc.body.summary.potassium_mg?.value ?? null).toBeNull();
  });

  it('Q: a per-serving label stores nutrients per the stated serving mass', async () => {
    const result = await run(
      label(CODE.bar, {
        product: { brand_name: 'Fixture Snacks', product_name: 'Test Date Bar', variant_name: null, package: { quantity: 45, unit: 'g' } },
        label: { basis: 'per_serving', serving: { description: '1 bar', quantity: 45, unit: 'g' } },
      }),
    );
    expect(result.outcome).toBe('created');
    const { rows } = await pool.query('select distinct basis_quantity::float as bq, basis_unit from product_nutrient where label_version_id = $1', [result.label_version_id]);
    expect(rows).toEqual([{ bq: 45, basis_unit: 'g' }]);
    const serving = (await pool.query('select id from product_serving where label_version_id = $1', [result.label_version_id])).rows[0];
    const calc = await post(`/v1/products/${result.product_id}/nutrition/calculate`, { quantity: 1, product_serving_id: serving.id });
    expect(calc.body.summary.energy_kcal).toMatchObject({ value: 180 });
  });
});

describe('idempotency, identity and conflicts (F, G, X)', () => {
  it('G/X: publishing the same label again writes nothing and reports unchanged', async () => {
    const before = await counts();
    const again = await run(label(CODE.labneh, { label: { observed_on: '2026-11-02' } })); // re-read later: same label content
    expect(again).toMatchObject({ outcome: 'unchanged', committed: false });
    expect(await counts()).toEqual(before);
  });

  it('F: a barcode already belonging to another Product stops publication (never reassigned)', async () => {
    const before = await counts();
    const e = await conflictOf(label(BARCODE.yogurtAE));
    expect(e.conflict).toBe('product_identity_mismatch');
    expect(e.details.join('\n')).toMatch(/brand_name: stored "Fixture/);
    expect(await counts()).toEqual(before);
    const owner = await pool.query("select p.brand_name from barcode b join product p on p.id = b.product_id where b.gtin = '04006381333931'");
    expect(owner.rows[0].brand_name).not.toBe('Fixture Dairy');
  });

  it('a different identity for the same barcode is refused, even with --new-label-version', async () => {
    const e = await conflictOf(label(CODE.labneh, { product: { product_name: 'Renamed Labneh' } }), { confirmNewLabelVersion: true });
    expect(e.conflict).toBe('product_identity_mismatch');
  });

  it('the same Product identity under a new barcode is refused as a possible duplicate', async () => {
    const e = await conflictOf(label(CODE.twin, { product: { product_name: `Test Labneh ${CODE.labneh}` } }));
    expect(e.conflict).toBe('possible_duplicate_product');
  });

  it('a retired barcode is never reused for another Product', async () => {
    const first = await run(label(CODE.retired, { product: { product_name: 'Retiring Product' } }));
    await pool.query("update barcode set status = 'retired', retired_at = now(), retired_reason = 'test' where gtin = $1", [gtin(CODE.retired)]);
    const e = await conflictOf(label(CODE.retired, { product: { product_name: 'Different Product' } }));
    expect(e.conflict).toBe('barcode_previously_retired');
    expect(e.details[0]).toContain(first.product_id);
  });
});

describe('label versioning (H, I, J)', () => {
  const revised = () => label(CODE.labneh, { label: { observed_on: '2026-12-01', nutrients: [
    { key: 'energy', amount: 170, unit: 'kcal' },
    { key: 'protein', amount: 7.5, unit: 'g' },
    { key: 'carbohydrate', amount: 4.5, unit: 'g' },
    { key: 'fat', amount: 13, unit: 'g' },
    { key: 'fiber', amount: 0, unit: 'g' },
  ] } });

  it('H: a changed label stops unless the operator confirms a genuine new version', async () => {
    const before = await counts();
    const e = await conflictOf(revised());
    expect(e.conflict).toBe('label_changed_needs_confirmation');
    expect(e.details.join('\n')).toMatch(/energy: stored 180 per 100 g, file 170 per 100 g/);
    expect(e.details.join('\n')).toMatch(/sodium: on the current label, not in the file/);
    expect(await counts()).toEqual(before);
  });

  it('H/J: confirmed, it publishes version 2 and makes it current', async () => {
    const p = await productOf(CODE.labneh);
    const v1 = p.current_label_version_id;
    const result = await run(revised(), { confirmNewLabelVersion: true });
    expect(result).toMatchObject({ outcome: 'new_label_version', committed: true, version_number: 2, product_id: p.id });
    const { rows } = await pool.query('select id, version_number, status::text, superseded_by_label_version_id from product_label_version where product_id = $1 order by version_number', [p.id]);
    expect(rows).toEqual([
      { id: v1, version_number: 1, status: 'superseded', superseded_by_label_version_id: result.label_version_id },
      { id: result.label_version_id, version_number: 2, status: 'current', superseded_by_label_version_id: null },
    ]);
    expect((await productOf(CODE.labneh)).current_label_version_id).toBe(result.label_version_id);
    expect((await run(revised())).outcome).toBe('unchanged'); // and it is idempotent from then on
  });

  it('I: version 1 stays exactly as published and cannot be changed', async () => {
    const p = await productOf(CODE.labneh);
    const v1 = (await pool.query('select id from product_label_version where product_id = $1 and version_number = 1', [p.id])).rows[0].id;
    const { rows } = await pool.query("select n.canonical_key as key, pn.amount::float as amount from product_nutrient pn join nutrient n on n.id = pn.nutrient_id where pn.label_version_id = $1 and n.canonical_key in ('energy', 'sodium') order by 1", [v1]);
    expect(rows).toEqual([
      { key: 'energy', amount: 180 },
      { key: 'sodium', amount: 410 },
    ]);
    await expect(pool.query('update product_nutrient set amount = 1 where label_version_id = $1', [v1])).rejects.toThrow();
    await expect(pool.query("update product_label_version set effective_from = '2020-01-01' where id = $1", [v1])).rejects.toThrow(/immutable/);
    await expect(pool.query('delete from product_label_version where id = $1', [v1])).rejects.toThrow();
    const energy = (await pool.query("select id from nutrient where canonical_key = 'potassium'")).rows[0].id;
    await expect(pool.query("insert into product_nutrient (label_version_id, product_id, nutrient_id, amount, basis_quantity, basis_unit, source) values ($1, $2, $3, 1, 100, 'g', 'manufacturer_label')", [v1, p.id, energy])).rejects.toThrow(/sealed/);
  });
});

describe('transactions and concurrency (W, Y)', () => {
  it('W: a failure part-way rolls back the whole publication', async () => {
    const before = await counts();
    const plan = label(CODE.rollback, { product: { product_name: 'Rollback Product' } });
    plan.label.servings = [{ description: 'broken', quantity: -1, unit: 'g' }]; // bypasses validation; the database refuses it
    await expect(run(plan)).rejects.toThrow();
    expect(await counts()).toEqual(before);
    expect((await pool.query("select count(*)::int as n from product where product_name = 'Rollback Product'")).rows[0].n).toBe(0);
  });

  it('Y: two concurrent publications of the same new label produce exactly one Product', async () => {
    const plan = label(CODE.race, { product: { product_name: 'Race Product' } });
    const outcomes = (await Promise.all([run(plan), run(plan)])).map((r) => r.outcome).sort();
    expect(outcomes).toEqual(['created', 'unchanged']);
    const { rows } = await pool.query(
      "select (select count(*)::int from product where product_name = 'Race Product') as products, (select count(*)::int from barcode where gtin = $1) as barcodes, (select count(*)::int from product_label_version v join barcode b on b.product_id = v.product_id where b.gtin = $1) as labels",
      [gtin(CODE.race)],
    );
    expect(rows[0]).toEqual({ products: 1, barcodes: 1, labels: 1 });
  });
});

describe('security (U)', () => {
  async function asAuthenticated(sql: string, params: unknown[] = []) {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('request.jwt.claim.sub', $1, true)", [SEED.accountA]);
      await client.query('set local role authenticated');
      return await client.query(sql, params);
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  }

  it.each([
    ["insert into product (brand_name, product_name, source) values ('x', 'y', 'manufacturer_data')"],
    ["update product set brand_name = 'x'"],
    ['delete from product'],
    ["insert into barcode (product_id, gtin, barcode_type, source) select id, '06291111111110', 'ean_13', 'manufacturer_data' from product limit 1"],
    ["update barcode set status = 'retired', retired_at = now(), retired_reason = 'x'"],
    ["select publish_product_label_version((select id from product limit 1), 'manufacturer_label', null, null, '[]'::jsonb, '[]'::jsonb)"],
    ["insert into product_label_version (product_id, version_number, nutrition_source) select id, 0, 'manufacturer_label' from product limit 1"],
    ["insert into product_nutrient (label_version_id, product_id, nutrient_id, amount, basis_quantity, basis_unit, source) select v.id, v.product_id, (select id from nutrient limit 1), 1, 100, 'g', 'manufacturer_label' from product_label_version v limit 1"],
    ["insert into product_serving (label_version_id, product_id, serving_description, canonical_quantity, canonical_unit, source) select v.id, v.product_id, 'x', 1, 'g', 'manufacturer_label' from product_label_version v limit 1"],
  ])('ordinary users still cannot write: %s', async (sql) => {
    await expect(asAuthenticated(sql)).rejects.toThrow(/permission denied/);
  });
});

describe('Z: the published Product works through the existing API, unchanged', () => {
  it('barcode lookup -> internal Product (authoritative label) -> serving -> log -> Daily Tracker', async () => {
    const lookup = await get(`/v1/products/barcode/${CODE.labneh}/lookup`);
    expect(lookup.status).toBe(200);
    expect(lookup.body).toMatchObject({ source: 'internal', candidates: [] });
    const productId = lookup.body.product.id;
    const detail = await get(`/v1/products/${productId}`);
    expect(detail.status).toBe(200);
    const serving = detail.body.current_label.servings.find((s: { serving_description: string }) => s.serving_description === '2 tbsp');
    expect(serving).toMatchObject({ canonical_quantity: 30, canonical_unit: 'g' });

    const date = new Date().toISOString().slice(0, 10);
    const logged = await post(`/v1/profiles/${SEED.profileA}/meals`, {
      meal_type: 'breakfast',
      logged_date: date,
      local_timezone: 'UTC',
      consumed_at: new Date().toISOString(),
      items: [{ type: 'product', barcode: CODE.labneh, quantity: 2, product_serving_id: serving.id }],
    });
    expect(logged.status).toBe(201);
    // version 2 is current: 170 kcal / 100 g x 60 g
    const tracker = await get(`/v1/profiles/${SEED.profileA}/daily-tracker`, { date, timezone: 'UTC' });
    expect(tracker.body.actual.summary.energy_kcal.value).toBe(102);
  });

  it('existing fixture Products and their barcodes are untouched', async () => {
    const res = await get(`/v1/products/barcode/${BARCODE.yogurtAE}`);
    expect(res.status).toBe(200);
    expect(res.body.product.brand_name).not.toBe('Fixture Dairy');
  });
});
