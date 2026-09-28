// Layer 8A integration tests — Meal Planning core (planned INTENT) against
// the real migration chain and RLS harness. Food data:
// tests/helpers/nutritionFixtures.ts; recipes/targets via the API.
// TEST FIXTURES ONLY — not production food, recipe, plan or target data.

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
  post: (path: string, body: unknown = {}) => request(app).post(path).set('Authorization', `Bearer ${signTestToken(account)}`).send(body as object),
  patch: (path: string, body: unknown) => request(app).patch(path).set('Authorization', `Bearer ${signTestToken(account)}`).send(body as object),
});
const A = () => as(SEED.accountA);
const plans = (profile: string) => `/v1/profiles/${profile}/meal-plans`;
const PROFILE_A2 = 'b0b0b0b0-0000-4000-8000-0000000000a2';
const PLAN = { name: 'Fixture week', start_date: '2026-10-10', end_date: '2026-10-12', local_timezone: 'Asia/Dubai' };
const rice = (grams: number) => ({ type: 'food', food_id: F.rice, quantity: grams, unit: 'g' });

type Nutrient = { nutrient_key: string; value: number | null; coverage: string };
const nutrient = (agg: { nutrients: Nutrient[] }, key: string) => {
  const n = agg.nutrients.find((x) => x.nutrient_key === key);
  if (!n) throw new Error(`no ${key}`);
  return n;
};
type ItemDto = { id: string; status: string; is_current: boolean; is_pending_replacement: boolean; source_type: string; nutrition: { summary: Record<string, { value: number | null; coverage: string }> } };
/** Planned nutrition only — the target block carries a per-request resolved_at. */
const nutritionOnly = (body: { days: unknown; whole_plan: unknown }) => ({ days: body.days, whole_plan: body.whole_plan });
const allItems = (plan: { days: Array<{ meals: Array<{ items: ItemDto[] }> }> }) => plan.days.flatMap((d) => d.meals.flatMap((m) => m.items));

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

async function worldCounts() {
  const { rows } = await pool.query(`select
    (select count(*)::int from meal_log) as meal_logs, (select count(*)::int from meal_item) as meal_items,
    (select count(*)::int from effective_target_snapshot) as target_snapshots,
    (select count(*)::int from food_serving) as food_servings, (select count(*)::int from food_nutrient) as food_nutrients,
    (select md5(string_agg(id::text || amount_per_canonical_unit::text, ',' order by id)) from food_nutrient) as food_nutrient_hash`);
  return rows[0];
}

let recipeId: string;
let recipeV1: string;
let planId: string;
let dayId: string;
let before: unknown;

beforeAll(async () => {
  pool = await rebuildTestDatabase('recipebook_api_test_layer8a');
  await seedScenario(pool);
  await seedNutritionFixtures(pool);
  await pool.query("insert into profile (id, account_id, display_name, is_child) values ($1, $2, 'Profile A2', false)", [PROFILE_A2, SEED.accountA]);
  app = createApp({
    profileRepository: new PgHarnessProfileRepository(pool),
    scopedDbFactory: new PgHarnessScopedDbFactory(pool),
    jwtSecret: TEST_JWT_SECRET,
    logger,
  });
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
  before = await worldCounts();
}, 60_000);

afterAll(async () => {
  await pool.end();
});

describe('A-F: plan, days and meals', () => {
  it('A: creates a draft MealPlan', async () => {
    const res = await A().post(plans(SEED.profileA), { ...PLAN, description: 'first try' });
    expect(res.status).toBe(201);
    planId = res.body.id;
    expect(res.body).toMatchObject({ ...PLAN, status: 'draft', description: 'first try', days: [], current_item_count: 0 });
    expect(res.body.nutrition).toMatchObject({ basis: 'no_planned_items' });
    expect(res.body.nutrition.summary.energy_kcal).toMatchObject({ value: 0, coverage: 'complete' });
    expect(res.body).not.toHaveProperty('created_by_account_id');
  });

  it('B: invalid date ranges and time zones are rejected', async () => {
    expect((await A().post(plans(SEED.profileA), { ...PLAN, start_date: '2026-10-12', end_date: '2026-10-10' })).status).toBe(400);
    expect((await A().post(plans(SEED.profileA), { ...PLAN, end_date: '2027-12-31' })).status).toBe(400);
    expect((await A().post(plans(SEED.profileA), { ...PLAN, local_timezone: '+04:00' })).status).toBe(400);
    expect((await A().post(plans(SEED.profileA), { ...PLAN, start_date: '2026-02-30' })).status).toBe(400);
  });

  it('C/D/E: adds a day; duplicates and out-of-range days are rejected (API and database)', async () => {
    const res = await A().post(`${plans(SEED.profileA)}/${planId}/days`, { plan_date: '2026-10-10' });
    expect(res.status).toBe(201);
    dayId = res.body.days[0].id;
    expect((await A().post(`${plans(SEED.profileA)}/${planId}/days`, { plan_date: '2026-10-10' })).status).toBe(409);
    const outside = await A().post(`${plans(SEED.profileA)}/${planId}/days`, { plan_date: '2026-10-13' });
    expect(outside.status).toBe(400);
    expect(outside.body.error.details.issues[0].path).toBe('plan_date');
    await expect(pool.query("insert into meal_plan_day (meal_plan_id, profile_id, plan_date) values ($1, $2, '2026-10-20')", [planId, SEED.profileA])).rejects.toThrow(/outside the meal plan date range/);
    await expect(pool.query("insert into meal_plan_day (meal_plan_id, profile_id, plan_date) values ($1, $2, '2026-10-10')", [planId, SEED.profileA])).rejects.toThrow(/uq_meal_plan_day_date/);
  });

  it('F/G/H/J/M: adds breakfast, lunch, dinner and snack with Food (grams, serving) and RecipeVersion items', async () => {
    const day = `${plans(SEED.profileA)}/${planId}/days/${dayId}/meals`;
    const breakfast = await A().post(day, { meal_type: 'breakfast', scheduled_local_time: '07:30', notes: 'before gym', items: [rice(150), { type: 'food', food_id: F.bread, quantity: 2, serving_id: SRV.breadSlice }] });
    expect(breakfast.status).toBe(201);
    expect((await A().post(day, { meal_type: 'lunch', items: [{ type: 'recipe', recipe_id: recipeId, recipe_version_id: recipeV1, servings: 1.5 }] })).status).toBe(201);
    expect((await A().post(day, { meal_type: 'dinner', position: 2 })).status).toBe(201);
    const snack = await A().post(day, { meal_type: 'snack', position: 3, items: [{ type: 'food', food_id: F.spinach, quantity: 50, unit: 'g' }] });
    expect(snack.status).toBe(201);
    const meals = snack.body.days[0].meals;
    expect(meals.map((m: { meal_type: string }) => m.meal_type)).toEqual(['breakfast', 'lunch', 'dinner', 'snack']);
    expect(meals[0]).toMatchObject({ scheduled_local_time: '07:30', notes: 'before gym' });
    const [riceItem, breadItem] = meals[0].items;
    expect(riceItem).toMatchObject({ source_type: 'food', status: 'draft', amount: { quantity: 150, unit: 'g', serving_id: null }, is_current: true });
    expect(breadItem).toMatchObject({ amount: { quantity: 2, serving_id: SRV.breadSlice, serving_description: '1 slice' } });
    expect(meals[1].items[0]).toMatchObject({ source_type: 'recipe', recipe: { recipe_id: recipeId, recipe_version_id: recipeV1, version_number: 1 }, amount: { servings: 1.5 } });
    expect(riceItem.nutrition).toMatchObject({ basis: 'live_calculation', calculated_at: null });
  });

  it('I/K/L: wrong serving, a version of another recipe, and another Profile\'s recipe are rejected', async () => {
    const day = `${plans(SEED.profileA)}/${planId}/days/${dayId}/meals`;
    const serving = await A().post(day, { meal_type: 'other', items: [{ type: 'food', food_id: F.rice, quantity: 1, serving_id: SRV.breadSlice }] });
    expect(serving.status).toBe(400);
    expect(serving.body.error.details.issues[0].path).toBe('items.0.serving_id');
    const other = await A().post(`/v1/profiles/${SEED.profileA}/recipes`, { title: 'Fixture Other', servings: 1, ingredients: [{ text: 'rice', food_id: F.rice, quantity: 10, unit: 'g' }] });
    const wrongVersion = await A().post(day, { meal_type: 'other', items: [{ type: 'recipe', recipe_id: recipeId, recipe_version_id: other.body.current_version.id, servings: 1 }] });
    expect(wrongVersion.body.error.details.issues[0].path).toBe('items.0.recipe_version_id');
    const bRecipe = await as(SEED.accountB).post(`/v1/profiles/${SEED.profileB}/recipes`, { title: 'Fixture B', servings: 1, ingredients: [{ text: 'rice', food_id: F.rice, quantity: 10, unit: 'g' }] });
    const foreign = await A().post(day, { meal_type: 'other', items: [{ type: 'recipe', recipe_id: bRecipe.body.id, recipe_version_id: bRecipe.body.current_version.id, servings: 1 }] });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.details.issues[0].path).toBe('items.0.recipe_id');
    // the database refuses the same even directly (composite FK / same-profile trigger)
    const meal = (await A().get(`${plans(SEED.profileA)}/${planId}`)).body.days[0].meals[0].id;
    await expect(
      asAccountSql(SEED.accountA, 'insert into planned_meal_item (planned_meal_id, profile_id, recipe_id, recipe_version_id, quantity) values ($1, $2, $3, $4, 1)', [meal, SEED.profileA, recipeId, other.body.current_version.id]),
    ).rejects.toThrow(/fk_planned_meal_item_recipe_version/);
    await expect(
      asAccountSql(SEED.accountA, 'insert into planned_meal_item (planned_meal_id, profile_id, recipe_id, recipe_version_id, quantity) values ($1, $2, $3, $4, 1)', [meal, SEED.profileA, bRecipe.body.id, bRecipe.body.current_version.id]),
    ).rejects.toThrow(/same profile/);
  });
});

describe('N-T: planned nutrition and target comparison', () => {
  it('N/O/P/Q/R/S: deterministic item, meal, day and plan nutrition with completeness', async () => {
    const plan = (await A().get(`${plans(SEED.profileA)}/${planId}`)).body;
    const [breakfast, lunch, dinner, snack] = plan.days[0].meals;
    // N: Food = the Layer 5B calculator
    expect(breakfast.items[0].nutrition.summary.protein_g).toMatchObject({ value: 4.05, coverage: 'complete' });
    // O: Recipe = Layer 6A per serving x 1.5
    const perServing = await A().get(`/v1/profiles/${SEED.profileA}/recipes/${recipeId}/versions/${recipeV1}/nutrition`);
    expect(lunch.items[0].nutrition.summary.protein_g.value).toBeCloseTo((nutrient(perServing.body.per_serving, 'protein').value ?? 0) * 1.5, 6);
    // P: meal = rice 4.05 + bread 5.4
    expect(breakfast.nutrition.summary.protein_g).toMatchObject({ value: 9.45, coverage: 'complete' });
    expect(dinner.nutrition).toMatchObject({ basis: 'no_planned_items' });
    // Q: day = 9.45 + 3.1125 + spinach 1.45
    expect(plan.days[0].nutrition.summary.protein_g).toMatchObject({ value: 14.0125, coverage: 'complete' });
    // R: energy: recipe partial (spinach has none), snack spinach none -> partial, never 0
    expect(plan.days[0].nutrition.summary.energy_kcal.coverage).toBe('partial');
    expect(snack.items[0].nutrition.summary.energy_kcal).toMatchObject({ value: null, coverage: 'unavailable' });
    expect(plan.includes_unconfirmed).toBe(true);

    // S: micronutrients through the same aggregate
    const n = await A().get(`${plans(SEED.profileA)}/${planId}/nutrition`);
    expect(nutrient(n.body.days[0], 'iron').coverage).toBe('partial');
    expect(nutrient(n.body.days[0], 'calcium')).toMatchObject({ value: null, coverage: 'unavailable' });
  });

  it('T: compares with the CURRENT target by canonical key, explicitly labelled', async () => {
    await A().post(`/v1/profiles/${SEED.profileA}/nutrition-targets`, { field_name: 'calories', value: 2000, unit: 'kcal' });
    await A().post(`/v1/profiles/${SEED.profileA}/nutrition-targets`, { field_name: 'protein', value: 50, unit: 'g' });
    const snapshotsBefore = (await pool.query('select count(*)::int as n from effective_target_snapshot')).rows[0].n;
    const res = await A().get(`${plans(SEED.profileA)}/${planId}/nutrition`);
    expect(res.status).toBe(200);
    expect(res.body.target_context).toBe('current_target_at_request_time');
    expect(res.body.target.fields.map((f: { field_name: string }) => f.field_name)).toEqual(['energy', 'protein']);
    const day = res.body.days[0];
    expect(day.comparison.find((c: { nutrient_key: string }) => c.nutrient_key === 'protein')).toMatchObject({ comparison_status: 'below_target', remaining: 35.9875 });
    expect(day.comparison.find((c: { nutrient_key: string }) => c.nutrient_key === 'energy')).toMatchObject({ comparison_status: 'undetermined', remaining: null });
    expect(res.body.whole_plan).not.toHaveProperty('comparison');
    expect((await pool.query('select count(*)::int as n from effective_target_snapshot')).rows[0].n).toBe(snapshotsBefore);
  });
});

describe('U-Z: confirmation, immutability and history', () => {
  let riceItemId: string;
  let confirmedPlanNutrition: unknown;

  it('Y: clients cannot author snapshots — fields are ignored and the database refuses them on unconfirmed items', async () => {
    const plan = (await A().get(`${plans(SEED.profileA)}/${planId}`)).body;
    const snack = plan.days[0].meals[3];
    const res = await A().post(`${plans(SEED.profileA)}/${planId}/meals/${snack.id}/items`, {
      items: [{ ...rice(10), nutrition_snapshot: { forged: true }, status: 'confirmed', nutrition_calculation_version: 'forged' }],
    });
    expect(res.status).toBe(201);
    const added = allItems(res.body).find((i) => i.status === 'draft' && JSON.stringify(i).includes('"quantity":10'));
    expect(added).toBeDefined();
    const stored = await pool.query('select status, nutrition_snapshot from planned_meal_item where id = $1', [added?.id]);
    expect(stored.rows[0]).toEqual({ status: 'draft', nutrition_snapshot: null });
    await expect(asAccountSql(SEED.accountA, "update planned_meal_item set nutrition_snapshot = '{}' where id = $1", [added?.id])).rejects.toThrow(/planned_meal_item_unconfirmed_no_snapshot/);
    await expect(
      asAccountSql(SEED.accountA, "insert into planned_meal_item (planned_meal_id, profile_id, food_id, unit, quantity, status) values ($1, $2, $3, 'g', 1, 'confirmed')", [snack.id, SEED.profileA, F.rice]),
    ).rejects.toThrow(/created as draft or planned/);
  });

  it('U: whole-plan confirmation confirms every item atomically with server snapshots; the plan becomes active', async () => {
    const before = await worldCounts();
    const res = await A().post(`${plans(SEED.profileA)}/${planId}/confirm`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    const items = allItems(res.body);
    expect(items.every((i) => i.status === 'confirmed')).toBe(true);
    riceItemId = res.body.days[0].meals[0].items[0].id;
    const { rows } = await pool.query("select count(*)::int as n from planned_meal_item where profile_id = $1 and status = 'confirmed' and nutrition_snapshot->>'snapshot_version' = 'planned-item-snapshot-8a.1'", [SEED.profileA]);
    expect(rows[0].n).toBe(items.length);
    expect(res.body.days[0].meals[0].items[0].nutrition).toMatchObject({ basis: 'confirmed_snapshot', calculation_version: 'nutrition-calculation-5b.1' });
    expect(res.body.includes_unconfirmed).toBe(false);
    expect(await worldCounts()).toEqual(before); // no MealLog/MealItem, no target snapshot, no reference data
    confirmedPlanNutrition = nutritionOnly((await A().get(`${plans(SEED.profileA)}/${planId}/nutrition`)).body);
    expect((await A().post(`${plans(SEED.profileA)}/${planId}/confirm`)).status).toBe(400); // nothing left to confirm
  });

  it('V/X: a later recipe edit leaves the confirmed version and nutrition untouched', async () => {
    const edited = await A().patch(`/v1/profiles/${SEED.profileA}/recipes/${recipeId}`, { servings: 1, ingredients: [{ text: '500 g rice', food_id: F.rice, quantity: 500, unit: 'g' }] });
    expect(edited.body.current_version.version_number).toBe(2);
    const plan = (await A().get(`${plans(SEED.profileA)}/${planId}`)).body;
    expect(plan.days[0].meals[1].items[0].recipe).toMatchObject({ recipe_version_id: recipeV1, version_number: 1 });
    expect(nutritionOnly((await A().get(`${plans(SEED.profileA)}/${planId}/nutrition`)).body)).toEqual(confirmedPlanNutrition);
  });

  it('W: a Food reference change does not rewrite confirmed nutrition; a new draft item uses the new value', async () => {
    await pool.query("update food_nutrient set amount_per_canonical_unit = 3 where food_id = $1 and nutrient_id = $2 and source = 'trusted_database'", [F.rice, NUT.protein]);
    try {
      expect(nutritionOnly((await A().get(`${plans(SEED.profileA)}/${planId}/nutrition`)).body)).toEqual(confirmedPlanNutrition);
      const dinner = (await A().get(`${plans(SEED.profileA)}/${planId}`)).body.days[0].meals[2];
      const added = await A().post(`${plans(SEED.profileA)}/${planId}/meals/${dinner.id}/items`, { items: [rice(100)] });
      const draft = added.body.days[0].meals[2].items[0];
      expect(draft).toMatchObject({ status: 'draft', nutrition: { basis: 'live_calculation' } });
      expect(draft.nutrition.summary.protein_g.value).toBe(3); // live, new value
      // the plan now mixes confirmed and draft items — confirmation state is per item
      expect(added.body).toMatchObject({ status: 'active', includes_unconfirmed: true });
    } finally {
      await pool.query("update food_nutrient set amount_per_canonical_unit = 2.7 where food_id = $1 and nutrient_id = $2 and source = 'trusted_database'", [F.rice, NUT.protein]);
    }
  });

  it('Z: confirmed content cannot be edited through the API or the database', async () => {
    expect((await A().patch(`${plans(SEED.profileA)}/${planId}/items/${riceItemId}`, { quantity: 120 })).status).toBe(409);
    for (const set of ['quantity = 120', "unit = 'kg'", "nutrition_snapshot = '{}'", "status = 'cancelled'", "status = 'draft'"]) {
      await expect(asAccountSql(SEED.accountA, `update planned_meal_item set ${set} where id = $1`, [riceItemId])).rejects.toThrow(/confirmed items are immutable/);
    }
    await expect(asAccountSql(SEED.accountA, "update planned_meal_item set status = 'consumed' where id = $1", [riceItemId])).rejects.toThrow(/invalid input value for enum/);
    await expect(asAccountSql(SEED.accountA, 'delete from planned_meal_item where id = $1', [riceItemId])).rejects.toThrow(/permission denied/);
  });

  it('replacement: a draft replacement is pending until confirmed; then the original is superseded and both snapshots survive', async () => {
    const originalSnapshot = (await pool.query('select nutrition_snapshot from planned_meal_item where id = $1', [riceItemId])).rows[0].nutrition_snapshot;
    const replaced = await A().post(`${plans(SEED.profileA)}/${planId}/items/${riceItemId}/replace`, rice(120));
    expect(replaced.status).toBe(201);
    expect(replaced.body).toMatchObject({ status: 'draft', is_pending_replacement: true, is_current: false, supersedes_planned_meal_item_id: riceItemId });
    expect((await A().post(`${plans(SEED.profileA)}/${planId}/items/${riceItemId}/replace`, rice(110))).status).toBe(409); // one pending replacement
    // the current view still uses the confirmed original
    const pending = (await A().get(`${plans(SEED.profileA)}/${planId}`)).body.days[0].meals[0];
    expect(pending.nutrition.summary.protein_g.value).toBe(9.45);

    const confirmed = await A().post(`${plans(SEED.profileA)}/${planId}/confirm`);
    expect(confirmed.status).toBe(200);
    const breakfast = confirmed.body.days[0].meals[0];
    const original = breakfast.items.find((i: { id: string }) => i.id === riceItemId);
    const replacement = breakfast.items.find((i: { id: string }) => i.id === replaced.body.id);
    expect(original).toMatchObject({ status: 'confirmed', is_current: false, superseded_by_planned_meal_item_id: replaced.body.id });
    expect(replacement).toMatchObject({ status: 'confirmed', is_current: true, is_pending_replacement: false });
    expect(breakfast.nutrition.summary.protein_g.value).toBe(8.64); // 120 g rice 3.24 + bread 5.4 — no double count
    const originalAfter = (await pool.query('select nutrition_snapshot from planned_meal_item where id = $1', [riceItemId])).rows[0].nutrition_snapshot;
    expect(originalAfter).toEqual(originalSnapshot);
    // historical retrieval of the superseded item
    const history = await A().get(`${plans(SEED.profileA)}/${planId}/items/${riceItemId}`);
    expect(history.body).toMatchObject({ status: 'confirmed', is_current: false, nutrition: { basis: 'confirmed_snapshot' } });
    expect(history.body.nutrition.summary.protein_g.value).toBe(4.05);
    // an already superseded item cannot be replaced again
    expect((await A().post(`${plans(SEED.profileA)}/${planId}/items/${riceItemId}/replace`, rice(90))).status).toBe(409);
  });

  it('supersession cannot change anything else, and must point at a confirmed replacement of the item', async () => {
    const plan = (await A().get(`${plans(SEED.profileA)}/${planId}`)).body;
    const [lunchItem] = plan.days[0].meals[1].items;
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('request.jwt.claim.sub', $1, true)", [SEED.accountA]);
      await client.query('set local role authenticated');
      const bread = plan.days[0].meals[0].items.find((i: { source_type: string; amount: { serving_id: string | null } }) => i.amount.serving_id);
      await client.query('savepoint s');
      await expect(client.query('update planned_meal_item set superseded_by_planned_meal_item_id = $1 where id = $2', [bread.id, lunchItem.id])).rejects.toThrow(/confirmed replacement of this item/);
      await client.query('rollback to savepoint s');
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});

describe('Confirmation atomicity and granularity', () => {
  it('a mismatched eligible set or changed content confirms nothing', async () => {
    const plan = await A().post(plans(SEED.profileA), { ...PLAN, name: 'Atomic' });
    const withDay = await A().post(`${plans(SEED.profileA)}/${plan.body.id}/days`, { plan_date: '2026-10-11' });
    const meal = await A().post(`${plans(SEED.profileA)}/${plan.body.id}/days/${withDay.body.days[0].id}/meals`, { meal_type: 'lunch', items: [rice(100), rice(200)] });
    const [a, b] = meal.body.days[0].meals[0].items;
    const entry = (id: string, quantity: number) => ({ id, food_id: F.rice, food_serving_id: null, unit: 'g', recipe_version_id: null, quantity, nutrition_snapshot: { x: 1 }, nutrition_calculation_version: 'v' });
    // only one of the two eligible items
    await expect(asAccountSql(SEED.accountA, 'select confirm_meal_plan($1, $2, $3)', [SEED.profileA, plan.body.id, { items: [entry(a.id, 100)] }])).rejects.toThrow(/changed while it was being confirmed/);
    // both, but one with stale content
    await expect(asAccountSql(SEED.accountA, 'select confirm_meal_plan($1, $2, $3)', [SEED.profileA, plan.body.id, { items: [entry(a.id, 100), entry(b.id, 999)] }])).rejects.toThrow(/changed while it was being confirmed/);
    const { rows } = await pool.query("select count(*)::int as n from planned_meal_item where id in ($1, $2) and status = 'confirmed'", [a.id, b.id]);
    expect(rows[0].n).toBe(0);
    expect((await A().get(`${plans(SEED.profileA)}/${plan.body.id}`)).body.status).toBe('draft');
  });

  it('the schema allows mixed confirmation states in one plan (future per-day/per-meal confirmation)', async () => {
    const dinner = (await A().get(`${plans(SEED.profileA)}/${planId}`)).body.days[0].meals[2];
    expect((await A().post(`${plans(SEED.profileA)}/${planId}/meals/${dinner.id}/items`, { items: [rice(60)] })).status).toBe(201);
    const { rows } = await pool.query("select count(distinct status)::int as n from planned_meal_item i join planned_meal m on m.id = i.planned_meal_id join meal_plan_day d on d.id = m.meal_plan_day_id where d.meal_plan_id = $1", [planId]);
    expect(rows[0].n).toBeGreaterThan(1); // confirmed + draft coexist legitimately
    const enumValues = (await pool.query("select string_agg(enumlabel, ',' order by enumsortorder) as v from pg_enum where enumtypid = 'planned_meal_item_status'::regtype")).rows[0].v;
    expect(enumValues).toBe('draft,planned,confirmed,cancelled'); // never consumed
  });
});

describe('AA + date range: plan lifecycle', () => {
  it('permits only the approved transitions', async () => {
    const plan = (await A().post(plans(SEED.profileA), { ...PLAN, name: 'Lifecycle' })).body;
    const url = `${plans(SEED.profileA)}/${plan.id}`;
    expect((await A().patch(url, { status: 'active' })).status).toBe(400); // only via /confirm
    expect((await A().patch(url, { status: 'completed' })).status).toBe(409); // draft -> completed
    const day = (await A().post(`${url}/days`, { plan_date: '2026-10-11' })).body.days[0];
    await A().post(`${url}/days/${day.id}/meals`, { meal_type: 'dinner', items: [rice(100)] });

    // draft date range: shorten over existing content is rejected; extension is allowed
    expect((await A().patch(url, { end_date: '2026-10-10' })).status).toBe(409);
    expect((await A().patch(url, { end_date: '2026-10-14' })).status).toBe(200);
    expect((await A().patch(url, { start_date: '2026-10-11', end_date: '2026-10-13' })).status).toBe(200); // no content outside
    expect((await A().post(`${url}/confirm`)).body.status).toBe('active');
    // active: extension only, timezone fixed
    expect((await A().patch(url, { end_date: '2026-10-12' })).status).toBe(409);
    expect((await A().patch(url, { end_date: '2026-10-20' })).status).toBe(200);
    expect((await A().patch(url, { local_timezone: 'UTC' })).status).toBe(409);
    expect((await A().patch(url, { status: 'archived' })).status).toBe(409); // active -> archived
    expect((await A().patch(url, { status: 'completed' })).status).toBe(200);
    expect((await A().patch(url, { status: 'cancelled' })).status).toBe(409); // completed -> cancelled
    expect((await A().patch(url, { end_date: '2026-10-25' })).status).toBe(409); // completed: range immutable
    expect((await A().post(`${url}/days`, { plan_date: '2026-10-15' })).status).toBe(409); // completed: no new content
    expect((await A().patch(url, { status: 'archived' })).status).toBe(200);
    await expect(asAccountSql(SEED.accountA, "update meal_plan set status = 'active' where id = $1", [plan.id])).rejects.toThrow(/invalid meal plan status transition/);
  });
});

describe('AB-AH: authorization and cross-Profile attacks', () => {
  let childPlan: string;

  it('AC: full_management plans and confirms for the child', async () => {
    const g = as(SEED.accountFullManagement);
    const plan = await g.post(plans(SEED.profileChild), { ...PLAN, name: 'Child week' });
    expect(plan.status).toBe(201);
    childPlan = plan.body.id;
    const day = await g.post(`${plans(SEED.profileChild)}/${childPlan}/days`, { plan_date: '2026-10-10' });
    expect((await g.post(`${plans(SEED.profileChild)}/${childPlan}/days/${day.body.days[0].id}/meals`, { meal_type: 'lunch', items: [rice(80)] })).status).toBe(201);
    expect((await g.post(`${plans(SEED.profileChild)}/${childPlan}/confirm`)).status).toBe(200);
  });

  it('AD: view_only reads but cannot write', async () => {
    const v = as(SEED.accountViewOnly);
    expect((await v.get(`${plans(SEED.profileChild)}/${childPlan}`)).status).toBe(200);
    expect((await v.get(`${plans(SEED.profileChild)}/${childPlan}/nutrition`)).status).toBe(200);
    expect((await v.post(plans(SEED.profileChild), PLAN)).status).toBe(403);
    expect((await v.post(`${plans(SEED.profileChild)}/${childPlan}/days`, { plan_date: '2026-10-11' })).status).toBe(403);
    expect((await v.post(`${plans(SEED.profileChild)}/${childPlan}/confirm`)).status).toBe(403);
    await expect(
      asAccountSql(SEED.accountViewOnly, "insert into meal_plan (profile_id, name, start_date, end_date, local_timezone) values ($1, 'x', '2026-10-10', '2026-10-10', 'UTC')", [SEED.profileChild]),
    ).rejects.toThrow(/row-level security/);
  });

  it('AE: pediatric_weight_management reads and writes the child\'s plans (approved scope), nothing else is added', async () => {
    const p = as(SEED.accountPediatric);
    const plan = await p.post(plans(SEED.profileChild), { ...PLAN, name: 'Pediatric plan' });
    expect(plan.status).toBe(201);
    const day = await p.post(`${plans(SEED.profileChild)}/${plan.body.id}/days`, { plan_date: '2026-10-12' });
    expect((await p.post(`${plans(SEED.profileChild)}/${plan.body.id}/days/${day.body.days[0].id}/meals`, { meal_type: 'snack', items: [rice(40)] })).status).toBe(201);
    const confirmed = await p.post(`${plans(SEED.profileChild)}/${plan.body.id}/confirm`);
    expect(confirmed.status).toBe(200);
    expect((await p.get(`${plans(SEED.profileChild)}/${childPlan}`)).status).toBe(200);
    // no calorie formula or advice appears — only existing targets are compared
    const n = await p.get(`${plans(SEED.profileChild)}/${plan.body.id}/nutrition`);
    expect(n.body.target).toMatchObject({ fields: [], implemented_sources: ['clinician_target', 'user_target'] });
  });

  it('AF/AG: revoked guardian and unrelated Accounts are refused (404)', async () => {
    expect((await as(SEED.accountRevoked).get(`${plans(SEED.profileChild)}/${childPlan}`)).status).toBe(404);
    expect((await as(SEED.accountRevoked).post(plans(SEED.profileChild), PLAN)).status).toBe(404);
    expect((await as(SEED.accountUnrelated).get(`${plans(SEED.profileA)}/${planId}`)).status).toBe(404);
    expect((await as(SEED.accountB).get(`${plans(SEED.profileB)}/${planId}`)).status).toBe(404);
    expect((await asAccountSql(SEED.accountB, 'select id from meal_plan where id = $1', [planId])).rows).toEqual([]);
  });

  it('AH: cross-Profile injection is blocked by the API, RLS and the composite keys', async () => {
    const plan = (await A().get(`${plans(SEED.profileA)}/${planId}`)).body;
    const mealId = plan.days[0].meals[0].id;
    // another Account through its own path
    expect((await as(SEED.accountB).post(`${plans(SEED.profileB)}/${planId}/meals/${mealId}/items`, { items: [rice(1)] })).status).toBe(404);
    // a guardian who manages the child cannot write into Profile A's meal
    await expect(
      asAccountSql(SEED.accountFullManagement, "insert into planned_meal_item (planned_meal_id, profile_id, food_id, unit, quantity) values ($1, $2, $3, 'g', 1)", [mealId, SEED.profileChild, F.rice]),
    ).rejects.toThrow(/fk_planned_meal_item_meal/);
    // an Account that manages TWO profiles cannot attach one profile's item to the other's meal
    await expect(
      asAccountSql(SEED.accountA, "insert into planned_meal_item (planned_meal_id, profile_id, food_id, unit, quantity) values ($1, $2, $3, 'g', 1)", [mealId, PROFILE_A2, F.rice]),
    ).rejects.toThrow(/fk_planned_meal_item_meal/);
    // nor move a plan to another profile
    await expect(asAccountSql(SEED.accountA, 'update meal_plan set profile_id = $1 where id = $2', [PROFILE_A2, planId])).rejects.toThrow(/profile_id is immutable|foreign key/);
  });
});

describe('AI/AJ: planning never touches actual consumption or reference data', () => {
  it('no MealLog/MealItem, target snapshot, FoodServing or FoodNutrient was created or changed by any planning call', async () => {
    await A().get(`${plans(SEED.profileA)}/${planId}`);
    await A().get(`${plans(SEED.profileA)}/${planId}/nutrition`);
    await A().get(plans(SEED.profileA));
    expect(await worldCounts()).toEqual(before);
    const meals = await pool.query('select count(*)::int as n from meal_log');
    expect(meals.rows[0].n).toBe(0);
  });

  it('list and days endpoints paginate/structure the plan without raw rows', async () => {
    const list = await A().get(`${plans(SEED.profileA)}?limit=2`);
    expect(list.body.data).toHaveLength(2);
    expect(list.body.pagination.nextCursor).toEqual(expect.any(String));
    const days = await A().get(`${plans(SEED.profileA)}/${planId}/days`);
    expect(days.body).toMatchObject({ meal_plan_id: planId, local_timezone: 'Asia/Dubai' });
    expect(JSON.stringify(days.body)).not.toMatch(/created_by_account_id|profile_access_scope/);
  });
});
