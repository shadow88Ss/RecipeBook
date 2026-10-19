// Layer 12B.3 integration tests — the four manufacturer-label nutrient
// identities (migration 20261019120000), against the real migration chain.
// The database is first built as it stood BEFORE the migration, with a
// published US-style label and a logged meal, so historical integrity is
// tested across the actual migration. Label values are invented test data
// (brands prefixed "Fixture"), not real products.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app';
import { logger } from '../../src/lib/logger';
import { applyLabelPlan } from '../../src/ingestion/products/apply';
import { buildLabelPlan } from '../../src/ingestion/products/plan';
import { PgHarnessProfileRepository } from '../helpers/pgHarnessProfileRepository';
import { PgHarnessScopedDbFactory } from '../helpers/pgHarnessScopedDb';
import { MIGRATIONS_DIR, rebuildTestDatabase } from '../helpers/testDb';
import { seedScenario, SEED } from '../helpers/seed';
import { seedNutritionFixtures } from '../helpers/nutritionFixtures';
import { signTestToken, TEST_JWT_SECRET } from '../helpers/jwt';

const MIGRATION_49 = '20261019120000_label_nutrient_vocabulary.sql';
const US_CODE = '6291111111172';
const EU_CODE = '6291111111189';
const NEW_KEYS = ['added_sugars', 'available_carbohydrate', 'saturated_fat', 'total_sugars'];

let pool: Pool;
let app: ReturnType<typeof createApp>;
const auth = (r: request.Test) => r.set('Authorization', `Bearer ${signTestToken(SEED.accountA)}`);
const get = (p: string, q: Record<string, string> = {}) => auth(request(app).get(p).query(q));
const post = (p: string, body: object) => auth(request(app).post(p)).send(body);
const DATE = new Date().toISOString().slice(0, 10);

function label(code: string, name: string, carbohydrateDefinition: 'total' | 'available', extra: Array<{ key: string; amount: number; unit: string }> = []) {
  return buildLabelPlan({
    schema: 'myrecipebook-product-label-1',
    product: { brand_name: 'Fixture Foods', product_name: name, variant_name: null, manufacturer_name: null, market: 'AE', package: { quantity: 200, unit: 'g' } },
    barcode: { code, format: 'ean_13' },
    label: {
      source: 'physical_manufacturer_label',
      observed_on: '2026-10-19',
      basis: 'per_100g',
      carbohydrate_definition: carbohydrateDefinition,
      nutrients: [
        { key: 'energy', amount: 400, unit: 'kcal' },
        { key: 'protein', amount: 10, unit: 'g' },
        { key: 'carbohydrate', amount: 60, unit: 'g' },
        { key: 'fat', amount: 12, unit: 'g' },
        ...extra,
      ],
    },
  });
}
async function publish(plan: ReturnType<typeof label>) {
  const client = await pool.connect();
  try {
    return await applyLabelPlan(client, plan, { dryRun: false, confirmNewLabelVersion: false });
  } finally {
    client.release();
  }
}
async function logGrams(productId: string, grams: number) {
  const res = await post(`/v1/profiles/${SEED.profileA}/meals`, {
    meal_type: 'snack',
    logged_date: DATE,
    local_timezone: 'UTC',
    consumed_at: new Date().toISOString(),
    items: [{ type: 'product', product_id: productId, quantity: grams, unit: 'g' }],
  });
  expect(res.status).toBe(201);
  return res;
}
const digest = async (sql: string) => createHash('sha256').update(JSON.stringify((await pool.query(sql)).rows)).digest('hex');
const historical = async () => ({
  nutrients: await digest('select id, canonical_key, unit, role::text from nutrient order by canonical_key'),
  foodNutrients: await digest('select id, food_id, nutrient_id, amount_per_canonical_unit::text, basis_quantity::text, basis_unit, source::text from food_nutrient order by id'),
  productNutrients: await digest('select id, label_version_id, nutrient_id, amount::text, basis_quantity::text, basis_unit, source::text, provenance_reference from product_nutrient order by id'),
  labels: await digest('select id, product_id, version_number, status::text, nutrition_source::text, provenance_reference, effective_from, created_at from product_label_version order by id'),
  snapshots: await digest('select id, nutrition_snapshot::text from meal_item order by id'),
});

let usProductId: string;
let before: Awaited<ReturnType<typeof historical>>;
let nutrientsBefore: Array<{ id: string; canonical_key: string; unit: string; role: string }>;

beforeAll(async () => {
  pool = await rebuildTestDatabase('recipebook_api_test_layer12b3', { stopBeforeMigration: MIGRATION_49 });
  await seedScenario(pool);
  await seedNutritionFixtures(pool);
  app = createApp({ profileRepository: new PgHarnessProfileRepository(pool), scopedDbFactory: new PgHarnessScopedDbFactory(pool), jwtSecret: TEST_JWT_SECRET, logger });
  // History before migration 49: a US total-carbohydrate label, published and eaten.
  usProductId = (await publish(label(US_CODE, 'US Style Crackers', 'total'))).product_id;
  await logGrams(usProductId, 50);
  nutrientsBefore = (await pool.query('select id, canonical_key, unit, role::text from nutrient order by canonical_key')).rows;
  before = await historical();
  await pool.query(await readFile(path.join(MIGRATIONS_DIR, MIGRATION_49), 'utf8'));
}, 120_000);

afterAll(async () => {
  await pool.end();
});

describe('H, I, J, K: migration 49 is additive and leaves history untouched', () => {
  it('adds exactly the 4 identities (g, role other); the 22 existing rows keep their ids, units and roles', async () => {
    const after = (await pool.query('select id, canonical_key, unit, role::text from nutrient order by canonical_key')).rows;
    expect(nutrientsBefore).toHaveLength(22);
    expect(after).toHaveLength(26);
    for (const row of nutrientsBefore) expect(after).toContainEqual(row);
    expect(after.filter((r) => NEW_KEYS.includes(r.canonical_key)).map((r) => [r.canonical_key, r.unit, r.role])).toEqual(NEW_KEYS.map((k) => [k, 'g', 'other']));
  });

  it('existing food nutrients (USDA mappings), product labels and meal snapshots are byte-identical', async () => {
    const now = await historical();
    expect({ ...now, nutrients: undefined }).toEqual({ ...before, nutrients: undefined });
  });

  it('re-running the migration changes nothing (idempotent, never reinterprets)', async () => {
    await pool.query(await readFile(path.join(MIGRATIONS_DIR, MIGRATION_49), 'utf8'));
    expect((await pool.query('select count(*)::int as n from nutrient')).rows[0].n).toBe(26);
  });
});

describe('A-G, M: publishing labels with the new identities', () => {
  let euProductId: string;

  it('B/C/D/E: an EU-style label stores available carbohydrate, sugars and saturated fat under their own identities', async () => {
    const result = await publish(
      label(EU_CODE, 'EU Style Biscuits', 'available', [
        { key: 'fiber', amount: 3, unit: 'g' },
        { key: 'total_sugars', amount: 20, unit: 'g' },
        { key: 'saturated_fat', amount: 0, unit: 'g' },
        { key: 'Salt', amount: 0.5, unit: 'g' },
      ]),
    );
    expect(result.outcome).toBe('created');
    euProductId = result.product_id;
    const { rows } = await pool.query(
      'select n.canonical_key as key, pn.amount::float as amount from product_nutrient pn join nutrient n on n.id = pn.nutrient_id where pn.label_version_id = $1 order by 1',
      [result.label_version_id],
    );
    expect(rows).toEqual([
      { key: 'available_carbohydrate', amount: 60 },
      { key: 'energy', amount: 400 },
      { key: 'fat', amount: 12 },
      { key: 'fiber', amount: 3 },
      { key: 'protein', amount: 10 },
      { key: 'saturated_fat', amount: 0 },
      { key: 'total_sugars', amount: 20 },
    ]);
    // no total carbohydrate, no added sugars, no sodium from salt
  });

  it('M/G: the existing engine scales the new identities by basis; known zero stays zero; total carbohydrate is unavailable, not computed', async () => {
    const calc = await post(`/v1/products/${euProductId}/nutrition/calculate`, { quantity: 50, unit: 'g' });
    expect(calc.status).toBe(200);
    const byKey = Object.fromEntries((calc.body.nutrients as Array<{ nutrient_key: string; value: number | null; is_zero: boolean; status: string }>).map((n) => [n.nutrient_key, n]));
    expect(byKey.available_carbohydrate).toMatchObject({ value: 30, status: 'resolved', source: { source: 'manufacturer_label', basis_quantity: 100, basis_unit: 'g' } });
    expect(byKey.total_sugars).toMatchObject({ value: 10, status: 'resolved' });
    expect(byKey.saturated_fat).toMatchObject({ value: 0, is_zero: true, status: 'resolved' });
    expect(byKey.added_sugars).toMatchObject({ value: null, status: 'no_data' });
    expect(byKey.carbohydrate).toMatchObject({ value: null, status: 'no_data' });
    expect(calc.body.summary.carbohydrate_g).toMatchObject({ value: null, coverage: 'unavailable' });
    expect(calc.body.summary.fiber_g).toMatchObject({ value: 1.5 });
  });

  it('A: the earlier US label still resolves its total carbohydrate exactly as before', async () => {
    const calc = await post(`/v1/products/${usProductId}/nutrition/calculate`, { quantity: 50, unit: 'g' });
    expect(calc.body.summary.carbohydrate_g).toMatchObject({ value: 30, coverage: 'complete' });
    const available = (calc.body.nutrients as Array<{ nutrient_key: string; value: number | null }>).find((n) => n.nutrient_key === 'available_carbohydrate');
    expect(available?.value ?? null).toBeNull();
  });

  it('O: the Daily Tracker keeps honest coverage: total carbohydrate partial, the new identities partial across old and new meals', async () => {
    await logGrams(euProductId, 50);
    const t = await get(`/v1/profiles/${SEED.profileA}/daily-tracker`, { date: DATE, timezone: 'UTC' });
    expect(t.status).toBe(200);
    expect(t.body.actual.summary.energy_kcal).toMatchObject({ value: 400, coverage: 'complete' });
    expect(t.body.actual.summary.carbohydrate_g).toMatchObject({ value: 30, coverage: 'partial' }); // the US meal only
    const byKey = Object.fromEntries((t.body.actual.nutrients as Array<{ nutrient_key: string; value: number | null; coverage: string }>).map((n) => [n.nutrient_key, n]));
    // the pre-49 snapshot does not know the new identities: unknown, never 0
    expect(byKey.available_carbohydrate).toMatchObject({ value: 30, coverage: 'partial' });
    expect(byKey.total_sugars).toMatchObject({ value: 10, coverage: 'partial' });
  });
});

describe('P, Q: targets and permissions', () => {
  it('P: new identities are valid target fields, but no target is created and the carbohydrate target field is unchanged', async () => {
    const { rows } = await pool.query("select count(*)::int as n from nutrition_target where field_name in ('available_carbohydrate', 'total_sugars', 'added_sugars', 'saturated_fat')");
    expect(rows[0].n).toBe(0);
  });

  it('Q: ordinary users still cannot change the nutrient vocabulary', async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('request.jwt.claim.sub', $1, true)", [SEED.accountA]);
      await client.query('set local role authenticated');
      await expect(client.query("insert into nutrient (canonical_key, unit, role) values ('salt', 'g', 'other')")).rejects.toThrow(/permission denied/);
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });
});
