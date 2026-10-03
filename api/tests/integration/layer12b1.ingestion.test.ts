// Layer 12B.1 integration tests — trusted USDA reference-data ingestion against
// the real migration chain (Supabase default privileges emulated) and RLS.
// Source data: tests/fixtures/usda/sr-legacy.TEST-FIXTURE.json — invented
// values in the SR Legacy JSON shape, NOT USDA data.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app';
import { logger } from '../../src/lib/logger';
import { applyPlan, IngestionStopped } from '../../src/ingestion/usda/apply';
import { buildPlan } from '../../src/ingestion/usda/plan';
import { PgHarnessProfileRepository } from '../helpers/pgHarnessProfileRepository';
import { PgHarnessScopedDbFactory } from '../helpers/pgHarnessScopedDb';
import { rebuildTestDatabase } from '../helpers/testDb';
import { seedScenario, SEED } from '../helpers/seed';
import { signTestToken, TEST_JWT_SECRET } from '../helpers/jwt';

const FIX = path.resolve(__dirname, '../fixtures/usda');
const file = () => JSON.parse(readFileSync(path.join(FIX, 'sr-legacy.TEST-FIXTURE.json'), 'utf8')) as { SRLegacyFoods: Record<string, unknown>[] };
const manifest = () => JSON.parse(readFileSync(path.join(FIX, 'test.manifest.json'), 'utf8')) as unknown;

let pool: Pool;
let app: ReturnType<typeof createApp>;
const A = (p: string) => request(app).get(p).set('Authorization', `Bearer ${signTestToken(SEED.accountA)}`);
const post = (p: string, body: object) => request(app).post(p).set('Authorization', `Bearer ${signTestToken(SEED.accountA)}`).send(body);

async function ingest(input = file(), dryRun = false) {
  const client = await pool.connect();
  try {
    return await applyPlan(client, buildPlan(input, manifest()), { release: 'TEST-FIXTURE', dryRun });
  } finally {
    client.release();
  }
}

const counts = async () =>
  (
    await pool.query(
      'select (select count(*)::int from food) as foods, (select count(*)::int from food_alias) as aliases, (select count(*)::int from food_serving) as servings, (select count(*)::int from food_nutrient) as nutrients, (select count(*)::int from food_source_record) as sources',
    )
  ).rows[0] as Record<string, number>;

async function asAuthenticated<T>(sql: string, params: unknown[] = []): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [SEED.accountA]);
    await client.query('set local role authenticated');
    return (await client.query(sql, params)) as T;
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
  }
}

beforeAll(async () => {
  pool = await rebuildTestDatabase('recipebook_api_test_layer12b1');
  await seedScenario(pool);
  app = createApp({ profileRepository: new PgHarnessProfileRepository(pool), scopedDbFactory: new PgHarnessScopedDbFactory(pool), jwtSecret: TEST_JWT_SECRET, logger });
}, 120_000);

afterAll(async () => {
  await pool.end();
});

describe('trusted USDA ingestion (operator path)', () => {
  it('a dry run checks and writes inside a transaction, then leaves nothing behind', async () => {
    const before = await counts();
    const result = await ingest(file(), true);
    expect(result).toMatchObject({ committed: false, counts: { foods: 2, aliases: 2, servings: 2, nutrients: 8 } });
    expect(await counts()).toEqual(before);
  });

  it('writes Foods with provenance, aliases, USDA-stated servings and only mapped nutrients', async () => {
    const result = await ingest();
    expect(result.committed).toBe(true);
    expect(result.inserted).toHaveLength(2);
    const { rows } = await pool.query(
      `select f.canonical_name, f.source, f.category, f.density_g_per_ml, s.source_system, s.source_dataset, s.source_record_id, s.source_secondary_id, s.source_release, s.licence, s.source_description
         from food f join food_source_record s on s.food_id = f.id order by s.source_record_id`,
    );
    expect(rows[0]).toEqual({
      canonical_name: 'usda-fdc:990000001',
      source: 'trusted_database',
      category: 'Test Category',
      density_g_per_ml: null,
      source_system: 'usda_fdc',
      source_dataset: 'sr_legacy',
      source_record_id: '990000001',
      source_secondary_id: '99001',
      source_release: 'TEST-FIXTURE',
      licence: 'CC0-1.0',
      source_description: 'Testfood, alpha, raw',
    });
    const nutrients = await pool.query(
      "select n.canonical_key, fn.amount_per_canonical_unit::float as amount, fn.basis_quantity::float as basis, fn.basis_unit, fn.source from food_nutrient fn join nutrient n on n.id = fn.nutrient_id join food f on f.id = fn.food_id where f.canonical_name = 'usda-fdc:990000001' order by 1",
    );
    expect(nutrients.rows.map((r) => [r.canonical_key, r.amount])).toEqual([
      ['carbohydrate', 12],
      ['energy', 150],
      ['fat', 5],
      ['fiber', 0],
      ['protein', 10],
      ['vitamin_a', 40],
    ]);
    expect(nutrients.rows.every((r) => r.basis === 100 && r.basis_unit === 'g' && r.source === 'trusted_database')).toBe(true);
    const servings = await pool.query("select serving_description, canonical_quantity::float as q, canonical_unit, region, fs.source from food_serving fs join food f on f.id = fs.food_id where f.canonical_name = 'usda-fdc:990000001' order by 1");
    expect(servings.rows).toEqual([
      { serving_description: '0.5 cup, sliced', q: 60, canonical_unit: 'g', region: null, source: 'trusted_database' },
      { serving_description: '1 piece', q: 40, canonical_unit: 'g', region: null, source: 'trusted_database' },
    ]);
    const alias = await pool.query("select locale, alias_text, is_primary, fa.source from food_alias fa join food f on f.id = fa.food_id where f.canonical_name = 'usda-fdc:990000002'");
    expect(alias.rows).toEqual([{ locale: 'en', alias_text: 'Testfood, beta, cooked', is_primary: true, source: 'trusted_database' }]);
  });

  it('is idempotent: re-running writes nothing and reports every record unchanged', async () => {
    const before = await counts();
    const result = await ingest();
    expect(result).toMatchObject({ committed: true, inserted: [], counts: { foods: 0, aliases: 0, servings: 0, nutrients: 0 } });
    expect(result.unchanged).toHaveLength(2);
    expect(await counts()).toEqual(before);
  });

  it('a changed source record stops the whole run for review; nothing is overwritten or added', async () => {
    const changed = file();
    (changed.SRLegacyFoods[0]!.foodNutrients as { amount: number }[])[0]!.amount = 999;
    const before = await counts();
    const energyBefore = await pool.query("select fn.amount_per_canonical_unit::float as a from food_nutrient fn join nutrient n on n.id = fn.nutrient_id join food f on f.id = fn.food_id where f.canonical_name = 'usda-fdc:990000001' and n.canonical_key = 'energy'");
    await expect(ingest(changed)).rejects.toBeInstanceOf(IngestionStopped);
    try {
      await ingest(changed);
    } catch (e) {
      expect((e as IngestionStopped).result.changed).toEqual(['fdc 990000001 (NDB 99001) Testfood, alpha, raw']);
    }
    expect(await counts()).toEqual(before);
    const energyAfter = await pool.query("select fn.amount_per_canonical_unit::float as a from food_nutrient fn join nutrient n on n.id = fn.nutrient_id join food f on f.id = fn.food_id where f.canonical_name = 'usda-fdc:990000001' and n.canonical_key = 'energy'");
    expect(energyAfter.rows).toEqual(energyBefore.rows);
  });

  it('source records are immutable, even for the owner', async () => {
    await expect(pool.query("update food_source_record set source_release = 'x'")).rejects.toThrow(/immutable/);
  });
});

describe('client roles cannot write reference data', () => {
  it.each([
    ["insert into food (canonical_name, source) values ('evil', 'trusted_database')"],
    ["insert into food_source_record (food_id, source_system, source_dataset, source_record_id, source_release, source_description, licence, content_sha256) select id, 'usda_fdc', 'sr_legacy', '1', 'r', 'd', 'CC0-1.0', repeat('a', 64) from food limit 1"],
    ["update food_nutrient set amount_per_canonical_unit = 0"],
    ["delete from food_alias"],
    ["insert into food_serving (food_id, serving_description, canonical_quantity, canonical_unit, source) select id, 'x', 1, 'g', 'trusted_database' from food limit 1"],
  ])('authenticated: %s', async (sql) => {
    await expect(asAuthenticated(sql)).rejects.toThrow(/permission denied/);
  });

  it('authenticated can read provenance; anon cannot read reference data at all', async () => {
    const res = await asAuthenticated<{ rowCount: number }>('select source_record_id from food_source_record');
    expect(res.rowCount).toBe(2);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role anon');
      await expect(client.query('select 1 from food_source_record')).rejects.toThrow(/permission denied/);
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });
});

describe('ingested Foods through the real API (Layer 12B flow)', () => {
  it('search -> detail -> server preview -> log -> Daily Tracker', async () => {
    const search = await A('/v1/foods').query({ q: 'testfood' });
    expect(search.status).toBe(200);
    const hit = search.body.data.find((f: { canonical_name: string }) => f.canonical_name === 'usda-fdc:990000001');
    expect(hit).toMatchObject({ display_name: 'Testfood, alpha, raw', source: 'trusted_database' });

    const detail = await A(`/v1/foods/${hit.id}`);
    const serving = detail.body.servings.find((s: { serving_description: string }) => s.serving_description === '1 piece');
    expect(serving).toMatchObject({ canonical_quantity: 40, canonical_unit: 'g' });

    const preview = await post('/v1/nutrition/calculate', { items: [{ food_id: hit.id, quantity: 2, serving_id: serving.id }] });
    expect(preview.status).toBe(200);
    // 2 x 40 g of 150 kcal / 100 g, by the server engine
    expect(preview.body.summary.energy_kcal).toMatchObject({ value: 120, coverage: 'complete' });
    expect(preview.body.summary.fiber_g).toMatchObject({ value: 0, is_zero: true, coverage: 'complete' });

    const date = new Date().toISOString().slice(0, 10);
    const logged = await post(`/v1/profiles/${SEED.profileA}/meals`, {
      meal_type: 'lunch',
      logged_date: date,
      local_timezone: 'UTC',
      consumed_at: new Date().toISOString(),
      items: [{ type: 'food', food_id: hit.id, quantity: 2, serving_id: serving.id }],
    });
    expect(logged.status).toBe(201);
    const tracker = await A(`/v1/profiles/${SEED.profileA}/daily-tracker`).query({ date, timezone: 'UTC' });
    expect(tracker.body.actual.summary.energy_kcal.value).toBe(120);
    expect(tracker.body.actual.summary.carbohydrate_g.value).toBe(9.6);
  });

  it('the beta record has no fiber value: unavailable, not zero', async () => {
    const search = await A('/v1/foods').query({ q: 'testfood, beta' });
    const id = search.body.data[0].id;
    const preview = await post('/v1/nutrition/calculate', { items: [{ food_id: id, quantity: 100, unit: 'g' }] });
    expect(preview.body.summary.fiber_g).toMatchObject({ value: null, coverage: 'unavailable' });
    expect(preview.body.summary.energy_kcal.value).toBe(80);
  });
});
