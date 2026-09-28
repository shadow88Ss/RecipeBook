// Layer 7C integration tests — canonical nutrition target vocabulary through
// the API, the database backstop, the resolver and the Daily Tracker.
// TEST FIXTURES ONLY.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app';
import { logger } from '../../src/lib/logger';
import { PgHarnessProfileRepository } from '../helpers/pgHarnessProfileRepository';
import { PgHarnessScopedDbFactory } from '../helpers/pgHarnessScopedDb';
import { rebuildTestDatabase } from '../helpers/testDb';
import { seedScenario, SEED } from '../helpers/seed';
import { F, seedNutritionFixtures } from '../helpers/nutritionFixtures';
import { signTestToken, TEST_JWT_SECRET } from '../helpers/jwt';
import { TARGET_ALIASES } from '../../src/domain/nutritionTargets/targetVocabulary';

let pool: Pool;
let app: ReturnType<typeof createApp>;

const as = (account: string) => ({
  get: (path: string, query: Record<string, string> = {}) => request(app).get(path).query(query).set('Authorization', `Bearer ${signTestToken(account)}`),
  post: (path: string, body: unknown) => request(app).post(path).set('Authorization', `Bearer ${signTestToken(account)}`).send(body as object),
});
const userTargets = (profile: string) => `/v1/profiles/${profile}/nutrition-targets`;
const clinicianTargets = (profile: string) => `/v1/profiles/${profile}/clinician-targets`;
const effective = (account: string, profile: string) => as(account).get(`/v1/profiles/${profile}/effective-target`);
const TODAY = new Date().toISOString().slice(0, 10);

async function asAccountSql(account: string, sql: string, params: unknown[] = []) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [account]);
    await client.query('set local role authenticated');
    return await client.query(sql, params);
  } finally {
    await client.query('rollback');
    client.release();
  }
}

/** Writes rows exactly as a pre-7C database would have held them (the
 * canonical-key trigger did not exist then). Test-only. */
async function insertLegacy(table: 'nutrition_target' | 'clinician_target', profile: string, field: string, value: number, unit: string) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    const extra =
      table === 'clinician_target'
        ? ", source_type, provided_by_account_id, entered_at) values ($1, $2, $3, $4, 'user_entered', $5, now()) returning id"
        : ') values ($1, $2, $3, $4) returning id';
    const params = table === 'clinician_target' ? [profile, field, value, unit, SEED.accountB] : [profile, field, value, unit];
    const { rows } = await client.query(`insert into ${table} (profile_id, field_name, value, unit${extra}`, params);
    await client.query('commit');
    return rows[0].id as string;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  pool = await rebuildTestDatabase('recipebook_api_test_layer7c');
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

describe('vocabulary in the database', () => {
  it('the database alias map is identical to the code map', async () => {
    const { rows } = await pool.query('select alias, canonical_key, implied_unit from target_field_alias order by alias');
    const code = Object.entries(TARGET_ALIASES)
      .map(([alias, a]) => ({ alias, canonical_key: a.key, implied_unit: a.unit }))
      .sort((a, b) => (a.alias < b.alias ? -1 : 1));
    expect(rows).toEqual(code);
  });

  it('new rows must use a canonical key and its reporting unit, whatever the write path', async () => {
    const insert = (field: string, unit: string) =>
      asAccountSql(SEED.accountA, 'insert into nutrition_target (profile_id, field_name, value, unit) values ($1, $2, 1, $3)', [SEED.profileA, field, unit]);
    await expect(insert('calories', 'kcal')).rejects.toThrow(/canonical target key/);
    await expect(insert('protein', 'kcal')).rejects.toThrow(/canonical reporting unit/);
    await expect(insert('iron', 'mcg')).rejects.toThrow(/canonical reporting unit/);
    await expect(insert('protein', 'g')).resolves.toMatchObject({ rowCount: 1 });
  });
});

describe('A-J: API normalization', () => {
  it('A/B: calories 1500 kcal is stored and returned as energy 1500 kcal', async () => {
    const res = await as(SEED.accountA).post(userTargets(SEED.profileA), { field_name: 'calories', value: 1500, unit: 'kcal' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ field_name: 'energy', value: 1500, unit: 'kcal' });
    const stored = await pool.query('select field_name, unit from nutrition_target where id = $1', [res.body.id]);
    expect(stored.rows[0]).toEqual({ field_name: 'energy', unit: 'kcal' });
  });

  it('C/D: energy_kcal and carbs normalize; history by alias finds canonical rows', async () => {
    const a = as(SEED.accountA);
    expect((await a.post(userTargets(SEED.profileA), { field_name: 'energy_kcal', value: 1600, unit: 'kcal' })).body.field_name).toBe('energy');
    expect((await a.post(userTargets(SEED.profileA), { field_name: 'carbs', value: 200, unit: 'g' })).body.field_name).toBe('carbohydrate');
    const history = await a.get(`${userTargets(SEED.profileA)}/history`, { field_name: 'calories' });
    expect(history.body.data.map((r: { field_name: string; value: number; is_active: boolean }) => [r.field_name, r.value, r.is_active])).toEqual([
      ['energy', 1600, true],
      ['energy', 1500, false],
    ]);
  });

  it('F/G/H/I: units — mass for macros, kcal for energy, exact micronutrient conversion, incompatible rejected', async () => {
    const a = as(SEED.accountA);
    const iron = await a.post(userTargets(SEED.profileA), { field_name: 'iron', value: 8000, unit: 'mcg' });
    expect(iron.body).toMatchObject({ field_name: 'iron', value: 8, unit: 'mg' });
    for (const [body, path] of [
      [{ field_name: 'protein', value: 100, unit: 'kcal' }, 'unit'],
      [{ field_name: 'energy', value: 8000, unit: 'kJ' }, 'unit'],
      [{ field_name: 'vitamin_d', value: 600, unit: 'IU' }, 'unit'],
      [{ field_name: 'phosphorus', value: 700, unit: 'mg' }, 'field_name'],
      [{ field_name: 'resolver_calories', value: 1800, unit: 'kcal' }, 'field_name'],
    ] as const) {
      const res = await a.post(userTargets(SEED.profileA), body);
      expect(res.status).toBe(400);
      expect(res.body.error.details.issues[0].path).toBe(path);
    }
    // clinician targets obey the same vocabulary
    expect((await a.post(clinicianTargets(SEED.profileA), { field_name: 'calories', value: 2000, unit: 'kcal' })).body).toMatchObject({ field_name: 'energy', unit: 'kcal' });
    expect((await a.post(clinicianTargets(SEED.profileA), { field_name: 'protein', value: 100, unit: 'kcal' })).status).toBe(400);
  });

  it('authorization still comes first: view_only gets 403 even for an unknown key', async () => {
    expect((await as(SEED.accountViewOnly).post(userTargets(SEED.profileChild), { field_name: 'not_a_key', value: 1, unit: 'g' })).status).toBe(403);
  });
});

describe('E/K/L/O: EffectiveTargetResolver on canonical keys', () => {
  it('E: resolved keys are canonical — never "calories" — and precedence is unchanged field by field', async () => {
    const res = await effective(SEED.accountA, SEED.profileA);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.resolved).sort()).toEqual(['carbohydrate', 'energy', 'iron']);
    expect(res.body.resolved).not.toHaveProperty('calories');
    // K: clinician energy (2000) wins over user energy (1600)
    expect(res.body.resolved.energy).toMatchObject({ value: 2000, unit: 'kcal', source: 'clinician_target' });
    // L: other fields still resolve from the user source
    expect(res.body.resolved.iron).toMatchObject({ value: 8, unit: 'mg', source: 'user_target' });
    expect(res.body.resolved.carbohydrate).toMatchObject({ value: 200, source: 'user_target' });
    expect(res.body.unresolved_fields).toEqual([]);
    // O: no formula — only the two implemented sources, nothing derived
    expect(res.body.implemented_sources).toEqual(['clinician_target', 'user_target']);
    expect(Object.values(res.body.resolved).every((f) => ['clinician_target', 'user_target'].includes((f as { source: string }).source))).toBe(true);
    expect(res.body.resolver_version).toBe('phase2-canonical-target-keys-v2');
    expect((await effective(SEED.accountB, SEED.profileB)).body).toMatchObject({ resolved: {}, unresolved_fields: [] });
  });
});

describe('legacy rows written before canonical keys', () => {
  let legacyCalories: string;
  let legacyUnknown: string;
  let legacyBadUnit: string;

  it('are interpreted through the same alias map, or reported — never guessed or rewritten', async () => {
    legacyCalories = await insertLegacy('nutrition_target', SEED.profileB, 'calories', 1800, 'kcal');
    legacyUnknown = await insertLegacy('nutrition_target', SEED.profileB, 'resolver_calories', 1900, 'kcal');
    await insertLegacy('nutrition_target', SEED.profileB, 'protein', 90, 'g');
    legacyBadUnit = await insertLegacy('clinician_target', SEED.profileB, 'protein', 400, 'kcal');

    const res = await effective(SEED.accountB, SEED.profileB);
    expect(res.body.resolved).toEqual({ energy: { value: 1800, unit: 'kcal', source: 'user_target', source_reference: legacyCalories } });
    // the clinician's uninterpretable protein row blocks protein — the user's 90 g does not silently fill it
    expect(res.body.resolved).not.toHaveProperty('protein');
    expect(res.body.unresolved_fields).toEqual(
      expect.arrayContaining([
        { field_name: 'protein', source: 'clinician_target', source_reference: legacyBadUnit, reason: 'incompatible_unit' },
        { field_name: 'resolver_calories', source: 'user_target', source_reference: legacyUnknown, reason: 'unknown_target_key' },
      ]),
    );
    const stored = await pool.query('select field_name, value, unit, is_active from nutrition_target where id = $1', [legacyCalories]);
    expect(stored.rows[0]).toEqual({ field_name: 'calories', value: 1800, unit: 'kcal', is_active: true }); // untouched
  });

  it('two active legacy rows for one key are a conflict, not a choice', async () => {
    await insertLegacy('nutrition_target', SEED.profileB, 'energy_kcal', 2200, 'kcal');
    const res = await effective(SEED.accountB, SEED.profileB);
    expect(res.body.resolved).not.toHaveProperty('energy');
    expect(res.body.unresolved_fields.filter((u: { reason: string }) => u.reason === 'conflicting_rows').map((u: { field_name: string }) => u.field_name).sort()).toEqual(['calories', 'energy_kcal']);
  });

  it('a new canonical target supersedes the legacy alias rows of the same key', async () => {
    const res = await as(SEED.accountB).post(userTargets(SEED.profileB), { field_name: 'calories', value: 2000, unit: 'kcal' });
    expect(res.body).toMatchObject({ field_name: 'energy', value: 2000 });
    const legacy = await pool.query("select field_name, is_active, superseded_at is not null as superseded from nutrition_target where profile_id = $1 and field_name in ('calories', 'energy_kcal') order by field_name", [SEED.profileB]);
    expect(legacy.rows).toEqual([
      { field_name: 'calories', is_active: false, superseded: true },
      { field_name: 'energy_kcal', is_active: false, superseded: true },
    ]);
    const resolved = await effective(SEED.accountB, SEED.profileB);
    expect(resolved.body.resolved.energy).toMatchObject({ value: 2000, source: 'user_target', source_reference: res.body.id });
    // an unknown legacy name is left as it is (still reported)
    expect(resolved.body.unresolved_fields).toEqual(expect.arrayContaining([expect.objectContaining({ field_name: 'resolver_calories', reason: 'unknown_target_key' })]));
  });
});

describe('M/N: Daily Tracker compares the calories alias through energy', () => {
  it('an energy target entered as "calories" is compared with energy, not listed as unmapped', async () => {
    const tz = 'UTC';
    const meal = await as(SEED.accountFullManagement).post(`/v1/profiles/${SEED.profileChild}/meals`, {
      meal_type: 'lunch',
      logged_date: TODAY,
      local_timezone: tz,
      consumed_at: `${TODAY}T00:00:01Z`,
      items: [{ type: 'food', food_id: F.rice, quantity: 100, unit: 'g' }],
    });
    expect(meal.status).toBe(201);
    // pediatric scope keeps its approved NutritionTarget write; no calorie formula is involved
    expect((await as(SEED.accountPediatric).post(userTargets(SEED.profileChild), { field_name: 'calories', value: 1500, unit: 'kcal' })).status).toBe(201);
    const res = await as(SEED.accountPediatric).get(`/v1/profiles/${SEED.profileChild}/daily-tracker`, { date: TODAY, timezone: tz });
    expect(res.status).toBe(200);
    expect(res.body.target.fields).toEqual([expect.objectContaining({ field_name: 'energy', value: 1500, unit: 'kcal', source: 'user_target' })]);
    expect(res.body.comparison.unmapped_targets).toEqual([]);
    expect(res.body.comparison.nutrients).toEqual([
      expect.objectContaining({ nutrient_key: 'energy', comparison_status: 'below_target', actual: expect.objectContaining({ value: 130, coverage: 'complete' }), remaining: 1370 }),
    ]);
  });

  it('a legacy row the resolver cannot interpret reaches the tracker as unmapped, with its reason', async () => {
    const res = await as(SEED.accountB).get(`/v1/profiles/${SEED.profileB}/daily-tracker`, { date: TODAY, timezone: 'UTC' });
    expect(res.body.comparison.unmapped_targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field_name: 'resolver_calories', reason: 'unknown_target_key' }),
        expect.objectContaining({ field_name: 'protein', source: 'clinician_target', reason: 'incompatible_unit' }),
      ]),
    );
    expect(res.body.comparison.nutrients.map((c: { nutrient_key: string }) => c.nutrient_key)).toEqual(['energy']);
  });
});
