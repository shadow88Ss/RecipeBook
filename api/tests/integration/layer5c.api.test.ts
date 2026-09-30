// Layer 5C integration tests — nutrient vocabulary, data authority and the
// nutrition summary projection, against the real migration chain and RLS
// harness. Food data: tests/helpers/nutritionFixtures.ts (TEST FIXTURES ONLY).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app';
import { logger } from '../../src/lib/logger';
import { PgHarnessProfileRepository } from '../helpers/pgHarnessProfileRepository';
import { PgHarnessScopedDbFactory } from '../helpers/pgHarnessScopedDb';
import { rebuildTestDatabase } from '../helpers/testDb';
import { seedScenario, SEED } from '../helpers/seed';
import { F, SRV, seedNutritionFixtures } from '../helpers/nutritionFixtures';
import { signTestToken, TEST_JWT_SECRET } from '../helpers/jwt';
import { CANONICAL_NUTRIENTS } from '../../src/domain/nutrition/vocabulary';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const BOUNDARY_MIGRATION = path.resolve(__dirname, '../../../supabase/migrations/20260930120000_food_nutrient_global_source_boundary.sql');

let pool: Pool;
let app: ReturnType<typeof createApp>;
const auth = () => `Bearer ${signTestToken(SEED.accountA)}`;

type Item = { food_id: string; quantity: number; unit?: string; serving_id?: string };
const calculate = async (items: Item[]) => {
  const res = await request(app).post('/v1/nutrition/calculate').set('Authorization', auth()).send({ items });
  expect(res.status).toBe(200);
  return res.body;
};

beforeAll(async () => {
  pool = await rebuildTestDatabase('recipebook_api_test_layer5c');
  await seedScenario(pool);
  await seedNutritionFixtures(pool);
  app = createApp({
    profileRepository: new PgHarnessProfileRepository(pool),
    scopedDbFactory: new PgHarnessScopedDbFactory(pool),
    jwtSecret: TEST_JWT_SECRET,
    logger,
  });
}, 60_000);

afterAll(async () => {
  await pool.end();
});

describe('A-D: vocabulary in the database', () => {
  it('the seeded vocabulary is identical to the code registry (keys, roles, units)', async () => {
    const { rows } = await pool.query('select canonical_key, role::text as role, unit from nutrient order by canonical_key');
    const expected = CANONICAL_NUTRIENTS.map((n) => ({ canonical_key: n.key, role: n.role, unit: n.unit })).sort((a, b) =>
      a.canonical_key < b.canonical_key ? -1 : 1,
    );
    expect(rows).toEqual(expected);
  });

  it('A/B: roles are queryable through GET /v1/nutrients', async () => {
    const byRole = async (role: string) =>
      (await request(app).get('/v1/nutrients').query({ role, limit: 100 }).set('Authorization', auth())).body.data.map(
        (n: { canonical_key: string; role: string; unit: string }) => `${n.canonical_key}:${n.role}:${n.unit}`,
      );
    expect(await byRole('energy')).toEqual(['energy:energy:kcal']);
    expect(await byRole('macronutrient')).toEqual(['carbohydrate:macronutrient:g', 'fat:macronutrient:g', 'protein:macronutrient:g']);
    expect(await byRole('fiber')).toEqual(['fiber:fiber:g']);
    expect(await byRole('micronutrient')).toHaveLength(17);
    const bad = await request(app).get('/v1/nutrients').query({ role: 'vitamin' }).set('Authorization', auth());
    expect(bad.status).toBe(400);
  });

  it('D: the database enforces one energy identity and role <-> reporting-unit rules', async () => {
    const reject = (sql: string, pattern: RegExp) => expect(pool.query(sql)).rejects.toThrow(pattern);
    await reject("insert into nutrient (canonical_key, unit, role) values ('energy_2', 'kcal', 'energy')", /uq_nutrient_single_energy/);
    await reject("insert into nutrient (canonical_key, unit, role) values ('energy_kj', 'kJ', 'energy')", /nutrient_role_reporting_unit/);
    await reject("insert into nutrient (canonical_key, unit, role) values ('starch', 'mg', 'macronutrient')", /nutrient_role_reporting_unit/);
    await reject("insert into nutrient (canonical_key, unit, role) values ('vitamin_d_iu', 'IU', 'micronutrient')", /nutrient_role_reporting_unit/);
    await reject("update nutrient set unit = 'g' where canonical_key = 'iron'", /nutrient_role_reporting_unit/);
  });

  it('authenticated clients still cannot change the vocabulary', async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('select set_config($1, $2, true)', ['request.jwt.claim.sub', SEED.accountA]);
      await client.query('set local role authenticated');
      await expect(client.query("update nutrient set role = 'other' where canonical_key = 'energy'")).rejects.toThrow(/permission denied/);
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });
});

describe('K: personal data never enters the global reference tables', () => {
  it('rejects a user-entered FoodServing and a user-entered density', async () => {
    await expect(
      pool.query(
        "insert into food_serving (food_id, serving_description, canonical_quantity, canonical_unit, source) values ($1, 'my bowl', 250, 'g', 'user_entered')",
        [F.rice],
      ),
    ).rejects.toThrow(/food_serving_no_personal_source/);
    await expect(pool.query("update food set density_g_per_ml = 1.1, density_source = 'user_entered' where id = $1", [F.juice])).rejects.toThrow(
      /food_density_no_personal_source/,
    );
  });

  it('a user-confirmed weight is passed as an explicit quantity, not stored as a global serving', async () => {
    // e.g. the user confirmed "my bowl = 250 g": the caller sends 250 g.
    const body = await calculate([{ food_id: F.rice, quantity: 250, unit: 'g' }]);
    expect(body.items[0].normalized_quantity).toMatchObject({ quantity: 250, unit: 'g', authoritative: true });
    const { rows } = await pool.query("select count(*)::int as n from food_serving where source = 'user_entered'");
    expect(rows[0].n).toBe(0);
  });
});

describe('E-J, M: nutrition summary projection', () => {
  it('E: the summary is exactly the aggregate for the five canonical fields', async () => {
    const body = await calculate([
      { food_id: F.rice, quantity: 150, unit: 'g' },
      { food_id: F.bread, quantity: 2, serving_id: SRV.breadSlice },
      { food_id: F.milk, quantity: 250, unit: 'ml' },
    ]);
    const fields: Record<string, string> = { energy_kcal: 'energy', protein_g: 'protein', carbohydrate_g: 'carbohydrate', fat_g: 'fat', fiber_g: 'fiber' };
    for (const [field, key] of Object.entries(fields)) {
      const aggregate = body.aggregate.nutrients.find((n: { nutrient_key: string }) => n.nutrient_key === key);
      expect(body.summary[field]).toMatchObject({
        nutrient_key: key,
        value: aggregate.value,
        is_zero: aggregate.is_zero,
        coverage: aggregate.coverage,
        resolved_item_count: aggregate.resolved_item_count,
        item_count: aggregate.item_count,
      });
    }
    expect(body.summary.energy_kcal).toMatchObject({ value: 514, coverage: 'complete', status: null });
    // G: fiber known for rice and bread only
    expect(body.summary.fiber_g).toMatchObject({ value: 2.22, coverage: 'partial', status: 'partial', resolved_item_count: 2 });
    // per-item summary mirrors the item's own nutrients
    expect(body.items[1].summary.protein_g).toMatchObject({ value: 5.4, coverage: 'complete' });
    expect(body.items[2].summary.fiber_g).toMatchObject({ value: null, coverage: 'unavailable', status: 'no_data' });
  });

  it('F: an unavailable macro is null, never 0', async () => {
    const body = await calculate([{ food_id: F.milk, quantity: 250, unit: 'ml' }]);
    expect(body.summary.carbohydrate_g).toMatchObject({ value: null, is_zero: false, coverage: 'unavailable' });
  });

  it('I: no 4/4/9 energy derivation', async () => {
    const body = await calculate([{ food_id: F.noEnergy, quantity: 100, unit: 'g' }]);
    expect(body.summary.protein_g.value).toBe(10);
    expect(body.summary.carbohydrate_g.value).toBe(20);
    expect(body.summary.fat_g.value).toBe(5);
    expect(body.summary.energy_kcal).toMatchObject({ value: null, coverage: 'unavailable' });
  });

  it('M: competing sources stay ambiguous through the summary', async () => {
    const body = await calculate([{ food_id: F.competing, quantity: 100, unit: 'g' }]);
    expect(body.items[0].summary.protein_g).toMatchObject({ value: null, status: 'ambiguous_nutrient_source' });
    expect(body.summary.protein_g).toMatchObject({ value: null, coverage: 'unavailable' });
    const protein = body.items[0].nutrients.find((n: { nutrient_key: string }) => n.nutrient_key === 'protein');
    expect(protein.candidates).toEqual([
      expect.objectContaining({ source: 'manufacturer_label', authority: 'exact_product' }),
      expect.objectContaining({ source: 'trusted_database', authority: 'global_reference' }),
    ]);
  });

  it('H: a known zero stays a known zero in the generic result', async () => {
    const body = await calculate([{ food_id: F.rice, quantity: 100, unit: 'g' }]);
    const vitaminD = body.aggregate.nutrients.find((n: { nutrient_key: string }) => n.nutrient_key === 'vitamin_d');
    expect(vitaminD).toMatchObject({ value: 0, is_zero: true, coverage: 'complete' });
  });
});

describe('Micronutrient projection and authority visibility', () => {
  it('micronutrients stay in the generic result, findable by stable key and role', async () => {
    const body = await calculate([
      { food_id: F.spinach, quantity: 100, unit: 'g' },
      { food_id: F.milk, quantity: 100, unit: 'ml' },
    ]);
    const micro = body.aggregate.nutrients.filter((n: { nutrient_role: string }) => n.nutrient_role === 'micronutrient');
    expect(micro).toHaveLength(17);
    const byKey = Object.fromEntries(micro.map((n: { nutrient_key: string }) => [n.nutrient_key, n]));
    expect(byKey.iron).toMatchObject({ unit: 'mg', value: 2.7, coverage: 'partial' });
    expect(byKey.vitamin_d).toMatchObject({ unit: 'mcg', value: 1.1, coverage: 'complete' });
    expect(byKey.calcium).toMatchObject({ unit: 'mg', value: null, coverage: 'unavailable' });
    expect(Object.keys(body.summary)).toEqual(['energy_kcal', 'protein_g', 'carbohydrate_g', 'fat_g', 'fiber_g']);
  });

  it('authority classes are visible downstream (calculation and food detail)', async () => {
    // Excluded ai_matched / user_entered records carry their authority class
    // too; that is asserted in tests/unit/vocabulary.test.ts, because the
    // global food_nutrient table can no longer hold such records.
    const body = await calculate([{ food_id: F.bar, quantity: 40, unit: 'g' }, { food_id: F.rice, quantity: 100, unit: 'g' }]);
    const barProtein = body.items[0].nutrients.find((n: { nutrient_key: string }) => n.nutrient_key === 'protein');
    expect(barProtein.source).toMatchObject({ source: 'manufacturer_label', authority: 'exact_product' });
    const riceProtein = body.items[1].nutrients.find((n: { nutrient_key: string }) => n.nutrient_key === 'protein');
    expect(riceProtein.source).toMatchObject({ source: 'trusted_database', authority: 'global_reference' });

    const detail = await request(app).get(`/v1/foods/${F.rice}`).set('Authorization', auth());
    expect(detail.body.nutrients[0]).toMatchObject({ authority: 'global_reference' });
    expect(detail.body.nutrients.find((n: { nutrient_key: string }) => n.nutrient_key === 'protein')).toMatchObject({ nutrient_role: 'macronutrient' });
  });
});

describe('Final boundary: food_nutrient is global reference data only', () => {
  const insertNutrient = (source: string, foodId: string = F.noEnergy) =>
    pool.query(
      "insert into food_nutrient (food_id, nutrient_id, amount_per_canonical_unit, source, basis_quantity, basis_unit) select $1, id, 1, $2::food_data_source, 100, 'g' from nutrient where canonical_key = 'iron'",
      [foodId, source],
    );

  it('1: a trusted_database row is accepted through trusted setup', async () => {
    await expect(insertNutrient('trusted_database')).resolves.toMatchObject({ rowCount: 1 });
  });

  it('manufacturer_label is no longer accepted on a generic Food (Layer 11A G2: label nutrition belongs to Product)', async () => {
    await expect(insertNutrient('manufacturer_label')).rejects.toThrow(/food_nutrient_generic_reference_source/);
  });

  it('2: a user_entered row is rejected', async () => {
    await expect(insertNutrient('user_entered')).rejects.toThrow(/food_nutrient_(global_source|generic_reference_source)/);
  });

  it('3: an ai_matched row is rejected', async () => {
    await expect(insertNutrient('ai_matched')).rejects.toThrow(/food_nutrient_(global_source|generic_reference_source)/);
  });

  it('an existing row cannot be re-sourced to user_entered or ai_matched', async () => {
    for (const source of ['user_entered', 'ai_matched']) {
      await expect(pool.query('update food_nutrient set source = $2::food_data_source where food_id = $1', [F.rice, source])).rejects.toThrow(
        /food_nutrient_(global_source|generic_reference_source)/,
      );
    }
  });

  it('authenticated clients still cannot write food_nutrient at all', async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role authenticated');
      await expect(
        client.query("insert into food_nutrient (food_id, nutrient_id, amount_per_canonical_unit, source) select $1, id, 1, 'trusted_database' from nutrient where canonical_key = 'zinc'", [
          F.rice,
        ]),
      ).rejects.toThrow(/permission denied|row-level security/);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  it('historical rows are retained, not deleted: the migration adds the constraint NOT VALID', async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      // Simulate a database that already held a legacy personal/AI row
      // before the boundary migration ran.
      await client.query('alter table food_nutrient drop constraint food_nutrient_global_source');
      await client.query('alter table food_nutrient drop constraint food_nutrient_generic_reference_source'); // Layer 11A, later
      await client.query(
        "insert into food_nutrient (food_id, nutrient_id, amount_per_canonical_unit, source) select $1, id, 7, 'user_entered' from nutrient where canonical_key = 'protein'",
        [F.aiIdentity],
      );
      await client.query(await readFile(BOUNDARY_MIGRATION, 'utf8'));

      const kept = await client.query("select count(*)::int as n from food_nutrient where food_id = $1 and source = 'user_entered'", [F.aiIdentity]);
      expect(kept.rows[0].n).toBe(1);
      const constraint = await client.query("select convalidated from pg_constraint where conname = 'food_nutrient_global_source'");
      expect(constraint.rows).toEqual([{ convalidated: false }]);
      await expect(
        client.query("insert into food_nutrient (food_id, nutrient_id, amount_per_canonical_unit, source) select $1, id, 1, 'ai_matched' from nutrient where canonical_key = 'energy'", [
          F.aiIdentity,
        ]),
      ).rejects.toThrow(/food_nutrient_global_source/);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});
