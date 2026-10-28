// Layer 12F correction — Food display names in planning, grocery and meal
// read models, against the real migration chain and RLS harness.
//
// A USDA-backed Food's canonical_name is an internal key (`usda-fdc:<fdcId>`);
// its human name is a FoodAlias. Read models that name a Food return the
// alias as `food.display_name` (ranked as GET /v1/foods/{id} ranks it) and keep
// `canonical_name` as provenance. Nothing stored changes: a grocery list
// generated earlier shows the name at read time, and its rows are untouched.
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

let pool: Pool;
let app: ReturnType<typeof createApp>;

const as = (account: string) => ({
  get: (path: string, query: Record<string, string> = {}) => request(app).get(path).query(query).set('Authorization', `Bearer ${signTestToken(account)}`),
  post: (path: string, body: unknown = {}) => request(app).post(path).set('Authorization', `Bearer ${signTestToken(account)}`).send(body as object),
});
const A = () => as(SEED.accountA);
const plans = `/v1/profiles/${SEED.profileA}/meal-plans`;
const lists = `/v1/profiles/${SEED.profileA}/grocery-lists`;
const D1 = '2026-11-02';

const PAPAYA = 'c1c1c1c1-0000-4000-8000-000000169228';
const PAPAYA_CUP = 'c1c1c1c1-0000-4000-8000-0000000000c1';
const PAPAYA_KEY = 'usda-fdc:169228';

type Named = { food: { food_id: string; canonical_name: string | null; display_name: string | null } | null; display_name?: string };
const byFood = <T extends Named>(items: T[], foodId: string): T => {
  const found = items.find((i) => i.food?.food_id === foodId);
  if (!found) throw new Error(`no item for ${foodId}`);
  return found;
};

const storedGrocery = async () =>
  (
    await pool.query(`select
      (select md5(coalesce(string_agg(to_jsonb(i)::text, ',' order by id), '')) from grocery_list_item i) as items,
      (select md5(coalesce(string_agg(to_jsonb(s)::text, ',' order by id), '')) from grocery_list_item_source s) as sources,
      (select md5(coalesce(string_agg(to_jsonb(l)::text, ',' order by id), '')) from grocery_list l) as lists,
      (select md5(coalesce(string_agg(to_jsonb(p)::text, ',' order by id), '')) from planned_meal_item p) as planned_items`)
  ).rows[0];

let planId: string;
let listId: string;

beforeAll(async () => {
  pool = await rebuildTestDatabase('recipebook_api_test_layer12f_names');
  await seedScenario(pool);
  await seedNutritionFixtures(pool);
  // A USDA-shaped Food: internal key, one gram-weighted portion, no alias yet.
  await pool.query("insert into food (id, canonical_name, source) values ($1, $2, 'trusted_database')", [PAPAYA, PAPAYA_KEY]);
  await pool.query(
    "insert into food_serving (id, food_id, serving_description, canonical_quantity, canonical_unit, source) values ($1, $2, '1 cup, cubes', 140, 'g', 'trusted_database')",
    [PAPAYA_CUP, PAPAYA],
  );
  app = createApp({ profileRepository: new PgHarnessProfileRepository(pool), scopedDbFactory: new PgHarnessScopedDbFactory(pool), jwtSecret: TEST_JWT_SECRET, logger });

  const plan = await A().post(plans, { name: 'Names', start_date: D1, end_date: D1, local_timezone: 'Asia/Dubai' });
  planId = plan.body.id;
  const day = await A().post(`${plans}/${planId}/days`, { plan_date: D1 });
  const meal = await A().post(`${plans}/${planId}/days/${day.body.days[0].id}/meals`, {
    meal_type: 'breakfast',
    items: [
      { type: 'food', food_id: PAPAYA, quantity: 1, serving_id: PAPAYA_CUP },
      { type: 'food', food_id: F.rice, quantity: 100, unit: 'g' },
    ],
  });
  expect(meal.status).toBe(201);
  expect((await A().post(`${plans}/${planId}/confirm`)).status).toBe(200);
  // Generated BEFORE the Food has any alias, as on DEV before the correction.
  const gen = await A().post(`${plans}/${planId}/grocery-lists`);
  expect(gen.status).toBe(201);
  listId = gen.body.id;
  expect(byFood(gen.body.items, PAPAYA).food.display_name).toBeNull();

  // The USDA description arrives as the Food's aliases (ranked: primary over
  // non-primary, and an AI-matched alias never wins over a trusted one).
  for (const [text, primary, source] of [
    ['Papayas, raw', true, 'trusted_database'],
    ['Papaya', false, 'trusted_database'],
    ['AAA papaya guess', false, 'ai_matched'],
  ] as const) {
    await pool.query("insert into food_alias (food_id, locale, alias_text, is_primary, source) values ($1, 'en', $2, $3, $4)", [PAPAYA, text, primary, source]);
  }
});

afterAll(async () => {
  await pool.end();
});

describe('Food display names (Layer 12F correction)', () => {
  it('uses the same alias the Food API shows', async () => {
    const food = await A().get(`/v1/foods/${PAPAYA}`);
    expect(food.body.display_name).toBe('Papayas, raw');
  });

  it('meal plan items carry display_name next to the canonical key, with the serving unchanged', async () => {
    const res = await A().get(`${plans}/${planId}`);
    expect(res.status).toBe(200);
    const items = res.body.days[0].meals[0].items;
    expect(byFood(items, PAPAYA)).toMatchObject({
      food: { food_id: PAPAYA, canonical_name: PAPAYA_KEY, display_name: 'Papayas, raw' },
      amount: { quantity: 1, serving_id: PAPAYA_CUP, serving_description: '1 cup, cubes' },
    });
    // A Food without an alias has no display name; nothing is invented.
    expect(byFood(items, F.rice).food).toMatchObject({ canonical_name: 'fixture5b_rice_cooked', display_name: null });
    const detail = await A().get(`${plans}/${planId}/items/${byFood(items, PAPAYA).id as string}`);
    expect(detail.body.food.display_name).toBe('Papayas, raw');
  });

  it('a list generated earlier shows the name at read time, and its stored rows do not change', async () => {
    const before = await storedGrocery();
    const detail = await A().get(`${lists}/${listId}`);
    const shopping = await A().get(`${lists}/${listId}/shopping`);
    const preview = await A().get(`${plans}/${planId}/grocery-preview`);
    for (const items of [detail.body.items, shopping.body.items, preview.body.items]) {
      const papaya = byFood(items, PAPAYA);
      expect(papaya.food).toMatchObject({ food_id: PAPAYA, canonical_name: PAPAYA_KEY, display_name: 'Papayas, raw' });
      expect(papaya.display_name).toBe(PAPAYA_KEY); // the stored generation record, returned unchanged
    }
    expect(byFood(detail.body.items, PAPAYA)).toMatchObject({ quantity: 140, unit: 'g' });
    expect(byFood(shopping.body.items, PAPAYA).generated_quantity).toMatchObject({ quantity: 140, unit: 'g' });
    expect(detail.body.is_stale).toBe(false); // display text is not part of the fingerprint
    const stored = await pool.query('select display_name from grocery_list_item where food_id = $1', [PAPAYA]);
    expect(stored.rows).toEqual([{ display_name: PAPAYA_KEY }]);
    expect(await storedGrocery()).toEqual(before);
  });

  it('manual items linked to a Food are named the same way', async () => {
    const res = await A().post(`${lists}/${listId}/manual-items`, { name: 'Extra fruit', food_id: PAPAYA });
    expect(res.status).toBe(201);
    const manual = res.body.manual_items.find((m: { name: string }) => m.name === 'Extra fruit');
    expect(manual.food).toEqual({ food_id: PAPAYA, canonical_name: PAPAYA_KEY, display_name: 'Papayas, raw' });
  });

  it('logged meal items and the Daily Tracker carry display_name too', async () => {
    const log = await A().post(`/v1/profiles/${SEED.profileA}/meals`, {
      meal_type: 'snack',
      logged_date: '2026-09-20',
      local_timezone: 'UTC',
      consumed_at: '2026-09-20T07:30:00.000Z',
      items: [{ type: 'food', food_id: PAPAYA, quantity: 1, serving_id: PAPAYA_CUP }],
    });
    expect(log.status).toBe(201);
    expect(log.body.items[0].food).toEqual({ food_id: PAPAYA, canonical_name: PAPAYA_KEY, display_name: 'Papayas, raw' });
    const item = await A().get(`/v1/profiles/${SEED.profileA}/meals/${log.body.id}/items/${log.body.items[0].id}`);
    expect(item.body.food.display_name).toBe('Papayas, raw');
    const tracker = await A().get(`/v1/profiles/${SEED.profileA}/daily-tracker`, { date: '2026-09-20', timezone: 'UTC' });
    expect(tracker.status).toBe(200);
    const items = tracker.body.meal_groups.flatMap((g: { meals: Array<{ items: Named[] }> }) => g.meals.flatMap((m) => m.items));
    expect(byFood(items, PAPAYA).food?.display_name).toBe('Papayas, raw');
  });

  it('reads aliases only as the signed-in caller: an unauthenticated request gets nothing', async () => {
    expect((await request(app).get(`${plans}/${planId}`)).status).toBe(401);
    // Account B cannot reach Account A's plan, names included.
    expect((await as(SEED.accountB).get(`${plans}/${planId}`)).status).toBe(404);
  });
});
