// Layer 11A integration tests — Product & Barcode foundation against the
// real migration chain and RLS harness. TEST FIXTURES ONLY (see
// tests/helpers/productFixtures.ts).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app';
import { logger } from '../../src/lib/logger';
import { isProductIdentity } from '../../src/domain/products/barcode';
import { PgHarnessProfileRepository } from '../helpers/pgHarnessProfileRepository';
import { PgHarnessScopedDbFactory } from '../helpers/pgHarnessScopedDb';
import { rebuildTestDatabase } from '../helpers/testDb';
import { seedScenario, SEED } from '../helpers/seed';
import { F, NUT, seedNutritionFixtures } from '../helpers/nutritionFixtures';
import { addBarcode, BARCODE, LABEL, P, publishLabel, SERVING, seedProductFixtures } from '../helpers/productFixtures';
import { signTestToken, TEST_JWT_SECRET } from '../helpers/jwt';

let pool: Pool;
let app: ReturnType<typeof createApp>;

const as = (account: string) => ({
  get: (path: string, query: Record<string, string> = {}) => request(app).get(path).query(query).set('Authorization', `Bearer ${signTestToken(account)}`),
  post: (path: string, body: unknown = {}) => request(app).post(path).set('Authorization', `Bearer ${signTestToken(account)}`).send(body as object),
});
const A = () => as(SEED.accountA);
const calc = (product: string, body: Record<string, unknown>) => A().post(`/v1/products/${product}/nutrition/calculate`, body);
type N = { nutrient_key: string; status: string; value: number | null; is_zero: boolean; source: { source: string; authority: string; basis_quantity: number; basis_unit: string; product_nutrient_id: string } | null; excluded: unknown[]; conversion_reason: string | null };
const nutrient = (body: { nutrients: N[] }, key: string) => body.nutrients.find((n) => n.nutrient_key === key) as N;

async function asAuthenticated<T>(account: string, fn: (q: (sql: string, params?: unknown[]) => Promise<unknown>) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [account]);
    await client.query('set local role authenticated');
    return await fn((sql, params) => client.query(sql, params as unknown[]));
  } finally {
    await client.query('rollback');
    client.release();
  }
}

const worldState = async () =>
  (
    await pool.query(`select
      (select md5(coalesce(string_agg(to_jsonb(f)::text, ',' order by id), '')) from food f) as foods,
      (select md5(coalesce(string_agg(to_jsonb(n)::text, ',' order by id), '')) from food_nutrient n) as food_nutrients,
      (select md5(coalesce(string_agg(to_jsonb(s)::text, ',' order by id), '')) from food_serving s) as food_servings,
      (select md5(coalesce(string_agg(to_jsonb(p)::text, ',' order by id), '')) from product p) as products,
      (select md5(coalesce(string_agg(to_jsonb(n)::text, ',' order by id), '')) from product_nutrient n) as product_nutrients,
      (select md5(coalesce(string_agg(to_jsonb(b)::text, ',' order by id), '')) from barcode b) as barcodes,
      (select count(*)::int from meal_log) as meal_logs,
      (select count(*)::int from meal_item) as meal_items,
      (select count(*)::int from recipe) as recipes,
      (select count(*)::int from meal_plan) as plans,
      (select count(*)::int from grocery_list) as grocery_lists`)
  ).rows[0];

beforeAll(async () => {
  pool = await rebuildTestDatabase('recipebook_api_test_layer11a');
  await seedScenario(pool);
  await seedNutritionFixtures(pool);
  await seedProductFixtures(pool);
  app = createApp({ profileRepository: new PgHarnessProfileRepository(pool), scopedDbFactory: new PgHarnessScopedDbFactory(pool), jwtSecret: TEST_JWT_SECRET, logger });
}, 120_000);

afterAll(async () => {
  await pool.end();
});

describe('product identity, barcodes and Food relationship (A-G, W, X)', () => {
  it('A/G: a trusted Product fixture reads back with package, generic Food, barcodes, current label and provenance', async () => {
    const res = await A().get(`/v1/products/${P.yogurtAE}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: P.yogurtAE,
      brand_name: 'Fixture Brand X',
      product_name: 'Greek Yogurt',
      variant_name: 'Plain',
      display_name: 'Fixture Brand X Greek Yogurt Plain',
      market: 'AE',
      package: { quantity: 500, unit: 'g' },
      status: 'active',
      generic_food: { id: F.milk, canonical_name: 'fixture5b_milk', relationship: 'generic_category_only' },
      source: 'manufacturer_data',
      barcodes: [{ gtin: '04006381333931', barcode_type: 'ean_13', status: 'active', source: 'manufacturer_data' }],
      current_label: { id: LABEL.yogurtAE, version_number: 1, status: 'current', nutrition_source: 'manufacturer_label', authority: 'exact_product' },
    });
    expect(res.body.current_label.servings).toEqual([expect.objectContaining({ serving_description: '1 portion', canonical_quantity: 150, canonical_unit: 'g', source: 'manufacturer_label' })]);
    expect(res.body).not.toHaveProperty('current_label_version_id');
  });

  it('S/P/Q: label nutrients use canonical 5C keys; a label 0 is a known zero; an absent nutrient stays missing', async () => {
    const label = (await A().get(`/v1/products/${P.yogurtAE}`)).body.current_label;
    expect(label.nutrients.map((n: { nutrient_key: string }) => n.nutrient_key)).toEqual(['carbohydrate', 'energy', 'fat', 'protein', 'sodium']);
    expect(label.nutrients.find((n: { nutrient_key: string }) => n.nutrient_key === 'fat')).toMatchObject({ amount: 0, is_zero: true, unit: 'g' });
    expect(label.completeness.missing_nutrient_keys).toContain('fiber');
    const vocabulary = (await pool.query('select canonical_key from nutrient')).rows.map((r) => r.canonical_key);
    for (const n of label.nutrients) expect(vocabulary).toContain(n.nutrient_key);
  });

  it('F/V/D: barcode lookup is exact after canonical normalization, for every supported format', async () => {
    const cases: Array<[string, Record<string, string>, string, string]> = [
      [BARCODE.yogurtAE, {}, P.yogurtAE, '04006381333931'],
      ['4006 3813 33931', {}, P.yogurtAE, '04006381333931'],
      [BARCODE.yogurtUS, {}, P.yogurtUS, '00036000291452'],
      ['0036000291452', {}, P.yogurtUS, '00036000291452'], // the UPC-A written as EAN-13
      [BARCODE.bar, { type: 'ean_8' }, P.bar, '00000096385074'],
      [BARCODE.barCase, {}, P.bar, '10036000291459'],
      [BARCODE.drinkUpcE, { type: 'upc_e' }, P.drink, '00012345000065'],
      ['012345000065', {}, P.drink, '00012345000065'], // UPC-E and its UPC-A find the same product
    ];
    for (const [code, query, product, gtin] of cases) {
      const res = await A().get(`/v1/products/barcode/${encodeURIComponent(code)}`, query);
      expect(res.status, code).toBe(200);
      expect(res.body.match).toMatchObject({ canonical_gtin: gtin, match: 'exact_canonical_gtin' });
      expect(res.body.product.id).toBe(product);
    }
    const again = await A().get(`/v1/products/barcode/${BARCODE.yogurtAE}`);
    expect(again.body).toEqual((await A().get(`/v1/products/barcode/${BARCODE.yogurtAE}`)).body);
  });

  it('C: an invalid check digit, an ambiguous 8-digit code and a restricted code are 400, never looked up', async () => {
    for (const [code, query, reason] of [
      ['4006381333932', {}, 'invalid_check_digit'],
      [BARCODE.bar, {}, 'ambiguous_format'],
      ['2012345678903', {}, 'restricted_circulation'],
      ['abc', {}, 'invalid_characters'],
    ] as Array<[string, Record<string, string>, string]>) {
      const res = await A().get(`/v1/products/barcode/${code}`, query);
      expect(res.status).toBe(400);
      expect(res.body.error.details.reason).toBe(reason);
    }
    expect((await A().get('/v1/products/barcode/5901234123457')).status).toBe(404); // valid, unknown
  });

  it('D: the database accepts only canonical, check-digit-valid product GTINs (same rule as the API)', async () => {
    for (const gtin of ['04006381333931', '04006381333932', '02012345678903', '00000096385074', '00000000123457', '95901234123450', '1234']) {
      const db = (await pool.query('select gtin_is_product_identity($1) as ok', [gtin])).rows[0].ok;
      expect(db, gtin).toBe(isProductIdentity(gtin));
    }
    await expect(pool.query("insert into barcode (product_id, gtin, barcode_type, source) values ($1, '04006381333932', 'ean_13', 'manufacturer_data')", [P.crackers])).rejects.toThrow(
      /barcode_gtin_check/,
    );
    await expect(pool.query("insert into barcode (product_id, gtin, barcode_type, source) values ($1, '05901234123457', 'ean_8', 'manufacturer_data')", [P.crackers])).rejects.toThrow(
      /barcode_type_shape/,
    );
  });

  it('E: a duplicate active barcode is rejected by the database, including its UPC/EAN-equivalent form', async () => {
    await expect(addBarcode(pool, P.crackers, BARCODE.yogurtAE)).rejects.toMatchObject({ constraint: 'uq_barcode_active_gtin' });
    await expect(addBarcode(pool, P.crackers, '0036000291452')).rejects.toMatchObject({ constraint: 'uq_barcode_active_gtin' });
  });

  it('G5: a barcode is never deleted or re-pointed; retirement keeps the row and its provenance', async () => {
    const barcodeId = await addBarcode(pool, P.crackers, '5901234123457');
    await expect(pool.query('update barcode set product_id = $2 where id = $1', [barcodeId, P.granola])).rejects.toThrow(/barcode identity is immutable/);
    await expect(pool.query('delete from barcode where id = $1', [barcodeId])).rejects.toThrow(/append-only/);
    await pool.query("update barcode set status = 'retired', retired_at = now(), retired_reason = 'fixture: withdrawn' where id = $1", [barcodeId]);
    const row = (await pool.query('select product_id, gtin, status, source, provenance_reference from barcode where id = $1', [barcodeId])).rows[0];
    expect(row).toMatchObject({ product_id: P.crackers, gtin: '05901234123457', status: 'retired', source: 'manufacturer_data', provenance_reference: 'fixture' });
    expect((await A().get('/v1/products/barcode/5901234123457')).status).toBe(404); // retired codes are not matched
    // a trusted workflow may later attach the GTIN to another Product as a NEW row
    await addBarcode(pool, P.granola, '5901234123457');
    expect((await A().get('/v1/products/barcode/5901234123457')).body.product.id).toBe(P.granola);
    const crackers = (await A().get(`/v1/products/${P.crackers}`)).body;
    expect(crackers.barcodes).toEqual([expect.objectContaining({ gtin: '05901234123457', status: 'retired' })]);
  });

  it('W/X: same name with a different barcode and market stays two Products with their own labels', async () => {
    const ae = (await A().get(`/v1/products/barcode/${BARCODE.yogurtAE}`)).body.product;
    const us = (await A().get(`/v1/products/barcode/${BARCODE.yogurtUS}`)).body.product;
    expect([ae.display_name, us.display_name]).toEqual(['Fixture Brand X Greek Yogurt Plain', 'Fixture Brand X Greek Yogurt Plain']);
    expect(ae.id).not.toBe(us.id);
    expect([ae.market, us.market]).toEqual(['AE', 'US']);
    expect(ae.current_label.nutrients.find((n: { nutrient_key: string }) => n.nutrient_key === 'protein').amount).toBe(9);
    expect(us.current_label.nutrients.find((n: { nutrient_key: string }) => n.nutrient_key === 'protein').amount).toBe(10);
  });
});

describe('product search (U)', () => {
  it('U: text search is deterministic: exact > prefix > contains, then brand, name, variant, market, id', async () => {
    const res = await A().get('/v1/products', { q: 'greek yogurt' });
    expect(res.status).toBe(200);
    expect(res.body.data.map((p: { id: string; match: { kind: string } }) => [p.id, p.match.kind])).toEqual([
      [P.yogurtAE, 'exact'],
      [P.yogurtUS, 'exact'],
    ]);
    const bar = await A().get('/v1/products', { q: 'fixture brand' });
    expect(bar.body.data.map((p: { brand_name: string }) => p.brand_name)).toEqual([
      'Fixture Brand V',
      'Fixture Brand W',
      'Fixture Brand X',
      'Fixture Brand X',
      'Fixture Brand Y',
      'Fixture Brand Z',
    ]);
    expect((await A().get('/v1/products', { q: 'drink' })).body.data.map((p: { id: string }) => p.id)).toEqual([P.drink]);
    expect((await A().get('/v1/products', { q: 'yogurt', market: 'us' })).body.data.map((p: { id: string }) => p.id)).toEqual([P.yogurtUS]);
    const first = await A().get('/v1/products', { q: 'fixture' });
    expect((await A().get('/v1/products', { q: 'fixture' })).body).toEqual(first.body);
    expect((await A().get('/v1/products', { q: 'yoghurt' })).body.data).toEqual([]); // no fuzzy matching
  });
});

describe('exact Product nutrition (H-R, J, AB, AC)', () => {
  it('I/L/O: manufacturer label wins for the exact Product (per 100 g basis); package size is not the serving', async () => {
    const res = await calc(P.yogurtAE, { quantity: 150, unit: 'g' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ nutrition_scope: 'exact_product', generic_food_fallback: 'none', label_status: 'authoritative_label', label_version: { id: LABEL.yogurtAE } });
    expect(nutrient(res.body, 'protein')).toMatchObject({ status: 'resolved', value: 13.5, source: { source: 'manufacturer_label', authority: 'exact_product', basis_quantity: 100, basis_unit: 'g' } });
    expect(nutrient(res.body, 'energy').value).toBe(145.5);
    const serving = await calc(P.yogurtAE, { quantity: 1, product_serving_id: SERVING.yogurtAE });
    expect(nutrient(serving.body, 'protein').value).toBe(13.5); // the 150 g label serving, not the 500 g package
  });

  it('H: Product label nutrition is not in FoodNutrient and never changes the generic Food', async () => {
    const labelRows = (await pool.query('select id from product_nutrient where product_id = $1', [P.yogurtAE])).rows.map((r) => r.id);
    expect((await pool.query('select count(*)::int as n from food_nutrient where id = any($1::uuid[])', [labelRows])).rows[0].n).toBe(0);
    const generic = await A().post('/v1/nutrition/calculate', { items: [{ food_id: F.milk, quantity: 100, unit: 'ml' }] });
    expect(generic.body.items[0].nutrients.find((n: { nutrient_key: string }) => n.nutrient_key === 'protein')).toMatchObject({ value: 3.4, source: { source: 'trusted_database' } });
  });

  it('K/M: per-serving basis (per 1 bar = 60 g) scales exactly', async () => {
    const two = await calc(P.bar, { quantity: 2, product_serving_id: SERVING.bar });
    expect(nutrient(two.body, 'energy')).toMatchObject({ value: 440, source: { basis_quantity: 60, basis_unit: 'g' } });
    const grams = await calc(P.bar, { quantity: 20, unit: 'g' });
    expect(nutrient(grams.body, 'protein').value).toBe(6.666667); // 20 x 20/60, exact then rounded once
  });

  it('N: per-volume basis (per 250 ml); no density is borrowed from the generic Food (G6)', async () => {
    expect(nutrient((await calc(P.drink, { quantity: 1, unit: 'l' })).body, 'energy').value).toBe(480);
    expect(nutrient((await calc(P.drink, { quantity: 1, product_serving_id: SERVING.drink })).body, 'protein').value).toBe(2.5);
    const byMass = await calc(P.drink, { quantity: 100, unit: 'g' }); // generic milk HAS a density; the product does not
    expect(nutrient(byMass.body, 'energy')).toMatchObject({ status: 'basis_unreconcilable', value: null, conversion_reason: 'density_unavailable' });
  });

  it('P/Q/R: known zero, missing nutrient, and a partial label', async () => {
    const res = await calc(P.yogurtAE, { quantity: 200, unit: 'g' });
    expect(nutrient(res.body, 'fat')).toMatchObject({ status: 'resolved', value: 0, is_zero: true });
    expect(nutrient(res.body, 'fiber')).toMatchObject({ status: 'no_data', value: null });
    expect(res.body.summary.fiber_g).toMatchObject({ value: null, coverage: 'unavailable' });
    expect(res.body.summary.fat_g).toMatchObject({ value: 0, is_zero: true, coverage: 'complete' });
    expect(res.body.coverage_summary.unavailable).toBeGreaterThan(0);
  });

  it('J: missing Product nutrition never falls back to the generic Food', async () => {
    const res = await calc(P.crackers, { quantity: 50, unit: 'g' }); // generic bread has full trusted nutrition
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ label_version: null, label_status: 'no_label_version', generic_food_fallback: 'none' });
    for (const n of res.body.nutrients as N[]) expect(n).toMatchObject({ status: 'no_data', value: null, source: null });
    expect(res.body.coverage_summary).toMatchObject({ complete: 0, partial: 0 });
  });

  it('G3: a third-party product-database label is shown but not authoritative', async () => {
    const res = await calc(P.granola, { quantity: 100, unit: 'g' });
    expect(res.body.label_status).toBe('non_authoritative_label');
    expect(nutrient(res.body, 'energy')).toMatchObject({
      status: 'not_authoritative',
      value: null,
      excluded: [{ source: 'third_party_product_database', authority: 'non_authoritative_product_source', reason: 'not_authoritative_for_product' }],
    });
    const detail = (await A().get(`/v1/products/${P.granola}`)).body;
    expect(detail.current_label).toMatchObject({ nutrition_source: 'third_party_product_database', authority: 'non_authoritative_product_source' });
  });

  it('T: ProductServing creates no FoodServing; label rows cannot be edited after publication', async () => {
    expect((await pool.query("select count(*)::int as n from food_serving where serving_description in ('1 bar', '1 portion', '1 bowl')")).rows[0].n).toBe(0);
    await expect(pool.query('update product_nutrient set amount = 1 where product_id = $1', [P.bar])).rejects.toThrow(/immutable/);
    await expect(
      pool.query("insert into product_nutrient (label_version_id, product_id, nutrient_id, amount, basis_quantity, basis_unit, source) values ($1, $2, $3, 1, 100, 'g', 'manufacturer_label')", [LABEL.bar, P.bar, NUT.fiber]),
    ).rejects.toMatchObject({ constraint: 'product_label_version_sealed' });
    await expect(pool.query("update product_label_version set nutrition_source = 'third_party_product_database' where id = $1", [LABEL.bar])).rejects.toMatchObject({
      constraint: 'product_label_version_immutable',
    });
  });

  it('G1: a new label version supersedes the old one; the old label stays readable and calculable', async () => {
    const v2 = await publishLabel(pool, P.bar, 'manufacturer_label', [{ nutrient_id: NUT.energy, amount: 200, basis_quantity: 60, basis_unit: 'g' }], [
      { serving_description: '1 bar', canonical_quantity: 55, canonical_unit: 'g' },
    ], 'fixture-label-2027');
    const detail = (await A().get(`/v1/products/${P.bar}`)).body;
    expect(detail.current_label).toMatchObject({ id: v2, version_number: 2, status: 'current', provenance_reference: 'fixture-label-2027' });
    expect(detail.label_versions.map((l: { version_number: number; status: string }) => [l.version_number, l.status])).toEqual([
      [2, 'current'],
      [1, 'superseded'],
    ]);
    expect(detail.label_versions[1]).toMatchObject({ id: LABEL.bar, superseded_by_label_version_id: v2 });
    expect(nutrient((await calc(P.bar, { quantity: 60, unit: 'g' })).body, 'energy').value).toBe(200);
    const old = await calc(P.bar, { quantity: 60, unit: 'g', label_version_id: LABEL.bar });
    expect(old.body.label_version).toMatchObject({ id: LABEL.bar, status: 'superseded' });
    expect(nutrient(old.body, 'energy').value).toBe(220);
    expect(nutrient(old.body, 'protein').value).toBe(20);
    // a serving of the old label cannot be used with the new one
    expect((await calc(P.bar, { quantity: 1, product_serving_id: SERVING.bar })).status).toBe(400);
    expect((await A().post(`/v1/products/${P.bar}/nutrition/calculate`, { quantity: 1, unit: 'g', label_version_id: LABEL.yogurtAE })).status).toBe(400);
  });

  it('AB/AC: calculation, lookup and search mutate nothing (Food, FoodNutrient, Product, Meal, Recipe, Plan, Grocery)', async () => {
    const before = await worldState();
    await calc(P.yogurtAE, { quantity: 150, unit: 'g' });
    await calc(P.crackers, { quantity: 50, unit: 'g' });
    await A().get(`/v1/products/barcode/${BARCODE.yogurtAE}`);
    await A().get('/v1/products', { q: 'fixture' });
    expect(await worldState()).toEqual(before);
  });

  it('17: energy is the stored label kcal value; nothing is derived from macros', async () => {
    const res = await A().post(`/v1/products/${P.granola}/nutrition/calculate`, { quantity: 100, unit: 'g' });
    expect(nutrient(res.body, 'energy').value).toBeNull(); // not authoritative -> not computed from protein/carb/fat either
    const drink = await calc(P.drink, { quantity: 250, unit: 'ml' });
    expect(nutrient(drink.body, 'energy').value).toBe(120);
    expect(nutrient(drink.body, 'fat').status).toBe('no_data');
  });
});

describe('security (Y, Z, AA, 24)', () => {
  it('AA: every Product API requires authentication', async () => {
    for (const res of [
      await request(app).get('/v1/products'),
      await request(app).get(`/v1/products/${P.bar}`),
      await request(app).get(`/v1/products/barcode/${BARCODE.yogurtAE}`),
      await request(app).post(`/v1/products/${P.bar}/nutrition/calculate`).send({ quantity: 1, unit: 'g' }),
    ]) {
      expect(res.status).toBe(401);
    }
  });

  it('Z: an unrelated authenticated Account reads the global Product reference data', async () => {
    expect((await as(SEED.accountUnrelated).get(`/v1/products/${P.yogurtAE}`)).status).toBe(200);
    expect((await as(SEED.accountUnrelated).get(`/v1/products/barcode/${BARCODE.yogurtAE}`)).body.product.id).toBe(P.yogurtAE);
  });

  it('Y: an ordinary authenticated client cannot write Product, label, nutrient, serving or barcode rows', async () => {
    const attempts = [
      "insert into product (brand_name, product_name, source) values ('x', 'y', 'trusted_ingestion')",
      `update product set brand_name = 'x' where id = '${P.bar}'`,
      `insert into barcode (product_id, gtin, barcode_type, source) values ('${P.crackers}', '04006381333931', 'ean_13', 'manufacturer_data')`,
      `update barcode set status = 'retired', retired_at = now(), retired_reason = 'x' where product_id = '${P.bar}'`,
      `insert into product_nutrient (label_version_id, product_id, nutrient_id, amount, basis_quantity, basis_unit, source) values ('${LABEL.yogurtAE}', '${P.yogurtAE}', '${NUT.fiber}', 1, 100, 'g', 'manufacturer_label')`,
      `select publish_product_label_version('${P.crackers}', 'manufacturer_label', 'x', null, '[]', '[]')`,
    ];
    for (const sql of attempts) {
      await expect(asAuthenticated(SEED.accountA, (q) => q(sql))).rejects.toThrow(/permission denied/);
    }
    const reads = await asAuthenticated(SEED.accountA, (q) => q('select count(*)::int as n from product') as Promise<{ rows: Array<{ n: number }> }>);
    expect(reads.rows[0]?.n).toBe(6);
  });

  it('no client write endpoint exists for products or barcodes', async () => {
    expect((await A().post('/v1/products', { brand_name: 'x' })).status).toBe(404);
    expect((await request(app).patch(`/v1/products/${P.bar}`).set('Authorization', `Bearer ${signTestToken(SEED.accountA)}`).send({})).status).toBe(404);
    expect((await request(app).delete(`/v1/products/${P.bar}`).set('Authorization', `Bearer ${signTestToken(SEED.accountA)}`)).status).toBe(404);
  });
});
