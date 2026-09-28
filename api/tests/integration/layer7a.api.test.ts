// Layer 7A integration tests — actual food & meal logging against the real
// migration chain and RLS harness. Food data: tests/helpers/
// nutritionFixtures.ts; recipes are created through the Layer 6A API.
// TEST FIXTURES ONLY — not production food, recipe or consumption data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app';
import { logger } from '../../src/lib/logger';
import { PgHarnessProfileRepository } from '../helpers/pgHarnessProfileRepository';
import { PgHarnessScopedDbFactory } from '../helpers/pgHarnessScopedDb';
import { rebuildTestDatabase } from '../helpers/testDb';
import { seedScenario, SEED } from '../helpers/seed';
import { F, NUT, SRV, seedNutritionFixtures } from '../helpers/nutritionFixtures';
import { signTestToken, TEST_JWT_SECRET } from '../helpers/jwt';

let pool: Pool;
let app: ReturnType<typeof createApp>;

const as = (account: string) => ({
  get: (path: string) => request(app).get(path).set('Authorization', `Bearer ${signTestToken(account)}`),
  post: (path: string, body: unknown) => request(app).post(path).set('Authorization', `Bearer ${signTestToken(account)}`).send(body as object),
  patch: (path: string, body: unknown) => request(app).patch(path).set('Authorization', `Bearer ${signTestToken(account)}`).send(body as object),
});
const A = () => as(SEED.accountA);
const mealsOf = (profile: string) => `/v1/profiles/${profile}/meals`;
const PROFILE_A2 = 'b0b0b0b0-0000-4000-8000-0000000000a2'; // a second profile owned by account A

// A past local day in Dubai: 07:30Z = 11:30 local on 2026-09-20.
const DAY = { logged_date: '2026-09-20', local_timezone: 'Asia/Dubai' };
const AT = '2026-09-20T07:30:00Z';

type Nutrient = { nutrient_key: string; value: number | null; coverage: string; is_zero: boolean; missing: Array<{ index: number; status: string }> };
const nutrient = (agg: { nutrients: Nutrient[] }, key: string): Nutrient => {
  const n = agg.nutrients.find((x) => x.nutrient_key === key);
  if (!n) throw new Error(`no ${key}`);
  return n;
};
const riceItem = (grams: number) => ({ type: 'food', food_id: F.rice, quantity: grams, unit: 'g' });

async function asAccountSql(account: string, sql: string, params: unknown[] = [], commit = false) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [account]);
    await client.query('set local role authenticated');
    const result = await client.query(sql, params);
    await client.query(commit ? 'commit' : 'rollback');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

async function referenceSnapshot() {
  const { rows } = await pool.query(`
    select (select count(*)::int from food) as foods,
           (select count(*)::int from food_serving) as servings,
           (select count(*)::int from food_nutrient) as nutrients,
           (select md5(string_agg(id::text || amount_per_canonical_unit::text || source::text, ',' order by id)) from food_nutrient) as nutrient_hash,
           (select md5(string_agg(id::text || canonical_quantity::text, ',' order by id)) from food_serving) as serving_hash,
           (select md5(string_agg(id::text || coalesce(density_g_per_ml::text, '-'), ',' order by id)) from food) as food_hash`);
  return rows[0];
}

let recipeId: string;
let recipeV1: string;
let breakfastId: string;
let referenceBefore: unknown;

beforeAll(async () => {
  pool = await rebuildTestDatabase('recipebook_api_test_layer7a');
  await seedScenario(pool);
  await seedNutritionFixtures(pool);
  await pool.query("insert into profile (id, account_id, display_name, is_child) values ($1, $2, 'Profile A2', false)", [PROFILE_A2, SEED.accountA]);
  app = createApp({
    profileRepository: new PgHarnessProfileRepository(pool),
    scopedDbFactory: new PgHarnessScopedDbFactory(pool),
    jwtSecret: TEST_JWT_SECRET,
    logger,
  });
  // Recipe v1: rice 200 g + spinach 100 g, yield 4.
  const recipe = await A().post(`/v1/profiles/${SEED.profileA}/recipes`, {
    title: 'Fixture Rice & Spinach',
    servings: 4,
    ingredients: [
      { text: '200 g rice', food_id: F.rice, quantity: 200, unit: 'g' },
      { text: '100 g spinach', food_id: F.spinach, quantity: 100, unit: 'g' },
    ],
  });
  recipeId = recipe.body.id;
  recipeV1 = recipe.body.current_version.id;
  referenceBefore = await referenceSnapshot();
}, 60_000);

afterAll(async () => {
  await pool.end();
});

describe('A-F: MealLog and Food items', () => {
  it('A: creates an empty MealLog', async () => {
    const res = await A().post(mealsOf(SEED.profileA), { meal_type: 'snack', ...DAY, notes: '  afternoon  ' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ meal_type: 'snack', ...DAY, notes: 'afternoon', item_count: 0, items: [] });
    expect(res.body.nutrition).toMatchObject({ item_count: 0, active_item_ids: [] });
    expect(res.body.nutrition.summary.energy_kcal).toMatchObject({ value: null, coverage: 'unavailable' });
  });

  it('B/C/D/E/F: creates a meal with Food items atomically, by grams and by FoodServing', async () => {
    const res = await A().post(mealsOf(SEED.profileA), {
      meal_type: 'breakfast',
      ...DAY,
      consumed_at: AT,
      items: [riceItem(150), { type: 'food', food_id: F.bread, quantity: 2, serving_id: SRV.breadSlice }],
    });
    expect(res.status).toBe(201);
    breakfastId = res.body.id;
    const [rice, bread] = res.body.items;
    expect(rice).toMatchObject({
      source_type: 'food',
      food: { food_id: F.rice, canonical_name: 'fixture5b_rice_cooked' },
      recipe: null,
      amount: { quantity: 150, unit: 'g', serving_id: null },
      status: 'consumed',
      consumed_at: '2026-09-20T07:30:00.000Z',
      is_active: true,
      logged_by_actor_type: 'user',
    });
    expect(bread).toMatchObject({ amount: { quantity: 2, unit: null, serving_id: SRV.breadSlice, serving_description: '1 slice' } });
    // F: Layer 5C summary of each item's recorded snapshot
    expect(rice.nutrition).toMatchObject({ basis: 'recorded_snapshot', calculation_version: 'nutrition-calculation-5b.1', conversion_version: 'conversion-5a.1' });
    expect(rice.nutrition.summary.protein_g).toMatchObject({ value: 4.05, coverage: 'complete' });
    expect(bread.nutrition.summary.protein_g).toMatchObject({ value: 5.4, coverage: 'complete' }); // 2 x 30 g

    // E: identical to the Layer 5B calculator for the same input
    const calc = await A().post('/v1/nutrition/calculate', { items: [{ food_id: F.rice, quantity: 150, unit: 'g' }, { food_id: F.bread, quantity: 2, serving_id: SRV.breadSlice }] });
    const detail = await A().get(`${mealsOf(SEED.profileA)}/${breakfastId}/items/${rice.id}`);
    for (const n of calc.body.items[0].nutrients) {
      expect(nutrient(detail.body.nutrition, n.nutrient_key).value).toBe(n.value);
    }
    expect(detail.body.nutrition.provenance).toMatchObject({ normalized_quantity: { quantity: 150, unit: 'g' } });
    expect(detail.body.nutrition.provenance.nutrients.find((n: { nutrient_key: string }) => n.nutrient_key === 'protein').source).toMatchObject({ source: 'trusted_database', authority: 'global_reference' });
  });

  it('a failing item leaves no partial meal (atomic create)', async () => {
    const before = await pool.query('select (select count(*)::int from meal_log) as logs, (select count(*)::int from meal_item) as items');
    const res = await A().post(mealsOf(SEED.profileA), { meal_type: 'lunch', ...DAY, consumed_at: AT, items: [riceItem(100), { type: 'food', food_id: F.rice, quantity: 1, serving_id: SRV.breadSlice }] });
    expect(res.status).toBe(400);
    expect(res.body.error.details.issues).toEqual([expect.objectContaining({ path: 'items.1.serving_id' })]);
    const after = await pool.query('select (select count(*)::int from meal_log) as logs, (select count(*)::int from meal_item) as items');
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});

describe('G-N: Recipe items, aggregation and completeness', () => {
  it('G/H/I: logs 1.5 servings of an exact RecipeVersion = Layer 6A per serving x 1.5', async () => {
    const res = await A().post(`${mealsOf(SEED.profileA)}/${breakfastId}/items`, {
      consumed_at: AT,
      items: [{ type: 'recipe', recipe_id: recipeId, recipe_version_id: recipeV1, servings: 1.5 }],
    });
    expect(res.status).toBe(201);
    const item = res.body.items[2];
    expect(item).toMatchObject({ source_type: 'recipe', recipe: { recipe_id: recipeId, recipe_version_id: recipeV1, version_number: 1, title: 'Fixture Rice & Spinach' }, amount: { servings: 1.5 } });
    const recipeNutrition = await A().get(`/v1/profiles/${SEED.profileA}/recipes/${recipeId}/versions/${recipeV1}/nutrition`);
    const perServingProtein = nutrient(recipeNutrition.body.per_serving, 'protein').value ?? 0;
    expect(item.nutrition.summary.protein_g.value).toBeCloseTo(perServingProtein * 1.5, 6); // (5.4 + 2.9) / 4 x 1.5
    expect(item.nutrition.summary.protein_g).toMatchObject({ value: 3.1125, coverage: 'complete' });
    // energy: spinach has none -> the recipe (and this item) is partial, not complete
    expect(item.nutrition.summary.energy_kcal).toMatchObject({ value: 97.5, coverage: 'partial' });
  });

  it('J/K/L/M/N: the meal aggregates its items from their snapshots', async () => {
    const res = await A().get(`${mealsOf(SEED.profileA)}/${breakfastId}/nutrition`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ basis: 'recorded_snapshots', item_count: 3 });
    expect(res.body.items).toHaveLength(3);
    // K: protein known for all three -> complete: 4.05 + 5.4 + 3.1125
    expect(nutrient(res.body, 'protein')).toMatchObject({ value: 12.5625, coverage: 'complete' });
    expect(res.body.summary.protein_g).toMatchObject({ value: 12.5625, coverage: 'complete' });
    // L: energy: rice 195 + bread 159 complete, recipe 97.5 partial -> partial
    expect(nutrient(res.body, 'energy')).toMatchObject({ value: 451.5, coverage: 'partial', missing: [{ index: 2, status: 'partial_contribution' }] });
    // L: iron: bread unknown -> partial lower bound 1.8 + 1.9125
    expect(nutrient(res.body, 'iron')).toMatchObject({ value: 3.7125, coverage: 'partial' });
    // M: calcium known for none -> unavailable, null
    expect(nutrient(res.body, 'calcium')).toMatchObject({ value: null, coverage: 'unavailable' });
    // N: vitamin D: rice 0 (known zero) but bread unknown -> partial 0; a rice-only meal is a complete zero
    const riceOnly = await A().post(mealsOf(SEED.profileA), { meal_type: 'dinner', ...DAY, consumed_at: AT, items: [riceItem(100)] });
    const riceNutrition = await A().get(`${mealsOf(SEED.profileA)}/${riceOnly.body.id}/nutrition`);
    expect(nutrient(riceNutrition.body, 'vitamin_d')).toMatchObject({ value: 0, is_zero: true, coverage: 'complete' });
  });

  it('keeps each item\'s own source and nutrition — no flattening', async () => {
    const res = await A().get(`${mealsOf(SEED.profileA)}/${breakfastId}`);
    expect(res.body.items.map((i: { source_type: string }) => i.source_type)).toEqual(['food', 'food', 'recipe']);
    expect(res.body.items.every((i: { nutrition: unknown }) => i.nutrition !== null)).toBe(true);
  });
});

describe('U: recipe history — consumed RecipeVersion never moves', () => {
  it('editing the recipe after consumption leaves the item on version 1 with an unchanged snapshot', async () => {
    const meal = await A().get(`${mealsOf(SEED.profileA)}/${breakfastId}`);
    const itemId = meal.body.items[2].id;
    const before = await A().get(`${mealsOf(SEED.profileA)}/${breakfastId}/items/${itemId}`);
    const stored = await pool.query('select nutrition_snapshot, recipe_version_id from meal_item where id = $1', [itemId]);

    const edited = await A().patch(`/v1/profiles/${SEED.profileA}/recipes/${recipeId}`, {
      servings: 2,
      ingredients: [{ text: '400 g rice', food_id: F.rice, quantity: 400, unit: 'g' }],
    });
    expect(edited.body.current_version.version_number).toBe(2);

    const after = await A().get(`${mealsOf(SEED.profileA)}/${breakfastId}/items/${itemId}`);
    expect(after.body).toEqual(before.body);
    expect(after.body.recipe.recipe_version_id).toBe(recipeV1);
    const storedAfter = await pool.query('select nutrition_snapshot, recipe_version_id from meal_item where id = $1', [itemId]);
    expect(storedAfter.rows[0]).toEqual(stored.rows[0]);
  });
});

describe('V: reference-data change after consumption', () => {
  it('historical nutrition stays identical; a new item uses the new reference value', async () => {
    // 1-3: trusted nutrition exists; log it; capture
    const meal = await A().post(mealsOf(SEED.profileA), { meal_type: 'lunch', ...DAY, consumed_at: AT, items: [{ type: 'food', food_id: F.noEnergy, quantity: 200, unit: 'g' }] });
    const itemId = meal.body.items[0].id;
    const before = await A().get(`${mealsOf(SEED.profileA)}/${meal.body.id}/items/${itemId}`);
    const mealBefore = await A().get(`${mealsOf(SEED.profileA)}/${meal.body.id}/nutrition`);
    expect(before.body.nutrition.summary.protein_g.value).toBe(20);

    // 4: trusted admin path changes the reference value (10 -> 12 g / 100 g)
    const updated = await pool.query("update food_nutrient set amount_per_canonical_unit = 12 where food_id = $1 and nutrient_id = $2 and source = 'trusted_database'", [F.noEnergy, NUT.protein]);
    expect(updated.rowCount).toBe(1);
    try {
      // 5/6: history is unchanged
      const after = await A().get(`${mealsOf(SEED.profileA)}/${meal.body.id}/items/${itemId}`);
      expect(after.body).toEqual(before.body);
      expect((await A().get(`${mealsOf(SEED.profileA)}/${meal.body.id}/nutrition`)).body).toEqual(mealBefore.body);
      // 7: a new item logged afterwards uses the new value
      const added = await A().post(`${mealsOf(SEED.profileA)}/${meal.body.id}/items`, { consumed_at: AT, items: [{ type: 'food', food_id: F.noEnergy, quantity: 200, unit: 'g' }] });
      expect(added.body.items[1].nutrition.summary.protein_g.value).toBe(24);
      expect(added.body.items[0].nutrition.summary.protein_g.value).toBe(20);
    } finally {
      await pool.query("update food_nutrient set amount_per_canonical_unit = 10 where food_id = $1 and nutrient_id = $2 and source = 'trusted_database'", [F.noEnergy, NUT.protein]);
    }
  });
});

describe('O-T: immutability and corrections', () => {
  let mealId: string;
  let originalId: string;
  let correctionId: string;

  it('O: a consumed item cannot be edited (no route; database refuses)', async () => {
    const meal = await A().post(mealsOf(SEED.profileA), { meal_type: 'dinner', ...DAY, consumed_at: AT, items: [riceItem(150)] });
    mealId = meal.body.id;
    originalId = meal.body.items[0].id;
    expect((await A().patch(`${mealsOf(SEED.profileA)}/${mealId}/items/${originalId}`, { quantity: 120 })).status).toBe(404);
    expect((await request(app).delete(`${mealsOf(SEED.profileA)}/${mealId}/items/${originalId}`).set('Authorization', `Bearer ${signTestToken(SEED.accountA)}`)).status).toBe(404);
    for (const set of ["quantity = 120", "nutrition_snapshot = '{}'::jsonb", "consumed_at = now()", "food_id = null", "nutrition_calculation_version = 'x'"]) {
      await expect(asAccountSql(SEED.accountA, `update meal_item set ${set} where id = $1`, [originalId])).rejects.toThrow(/consumed items are immutable/);
    }
    await expect(asAccountSql(SEED.accountA, 'delete from meal_item where id = $1', [originalId])).rejects.toThrow(/permission denied/);
  });

  it('S: a correction reason is required', async () => {
    const res = await A().post(`${mealsOf(SEED.profileA)}/${mealId}/items/${originalId}/correct`, { item: riceItem(120) });
    expect(res.status).toBe(400);
    expect((await A().post(`${mealsOf(SEED.profileA)}/${mealId}/items/${originalId}/correct`, { correction_reason: ' ', item: riceItem(120) })).status).toBe(400);
  });

  it('P/Q/R: 150 g -> 120 g creates a new consumed item; the original stays; links and audit are written', async () => {
    const auditBefore = await pool.query('select count(*)::int as n from audit_event');
    const res = await A().post(`${mealsOf(SEED.profileA)}/${mealId}/items/${originalId}/correct`, { correction_reason: 'Weighed it again', item: riceItem(120) });
    expect(res.status).toBe(201);
    correctionId = res.body.id;
    expect(res.body).toMatchObject({
      status: 'consumed',
      is_active: true,
      consumed_at: '2026-09-20T07:30:00.000Z', // defaults to the original's
      amount: { quantity: 120, unit: 'g' },
      correction: { corrects_meal_item_id: originalId, superseded_by_meal_item_id: null, correction_reason: 'Weighed it again' },
    });
    expect(res.body.nutrition.summary.protein_g.value).toBe(3.24);

    const original = await A().get(`${mealsOf(SEED.profileA)}/${mealId}/items/${originalId}`);
    expect(original.body).toMatchObject({ is_active: false, amount: { quantity: 150 }, correction: { superseded_by_meal_item_id: correctionId } });
    expect(original.body.nutrition.summary.protein_g.value).toBe(4.05); // both snapshots independently queryable

    // aggregate uses the correction only — no double count
    const nutrition = await A().get(`${mealsOf(SEED.profileA)}/${mealId}/nutrition`);
    expect(nutrition.body).toMatchObject({ active_item_ids: [correctionId], excluded_item_ids: [originalId] });
    expect(nutrition.body.summary.protein_g.value).toBe(3.24);

    // audit: exactly one event, fields derived by the database
    const audit = await pool.query("select * from audit_event where event_type = 'meal_item_corrected' and subject_id = $1", [originalId]);
    expect((await pool.query('select count(*)::int as n from audit_event')).rows[0].n).toBe(auditBefore.rows[0].n + 1);
    expect(audit.rows[0]).toMatchObject({
      actor_account_id: SEED.accountA,
      actor_type: 'user',
      subject_type: 'meal_item',
      event_payload: { original_meal_item_id: originalId, correction_meal_item_id: correctionId, meal_log_id: mealId, profile_id: SEED.profileA },
    });
    expect(JSON.stringify(audit.rows[0].event_payload)).not.toMatch(/Weighed|quantity|protein/);
  });

  it('T: the original cannot be superseded twice; AG: the error does not leak SQL', async () => {
    const res = await A().post(`${mealsOf(SEED.profileA)}/${mealId}/items/${originalId}/correct`, { correction_reason: 'again', item: riceItem(100) });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).not.toMatch(/meal_item|superseded_by|select|constraint|violat/i);
    // even bypassing the API check, the database refuses
    await expect(
      asAccountSql(SEED.accountA, 'select correct_meal_item($1, $2, $3, $4, $5)', [SEED.profileA, mealId, originalId, { food_id: F.rice, unit: 'g', quantity: 1, consumed_at: AT, nutrition_snapshot: {}, nutrition_calculation_version: 'x' }, 'again']),
    ).rejects.toThrow(/already been corrected/);
    // a correction can itself be corrected (chain), once
    const chained = await A().post(`${mealsOf(SEED.profileA)}/${mealId}/items/${correctionId}/correct`, { correction_reason: 'scale was off', item: riceItem(110) });
    expect(chained.status).toBe(201);
  });

  it('supersession cannot change anything else in the same UPDATE', async () => {
    const meal = await A().post(mealsOf(SEED.profileA), { meal_type: 'snack', ...DAY, consumed_at: AT, items: [riceItem(50), riceItem(60)] });
    const [a, b] = meal.body.items.map((i: { id: string }) => i.id);
    // a correction row the test inserts directly (as superuser) so the only
    // variable is the UPDATE under test
    const client = await pool.connect();
    try {
      await client.query('begin');
      const snap = (await client.query('select nutrition_snapshot from meal_item where id = $1', [a])).rows[0].nutrition_snapshot;
      const { rows } = await client.query(
        `insert into meal_item (meal_log_id, profile_id, food_id, unit, quantity, status, consumed_at, status_changed_by_account_id, corrects_meal_item_id, correction_reason, nutrition_snapshot, nutrition_calculation_version, nutrition_calculated_at)
         values ($1, $2, $3, 'g', 40, 'consumed', $4, $5, $6, 'fix', $7, 'nutrition-calculation-5b.1', now()) returning id`,
        [meal.body.id, SEED.profileA, F.rice, AT, SEED.accountA, a, snap],
      );
      const fix = rows[0].id;
      for (const extra of ['quantity = 999', "nutrition_snapshot = '{}'::jsonb", 'consumed_at = now()', "unit = 'kg'", 'food_id = null', "correction_reason = 'x'", "nutrition_calculation_version = 'x'", 'nutrition_calculated_at = now()']) {
        await client.query('savepoint s');
        await expect(client.query(`update meal_item set superseded_by_meal_item_id = $1, ${extra} where id = $2`, [fix, a])).rejects.toThrow(/immutable except for superseded_by_meal_item_id/);
        await client.query('rollback to savepoint s');
      }
      // pointing at an item that is not a correction of this one is refused
      await client.query('savepoint s');
      await expect(client.query('update meal_item set superseded_by_meal_item_id = $1 where id = $2', [b, a])).rejects.toThrow(/must reference a correction of this item/);
      await client.query('rollback to savepoint s');
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  it('correction atomicity: a failing correction persists nothing; a correction row alone cannot commit', async () => {
    const meal = await A().post(mealsOf(SEED.profileA), { meal_type: 'snack', ...DAY, consumed_at: AT, items: [riceItem(70)] });
    const itemId = meal.body.items[0].id;
    const counts = async () =>
      (await pool.query('select (select count(*)::int from meal_item) as items, (select count(*)::int from audit_event) as audits, (select superseded_by_meal_item_id from meal_item where id = $1) as superseded', [itemId])).rows[0];
    const before = await counts();
    // the correction's consumed_at is on another local day -> the database refuses the whole transaction
    await expect(
      asAccountSql(
        SEED.accountA,
        'select correct_meal_item($1, $2, $3, $4, $5)',
        [SEED.profileA, meal.body.id, itemId, { food_id: F.rice, unit: 'g', quantity: 1, consumed_at: '2026-09-25T07:00:00Z', nutrition_snapshot: {}, nutrition_calculation_version: 'x' }, 'x'],
        true,
      ),
    ).rejects.toThrow(/logged_date/);
    expect(await counts()).toEqual(before);
    // inserting a correction without superseding the original fails at commit
    const snap = (await pool.query('select nutrition_snapshot from meal_item where id = $1', [itemId])).rows[0].nutrition_snapshot;
    await expect(
      asAccountSql(
        SEED.accountA,
        `insert into meal_item (meal_log_id, profile_id, food_id, unit, quantity, status, consumed_at, status_changed_by_account_id, corrects_meal_item_id, correction_reason, nutrition_snapshot, nutrition_calculation_version, nutrition_calculated_at)
         values ($1, $2, $3, 'g', 40, 'consumed', $4, $5, $6, 'fix', $7, 'v', now())`,
        [meal.body.id, SEED.profileA, F.rice, AT, SEED.accountA, itemId, snap],
        true,
      ),
    ).rejects.toThrow(/must supersede its original/);
    expect(await counts()).toEqual(before);
  });

  it('clients cannot read or write AuditEvent directly', async () => {
    await expect(asAccountSql(SEED.accountA, 'select * from audit_event')).rejects.toThrow(/permission denied/);
    await expect(
      asAccountSql(SEED.accountA, "insert into audit_event (actor_type, event_type, subject_type, subject_id, occurred_at) values ('user', 'meal_item_corrected', 'meal_item', $1, now())", [originalId]),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('Time and local day', () => {
  it('consumed_at must fall on logged_date in local_timezone', async () => {
    // 22:30Z = 02:30 next day in Dubai, 18:30 same day in New York
    const late = '2026-09-20T22:30:00Z';
    const dubai = await A().post(mealsOf(SEED.profileA), { meal_type: 'snack', logged_date: '2026-09-20', local_timezone: 'Asia/Dubai', consumed_at: late, items: [riceItem(10)] });
    expect(dubai.status).toBe(400);
    expect(dubai.body.error.details.issues[0]).toMatchObject({ path: 'items.0.consumed_at' });
    expect((await A().post(mealsOf(SEED.profileA), { meal_type: 'snack', logged_date: '2026-09-21', local_timezone: 'Asia/Dubai', consumed_at: late, items: [riceItem(10)] })).status).toBe(201);
    expect((await A().post(mealsOf(SEED.profileA), { meal_type: 'snack', logged_date: '2026-09-20', local_timezone: 'America/New_York', consumed_at: late, items: [riceItem(10)] })).status).toBe(201);
  });

  it('consumed_at is when it was eaten, not when it was logged; the future is refused', async () => {
    const created = await A().post(mealsOf(SEED.profileA), { meal_type: 'snack', ...DAY, consumed_at: AT, items: [riceItem(10)] });
    expect(created.body.items[0].consumed_at).toBe('2026-09-20T07:30:00.000Z');
    expect(Date.parse(created.body.items[0].created_at)).toBeGreaterThan(Date.parse(AT));
    const tomorrow = new Date(Date.now() + 86_400_000);
    const tomorrowDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC' }).format(tomorrow);
    const future = await A().post(mealsOf(SEED.profileA), { meal_type: 'snack', logged_date: tomorrowDate, local_timezone: 'UTC', consumed_at: tomorrow.toISOString(), items: [riceItem(10)] });
    expect(future.status).toBe(400);
    expect(future.body.error.details.issues[0].message).toMatch(/future/);
  });

  it('rejects offsets/abbreviations as time zones and timestamps without an offset', async () => {
    for (const local_timezone of ['+04:00', 'EST', 'Mars/Olympus']) {
      expect((await A().post(mealsOf(SEED.profileA), { meal_type: 'snack', logged_date: '2026-09-20', local_timezone })).status).toBe(400);
    }
    expect((await A().post(mealsOf(SEED.profileA), { meal_type: 'snack', ...DAY, consumed_at: '2026-09-20T07:30:00', items: [riceItem(10)] })).status).toBe(400);
    expect((await A().post(mealsOf(SEED.profileA), { meal_type: 'snack', ...DAY, items: [riceItem(10)] })).body.error.details.issues[0].path).toBe('items.0.consumed_at');
    // the database refuses a non-IANA zone and a wrong local day on its own
    await expect(pool.query("insert into meal_log (profile_id, meal_type, logged_date, local_timezone) values ($1, 'snack', '2026-09-20', '+04:00')", [SEED.profileA])).rejects.toThrow(/IANA/);
  });

  it('a meal\'s date and zone are fixed once it holds consumed items', async () => {
    await expect(asAccountSql(SEED.accountA, "update meal_log set logged_date = '2026-09-19' where id = $1", [breakfastId])).rejects.toThrow(/fixed once the meal holds consumed items/);
    await expect(asAccountSql(SEED.accountA, "update meal_log set local_timezone = 'UTC' where id = $1", [breakfastId])).rejects.toThrow(/fixed/);
  });
});

describe('W/X/Y/Z: authority and references', () => {
  it('W/X: explicit personal quantities created no FoodServing and no FoodNutrient; reference data unchanged', async () => {
    const res = await A().post(mealsOf(SEED.profileA), { meal_type: 'lunch', ...DAY, consumed_at: AT, items: [riceItem(125)] });
    expect(res.status).toBe(201);
    const { rows } = await pool.query('select count(*)::int as n from food_serving where food_id = $1 or canonical_quantity = 125', [F.rice]);
    expect(rows[0].n).toBe(0);
    expect(await referenceSnapshot()).toEqual(referenceBefore);
  });

  it('Y: a FoodServing of another Food is rejected', async () => {
    const res = await A().post(mealsOf(SEED.profileA), { meal_type: 'lunch', ...DAY, consumed_at: AT, items: [{ type: 'food', food_id: F.rice, quantity: 1, serving_id: SRV.breadSlice }] });
    expect(res.status).toBe(400);
    expect(res.body.error.details.issues[0].path).toBe('items.0.serving_id');
  });

  it('Z: a RecipeVersion of another Recipe, and a Recipe of another Profile, are rejected', async () => {
    const other = await A().post(`/v1/profiles/${SEED.profileA}/recipes`, { title: 'Fixture Other', servings: 1, ingredients: [{ text: 'rice', food_id: F.rice, quantity: 10, unit: 'g' }] });
    const wrongVersion = await A().post(mealsOf(SEED.profileA), { meal_type: 'lunch', ...DAY, consumed_at: AT, items: [{ type: 'recipe', recipe_id: recipeId, recipe_version_id: other.body.current_version.id, servings: 1 }] });
    expect(wrongVersion.status).toBe(400);
    expect(wrongVersion.body.error.details.issues[0].path).toBe('items.0.recipe_version_id');

    const bRecipe = await as(SEED.accountB).post(`/v1/profiles/${SEED.profileB}/recipes`, { title: 'Fixture B', servings: 1, ingredients: [{ text: 'rice', food_id: F.rice, quantity: 10, unit: 'g' }] });
    const foreign = await A().post(mealsOf(SEED.profileA), { meal_type: 'lunch', ...DAY, consumed_at: AT, items: [{ type: 'recipe', recipe_id: bRecipe.body.id, recipe_version_id: bRecipe.body.current_version.id, servings: 1 }] });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.details.issues[0].path).toBe('items.0.recipe_id');

    // same-Profile rule holds in the database too: account A's OTHER profile cannot consume profile A's recipe
    const a2Meal = await A().post(mealsOf(PROFILE_A2), { meal_type: 'lunch', ...DAY });
    const sameAccount = await A().post(mealsOf(PROFILE_A2), { meal_type: 'lunch', ...DAY, consumed_at: AT, items: [{ type: 'recipe', recipe_id: recipeId, recipe_version_id: recipeV1, servings: 1 }] });
    expect(sameAccount.status).toBe(400);
    const snap = (await pool.query('select nutrition_snapshot from meal_item where recipe_version_id = $1 limit 1', [recipeV1])).rows[0].nutrition_snapshot;
    await expect(
      asAccountSql(
        SEED.accountA,
        "insert into meal_item (meal_log_id, profile_id, recipe_version_id, quantity, status, consumed_at, status_changed_by_account_id, nutrition_snapshot, nutrition_calculation_version, nutrition_calculated_at) values ($1, $2, $3, 1, 'consumed', $4, $5, $6, 'v', now())",
        [a2Meal.body.id, PROFILE_A2, recipeV1, AT, SEED.accountA, snap],
      ),
    ).rejects.toThrow(/same profile/);
  });
});

describe('Profile consistency and consumed invariants (database)', () => {
  it('an item cannot be attached to another Profile\'s MealLog, even by an Account managing both', async () => {
    const a2Meal = await A().post(mealsOf(PROFILE_A2), { meal_type: 'lunch', ...DAY });
    const snap = (await pool.query('select nutrition_snapshot from meal_item where food_id = $1 limit 1', [F.rice])).rows[0].nutrition_snapshot;
    await expect(
      asAccountSql(
        SEED.accountA,
        "insert into meal_item (meal_log_id, profile_id, food_id, unit, quantity, status, consumed_at, status_changed_by_account_id, nutrition_snapshot, nutrition_calculation_version, nutrition_calculated_at) values ($1, $2, $3, 'g', 1, 'consumed', $4, $5, $6, 'v', now())",
        [a2Meal.body.id, SEED.profileA, F.rice, AT, SEED.accountA, snap],
      ),
    ).rejects.toThrow(/fk_meal_item_meal_log_profile/);
  });

  it('a consumed item without a snapshot, without a source, or with both sources is refused', async () => {
    const insert = (cols: string, vals: string, params: unknown[]) =>
      pool.query(`insert into meal_item (meal_log_id, profile_id, quantity, status, consumed_at, status_changed_by_account_id, ${cols}) values ($1, $2, 1, 'consumed', $3, $4, ${vals})`, [breakfastId, SEED.profileA, AT, SEED.accountA, ...params]);
    await expect(insert('food_id, unit', "$5, 'g'", [F.rice])).rejects.toThrow(/meal_item_consumed_snapshot/);
    await expect(insert('nutrition_snapshot, nutrition_calculation_version, nutrition_calculated_at', "'{}', 'v', now()", [])).rejects.toThrow(/meal_item_consumed_has_source/);
    // both sources (with an otherwise valid food amount, so only the source rules can object)
    await expect(insert('food_id, unit, recipe_version_id, nutrition_snapshot, nutrition_calculation_version, nutrition_calculated_at', "$5, 'g', $6, '{}', 'v', now()", [F.rice, recipeV1])).rejects.toThrow(
      /meal_item_single_source|meal_item_consumed_has_source|meal_item_recipe_amount/,
    );
    await expect(pool.query("insert into meal_item (meal_log_id, profile_id, quantity, food_id, recipe_version_id, status_changed_by_account_id) values ($1, $2, 1, $3, $4, $5)", [breakfastId, SEED.profileA, F.rice, recipeV1, SEED.accountA])).rejects.toThrow(/meal_item_single_source/);
    await expect(insert('food_id, unit, food_serving_id, nutrition_snapshot, nutrition_calculation_version, nutrition_calculated_at', "$5, 'g', $6, '{}', 'v', now()", [F.bread, SRV.breadSlice])).rejects.toThrow(
      /meal_item_unit_xor_serving|meal_item_consumed_food_amount/,
    );
    await expect(pool.query("insert into meal_item (meal_log_id, profile_id, quantity, food_id, unit, food_serving_id, status_changed_by_account_id) values ($1, $2, 1, $3, 'g', $4, $5)", [breakfastId, SEED.profileA, F.bread, SRV.breadSlice, SEED.accountA])).rejects.toThrow(/meal_item_unit_xor_serving/);
    await expect(insert('food_id, food_serving_id, nutrition_snapshot, nutrition_calculation_version, nutrition_calculated_at', "$5, $6, '{}', 'v', now()", [F.rice, SRV.breadSlice])).rejects.toThrow(/fk_meal_item_food_serving_food/);
  });
});

describe('AA-AE: authorization follows the existing meal RLS', () => {
  const childMeal = { meal_type: 'lunch', ...DAY, consumed_at: AT, items: [riceItem(80)] };
  let childMealId: string;
  let childItemId: string;

  it('AD: full_management guardian logs and corrects for the child', async () => {
    const g = as(SEED.accountFullManagement);
    const res = await g.post(mealsOf(SEED.profileChild), childMeal);
    expect(res.status).toBe(201);
    childMealId = res.body.id;
    childItemId = res.body.items[0].id;
    const fixed = await g.post(`${mealsOf(SEED.profileChild)}/${childMealId}/items/${childItemId}/correct`, { correction_reason: 'less', item: riceItem(60) });
    expect(fixed.status).toBe(201);
    childItemId = fixed.body.id;
  });

  it('AC: view_only reads but cannot log, add or correct (403)', async () => {
    const v = as(SEED.accountViewOnly);
    expect((await v.get(`${mealsOf(SEED.profileChild)}/${childMealId}`)).status).toBe(200);
    expect((await v.get(`${mealsOf(SEED.profileChild)}/${childMealId}/nutrition`)).status).toBe(200);
    expect((await v.post(mealsOf(SEED.profileChild), childMeal)).status).toBe(403);
    expect((await v.post(`${mealsOf(SEED.profileChild)}/${childMealId}/items`, { consumed_at: AT, items: [riceItem(1)] })).status).toBe(403);
    expect((await v.post(`${mealsOf(SEED.profileChild)}/${childMealId}/items/${childItemId}/correct`, { correction_reason: 'x', item: riceItem(1) })).status).toBe(403);
    await expect(
      asAccountSql(SEED.accountViewOnly, 'select log_meal_items($1, null, $2)', [SEED.profileChild, { meal: { meal_type: 'lunch', ...DAY }, items: [] }]),
    ).rejects.toThrow(/row-level security/);
  });

  it('AE: pediatric_weight_management may log, read and correct (approved matrix) — logging only', async () => {
    const p = as(SEED.accountPediatric);
    const res = await p.post(mealsOf(SEED.profileChild), childMeal);
    expect(res.status).toBe(201);
    expect((await p.get(`${mealsOf(SEED.profileChild)}/${res.body.id}/nutrition`)).status).toBe(200);
    const fixed = await p.post(`${mealsOf(SEED.profileChild)}/${res.body.id}/items/${res.body.items[0].id}/correct`, { correction_reason: 'more', item: riceItem(90) });
    expect(fixed.status).toBe(201);
    expect(res.body).not.toHaveProperty('targets');
  });

  it('AB: a revoked guardian has no access (404)', async () => {
    const r = as(SEED.accountRevoked);
    expect((await r.get(mealsOf(SEED.profileChild))).status).toBe(404);
    expect((await r.get(`${mealsOf(SEED.profileChild)}/${childMealId}`)).status).toBe(404);
    expect((await r.post(mealsOf(SEED.profileChild), childMeal)).status).toBe(404);
  });

  it('AA: an unrelated Account cannot see or write another Profile\'s meals (404), even by id', async () => {
    const u = as(SEED.accountUnrelated);
    expect((await u.get(`${mealsOf(SEED.profileA)}/${breakfastId}`)).status).toBe(404);
    expect((await u.post(mealsOf(SEED.profileA), childMeal)).status).toBe(404);
    const b = as(SEED.accountB);
    expect((await b.get(`${mealsOf(SEED.profileB)}/${breakfastId}`)).status).toBe(404);
    expect((await b.get(`${mealsOf(SEED.profileB)}/${breakfastId}/nutrition`)).status).toBe(404);
    expect((await asAccountSql(SEED.accountB, 'select id from meal_log where id = $1', [breakfastId])).rows).toEqual([]);
    // cross-profile item reference through a URL is not found
    expect((await A().get(`${mealsOf(SEED.profileA)}/${breakfastId}/items/${childItemId}`)).status).toBe(404);
  });
});

describe('Trust boundary: clients submit consumption facts, never nutrition', () => {
  const forged = {
    snapshot_version: 'forged',
    source: { type: 'food', food_id: F.rice },
    nutrients: [{ nutrient_id: NUT.protein, nutrient_key: 'protein', unit: 'g', coverage: 'complete', status: 'resolved', value_exact: '999/1' }],
    provenance: { forged: true },
  };
  const storedSnapshot = async (id: string) =>
    (await pool.query('select nutrition_snapshot, nutrition_calculation_version from meal_item where id = $1', [id])).rows[0];

  it('A/C/D: POST /meals ignores a client-supplied nutrition_snapshot (item and request level); the server computes it', async () => {
    const res = await A().post(mealsOf(SEED.profileA), {
      meal_type: 'lunch',
      ...DAY,
      consumed_at: AT,
      nutrition_snapshot: forged,
      items: [{ ...riceItem(150), nutrition_snapshot: forged, nutrition_calculation_version: 'forged', nutrition: { protein_g: 999 }, status: 'draft' }],
    });
    expect(res.status).toBe(201);
    const item = res.body.items[0];
    expect(item.status).toBe('consumed');
    expect(item.nutrition.summary.protein_g.value).toBe(4.05); // 150 g rice, not 999
    const stored = await storedSnapshot(item.id);
    expect(stored.nutrition_calculation_version).toBe('nutrition-calculation-5b.1');
    expect(stored.nutrition_snapshot.snapshot_version).toBe('meal-item-snapshot-7a.1');
    expect(JSON.stringify(stored.nutrition_snapshot)).not.toMatch(/forged|999\/1/);
  });

  it('A/C/D: POST /meals/{id}/items ignores a client-supplied snapshot', async () => {
    const meal = await A().post(mealsOf(SEED.profileA), { meal_type: 'lunch', ...DAY });
    const res = await A().post(`${mealsOf(SEED.profileA)}/${meal.body.id}/items`, {
      consumed_at: AT,
      nutrition_snapshot: forged,
      items: [{ type: 'recipe', recipe_id: recipeId, recipe_version_id: recipeV1, servings: 1, nutrition_snapshot: forged }],
    });
    expect(res.status).toBe(201);
    const stored = await storedSnapshot(res.body.items[0].id);
    expect(stored.nutrition_snapshot.source).toMatchObject({ type: 'recipe', recipe_version_id: recipeV1 });
    expect(JSON.stringify(stored.nutrition_snapshot)).not.toMatch(/forged|999\/1/);
  });

  it('B/C/D: a correction accepts corrected facts only; its snapshot is computed by the server', async () => {
    const meal = await A().post(mealsOf(SEED.profileA), { meal_type: 'dinner', ...DAY, consumed_at: AT, items: [riceItem(150)] });
    const res = await A().post(`${mealsOf(SEED.profileA)}/${meal.body.id}/items/${meal.body.items[0].id}/correct`, {
      correction_reason: 'weighed again',
      nutrition_snapshot: forged,
      item: { ...riceItem(120), nutrition_snapshot: forged, nutrition_calculation_version: 'forged' },
    });
    expect(res.status).toBe(201);
    expect(res.body.nutrition.summary.protein_g.value).toBe(3.24); // 120 g rice
    const stored = await storedSnapshot(res.body.id);
    expect(stored.nutrition_calculation_version).toBe('nutrition-calculation-5b.1');
    expect(JSON.stringify(stored.nutrition_snapshot)).not.toMatch(/forged|999\/1/);

    // E: once written, the snapshot cannot be replaced — directly or during supersession
    await expect(asAccountSql(SEED.accountA, "update meal_item set nutrition_snapshot = $1 where id = $2", [forged, res.body.id])).rejects.toThrow(/consumed items are immutable/);
    // F: another Account cannot reach it at all
    expect((await as(SEED.accountB).get(`${mealsOf(SEED.profileA)}/${meal.body.id}/items/${res.body.id}`)).status).toBe(404);
    expect((await asAccountSql(SEED.accountB, 'select id from meal_item where id = $1', [res.body.id])).rows).toEqual([]);
  });
});

describe('AF: meal history pagination', () => {
  it('paginates with the shared cursor convention and filters by local date', async () => {
    const b = as(SEED.accountB);
    for (const [date, at] of [
      ['2026-09-18', '2026-09-18T08:00:00Z'],
      ['2026-09-19', '2026-09-19T08:00:00Z'],
      ['2026-09-20', '2026-09-20T08:00:00Z'],
    ]) {
      expect((await b.post(mealsOf(SEED.profileB), { meal_type: 'breakfast', logged_date: date, local_timezone: 'Europe/London', consumed_at: at, items: [riceItem(100)] })).status).toBe(201);
    }
    const first = await b.get(mealsOf(SEED.profileB)).query({ limit: 2 });
    expect(first.body.data.map((m: { logged_date: string }) => m.logged_date)).toEqual(['2026-09-20', '2026-09-19']);
    const second = await b.get(mealsOf(SEED.profileB)).query({ limit: 2, cursor: first.body.pagination.nextCursor });
    expect(second.body.data.map((m: { logged_date: string }) => m.logged_date)).toEqual(['2026-09-18']);
    expect(second.body.pagination.nextCursor).toBeNull();
    const ranged = await b.get(mealsOf(SEED.profileB)).query({ from: '2026-09-19', to: '2026-09-19' });
    expect(ranged.body.data).toEqual([expect.objectContaining({ logged_date: '2026-09-19', item_count: 1, active_item_count: 1 })]);
    expect((await b.get(mealsOf(SEED.profileB)).query({ from: '2026-09-20', to: '2026-09-19' })).status).toBe(400);
  });

  it('AG: validation errors are structured and contain no SQL', async () => {
    const res = await A().post(mealsOf(SEED.profileA), { meal_type: 'brunch', ...DAY });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(JSON.stringify(res.body)).not.toMatch(/insert|select|meal_log|pg_/i);
    expect((await A().get(`${mealsOf(SEED.profileA)}/not-a-uuid`)).status).toBe(400);
  });
});
