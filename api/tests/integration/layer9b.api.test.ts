// Layer 9B integration tests — grocery workflow / user shopping state on top
// of immutable Layer 9A generated lists, against the real migration chain
// and RLS harness. TEST FIXTURES ONLY.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
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
  get: (path: string) => request(app).get(path).set('Authorization', `Bearer ${signTestToken(account)}`),
  post: (path: string, body: unknown = {}) => request(app).post(path).set('Authorization', `Bearer ${signTestToken(account)}`).send(body as object),
  patch: (path: string, body: unknown) => request(app).patch(path).set('Authorization', `Bearer ${signTestToken(account)}`).send(body as object),
});
const A = () => as(SEED.accountA);
const plans = (profile: string) => `/v1/profiles/${profile}/meal-plans`;
const lists = (profile: string) => `/v1/profiles/${profile}/grocery-lists`;
const PROFILE_A2 = 'b0b0b0b0-0000-4000-8000-0000000000a2';
const D1 = '2026-11-02';
const food = (food_id: string, quantity: number, unit = 'g') => ({ type: 'food', food_id, quantity, unit });

type Qty = { quantity: number | null; unit: string | null } | null;
type ItemView = {
  grocery_list_item_id: string;
  food: { food_id: string } | null;
  display_name: string;
  generation_resolution_status: string;
  generated_quantity: { quantity: number; unit: string } | null;
  already_have: null | { id: string; input: Qty; normalized_quantity: number | null; normalized_unit: string | null; comparison: string; unresolved_reason: string | null };
  derived_need: Qty;
  already_have_surplus: Qty;
  shopping_adjustment: null | { id: string; normalized_quantity: number | null };
  shopping_target: Qty;
  shopping_target_source: string | null;
  purchased: { quantity: number | null; unit: string | null; counted_purchase_ids: string[]; not_counted: Array<{ id: string; reason: string }>; checked_off: boolean };
  remaining_to_purchase: Qty;
  over_purchased: Qty;
  status: string;
  purchase_mode: string;
  history: { already_have: Array<{ id: string; revoked_at: string | null }>; shopping_adjustments: Array<{ id: string; revoked_at: string | null }>; purchases: Array<{ id: string; revoked_at: string | null }> };
};
type ManualView = { grocery_manual_item_id: string; source: string; name: string; food: { food_id: string } | null; shopping_target: Qty; purchased: ItemView['purchased']; remaining_to_purchase: Qty; status: string; purchase_mode: string; revoked_at: string | null; purchases: Array<{ id: string }> };
type Shopping = {
  grocery_list: { id: string; generation_number: number; status: string; is_stale: boolean; is_current_generation: boolean };
  state_writable: boolean;
  carry_forward: string;
  items: ItemView[];
  manual_items: ManualView[];
  removed_manual_items: ManualView[];
  summary: { generated: Record<string, number>; manual: Record<string, number> };
};

async function makePlan(account: string, profile: string, name: string, meals: Array<{ meal_type: string; items: unknown[] }>) {
  const c = as(account);
  const plan = await c.post(plans(profile), { name, start_date: D1, end_date: D1, local_timezone: 'Asia/Dubai' });
  const id: string = plan.body.id;
  const day = await c.post(`${plans(profile)}/${id}/days`, { plan_date: D1 });
  const dayId = day.body.days[0].id;
  for (const [position, m] of meals.entries()) expect((await c.post(`${plans(profile)}/${id}/days/${dayId}/meals`, { ...m, position })).status).toBe(201);
  expect((await c.post(`${plans(profile)}/${id}/confirm`)).status).toBe(200);
  const detail = await c.get(`${plans(profile)}/${id}`);
  const itemIds: string[] = detail.body.days[0].meals.flatMap((m: { items: Array<{ id: string }> }) => m.items.map((i) => i.id));
  return { id, itemIds };
}

const shopping = async (listId: string, account: string = SEED.accountA, profile: string = SEED.profileA): Promise<Shopping> => {
  const res = await as(account).get(`${lists(profile)}/${listId}/shopping`);
  expect(res.status).toBe(200);
  return res.body;
};
const itemOf = (s: Shopping, foodId: string | null, name?: string): ItemView => {
  const found = s.items.find((i) => (foodId ? i.food?.food_id === foodId && (!name || i.display_name === name) : i.display_name === name));
  if (!found) throw new Error(`no item ${foodId ?? name}`);
  return found;
};
const manualOf = (s: Shopping, name: string): ManualView => {
  const found = [...s.manual_items, ...s.removed_manual_items].find((m) => m.name === name);
  if (!found) throw new Error(`no manual ${name}`);
  return found;
};
const itemPath = (listId: string, itemId: string, profile: string = SEED.profileA) => `${lists(profile)}/${listId}/items/${itemId}`;

async function txAs(account: string): Promise<PoolClient> {
  const c = await pool.connect();
  await c.query('begin');
  await c.query("select set_config('request.jwt.claim.sub', $1, true)", [account]);
  await c.query('set local role authenticated');
  return c;
}
async function asAccountSql(account: string, sql: string, params: unknown[] = []) {
  const c = await txAs(account);
  try {
    return await c.query(sql, params);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

const generatedHash = async () =>
  (
    await pool.query(`select
      (select md5(coalesce(string_agg(to_jsonb(l)::text, ',' order by id), '')) from grocery_list l) as lists,
      (select md5(coalesce(string_agg(to_jsonb(i)::text, ',' order by id), '')) from grocery_list_item i) as items,
      (select md5(coalesce(string_agg(to_jsonb(s)::text, ',' order by id), '')) from grocery_list_item_source s) as sources`)
  ).rows[0];
const worldState = async () =>
  (
    await pool.query(`select
      (select md5(coalesce(string_agg(to_jsonb(m)::text, ',' order by id), '')) from meal_item m) as meal_items,
      (select count(*)::int from meal_log) as meal_logs,
      (select md5(coalesce(string_agg(to_jsonb(p)::text, ',' order by id), '')) from planned_meal_item p) as planned_items,
      (select md5(coalesce(string_agg(to_jsonb(p)::text, ',' order by id), '')) from meal_plan p) as plans,
      (select md5(coalesce(string_agg(to_jsonb(f)::text, ',' order by id), '')) from food f) as foods,
      (select md5(coalesce(string_agg(to_jsonb(s)::text, ',' order by id), '')) from food_serving s) as servings,
      (select md5(coalesce(string_agg(to_jsonb(n)::text, ',' order by id), '')) from food_nutrient n) as food_nutrients,
      (select md5(coalesce(string_agg(to_jsonb(v)::text, ',' order by id), '')) from recipe_version v) as recipe_versions`)
  ).rows[0];

let P: { id: string; itemIds: string[] };
let gen1: string;
let gen1Items: Record<string, string>;
let generatedBefore: Awaited<ReturnType<typeof generatedHash>>;
let worldBefore: Awaited<ReturnType<typeof worldState>>;

beforeAll(async () => {
  pool = await rebuildTestDatabase('recipebook_api_test_layer9b');
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
    title: 'Fixture sandwich plate',
    servings: 1,
    ingredients: [
      { text: '2 bread rolls', food_id: F.bread, quantity: 2 },
      { text: '50 g tahini', quantity: 50, unit: 'g' },
      { text: 'spinach to garnish', food_id: F.spinach },
    ],
  });
  P = await makePlan(SEED.accountA, SEED.profileA, 'Shopping week', [
    { meal_type: 'lunch', items: [food(F.rice, 1.2, 'kg'), food(F.milk, 500, 'ml'), food(F.juice, 300, 'ml')] },
    { meal_type: 'dinner', items: [{ type: 'recipe', recipe_id: recipe.body.id, recipe_version_id: recipe.body.current_version.id, servings: 1 }] },
  ]);
  const gen = await A().post(`${plans(SEED.profileA)}/${P.id}/grocery-lists`);
  expect(gen.status).toBe(201);
  gen1 = gen.body.id;
  gen1Items = Object.fromEntries(gen.body.items.map((i: { id: string; display_name: string; dimension: string | null }) => [`${i.display_name}${i.dimension ? `:${i.dimension}` : ''}`, i.id]));
  generatedBefore = await generatedHash();
  worldBefore = await worldState();
}, 90_000);

afterAll(async () => {
  await pool.end();
});

const RICE = () => gen1Items['fixture5b_rice_cooked:mass'] as string;
const MILK = () => gen1Items['fixture5b_milk:volume'] as string;
const JUICE = () => gen1Items['fixture5b_juice:volume'] as string;
const BREAD = () => gen1Items['fixture5b_bread:count'] as string;
const TAHINI = () => gen1Items['50 g tahini'] as string;
const SPINACH = () => gen1Items['fixture5b_spinach'] as string;

describe('baseline', () => {
  it('a fresh list shows every generated item, the generated baseline and no user state', async () => {
    const s = await shopping(gen1);
    expect(s).toMatchObject({ state_writable: true, carry_forward: 'none', manual_items: [], grocery_list: { generation_number: 1, is_stale: false } });
    expect(s.items).toHaveLength(6);
    expect(itemOf(s, F.rice)).toMatchObject({
      generated_quantity: { quantity: 1200, unit: 'g' },
      already_have: null,
      derived_need: { quantity: 1200, unit: 'g' },
      shopping_target: { quantity: 1200, unit: 'g' },
      shopping_target_source: 'generated',
      purchased: { quantity: 0 },
      remaining_to_purchase: { quantity: 1200 },
      status: 'need_to_buy',
      purchase_mode: 'quantity',
    });
  });
});

describe('B-E, R: already-have', () => {
  it('B/C/D/A: 0.4 kg already-have normalizes to 400 g; need-to-buy 800 g; generated stays 1200 g', async () => {
    const res = await A().post(`${itemPath(gen1, RICE())}/already-have`, { quantity: 0.4, unit: 'kg', note: 'pantry', generated_quantity: 1 });
    expect(res.status).toBe(201);
    const rice = itemOf(res.body, F.rice);
    expect(rice).toMatchObject({
      generated_quantity: { quantity: 1200, unit: 'g' },
      already_have: { input: { quantity: 0.4, unit: 'kg' }, normalized_quantity: 400, normalized_unit: 'g', comparison: 'comparable' },
      derived_need: { quantity: 800 },
      shopping_target: { quantity: 800 },
      shopping_target_source: 'generated',
      status: 'need_to_buy',
    });
    const row = (await pool.query('select quantity from grocery_list_item where id = $1', [RICE()])).rows[0];
    expect(Number(row.quantity)).toBe(1200);
  });

  it('E: already-have above the requirement -> need 0 (never negative) with a factual surplus', async () => {
    const res = await A().post(`${itemPath(gen1, JUICE())}/already-have`, { quantity: 0.5, unit: 'l' });
    expect(itemOf(res.body, F.juice)).toMatchObject({
      derived_need: { quantity: 0, unit: 'ml' },
      already_have_surplus: { quantity: 200, unit: 'ml' },
      shopping_target: { quantity: 0 },
      remaining_to_purchase: { quantity: 0 },
      status: 'already_have_sufficient',
    });
  });

  it('R: an incompatible already-have unit fabricates nothing (no density); setting it again keeps history', async () => {
    const res = await A().post(`${itemPath(gen1, JUICE())}/already-have`, { quantity: 100, unit: 'g' });
    const juice = itemOf(res.body, F.juice);
    expect(juice).toMatchObject({
      already_have: { comparison: 'unresolved', unresolved_reason: 'density_unavailable', normalized_quantity: null },
      derived_need: null,
      shopping_target: null,
      remaining_to_purchase: null,
      status: 'comparison_unresolved',
      purchase_mode: 'quantity',
    });
    expect(juice.history.already_have).toHaveLength(2);
    expect(juice.history.already_have.filter((h) => h.revoked_at === null)).toHaveLength(1);
    expect((await pool.query('select count(*)::int as n from grocery_item_already_have where grocery_list_item_id = $1', [JUICE()])).rows[0].n).toBe(2);
    // a check-off can never satisfy a quantitative requirement
    expect((await A().post(`${itemPath(gen1, JUICE())}/purchases`, {})).status).toBe(400);
  });

  it('C: mass -> volume through the Food’s trusted density (103 g milk = 100 ml)', async () => {
    const res = await A().post(`${itemPath(gen1, MILK())}/already-have`, { quantity: 103, unit: 'g' });
    expect(itemOf(res.body, F.milk)).toMatchObject({ already_have: { normalized_quantity: 100, normalized_unit: 'ml' }, derived_need: { quantity: 400, unit: 'ml' } });
  });

  it('clearing an already-have revokes it and restores the generated need', async () => {
    const cleared = await A().post(`${itemPath(gen1, JUICE())}/already-have/clear`);
    expect(cleared.status).toBe(200);
    expect(itemOf(cleared.body, F.juice)).toMatchObject({ already_have: null, derived_need: { quantity: 300 }, status: 'need_to_buy' });
    expect((await A().post(`${itemPath(gen1, JUICE())}/already-have/clear`)).status).toBe(409);
  });
});

describe('F-I: purchases', () => {
  let overId: string;

  it('F/G: 300 g purchased of 800 g -> partially purchased, 500 g remaining', async () => {
    const res = await A().post(`${itemPath(gen1, RICE())}/purchases`, { quantity: 300, unit: 'g' });
    expect(res.status).toBe(201);
    expect(itemOf(res.body, F.rice)).toMatchObject({ purchased: { quantity: 300, unit: 'g' }, remaining_to_purchase: { quantity: 500 }, status: 'partially_purchased', over_purchased: null });
  });

  it('H: 0.5 kg more -> purchased, nothing remaining', async () => {
    const res = await A().post(`${itemPath(gen1, RICE())}/purchases`, { quantity: 0.5, unit: 'kg' });
    expect(itemOf(res.body, F.rice)).toMatchObject({ purchased: { quantity: 800 }, remaining_to_purchase: { quantity: 0 }, status: 'purchased' });
  });

  it('I: over-purchase -> remaining 0, over-purchased quantity reported; revoking the purchase restores', async () => {
    const res = await A().post(`${itemPath(gen1, RICE())}/purchases`, { quantity: 100, unit: 'g' });
    const rice = itemOf(res.body, F.rice);
    expect(rice).toMatchObject({ purchased: { quantity: 900 }, remaining_to_purchase: { quantity: 0 }, over_purchased: { quantity: 100, unit: 'g' }, status: 'purchased' });
    overId = rice.history.purchases[2]?.id as string;
    const revoked = await A().post(`${lists(SEED.profileA)}/${gen1}/purchases/${overId}/revoke`);
    expect(revoked.status).toBe(200);
    expect(itemOf(revoked.body, F.rice)).toMatchObject({ purchased: { quantity: 800 }, over_purchased: null });
    expect((await A().post(`${lists(SEED.profileA)}/${gen1}/purchases/${overId}/revoke`)).status).toBe(409);
    expect((await pool.query('select revoked_at from grocery_purchase where id = $1', [overId])).rows[0].revoked_at).not.toBeNull();
  });

  it('an incompatible purchase unit is recorded but never counted', async () => {
    const res = await A().post(`${itemPath(gen1, MILK())}/purchases`, { quantity: 1, unit: 'count' });
    const milk = itemOf(res.body, F.milk);
    expect(milk.purchased).toMatchObject({ quantity: 0, not_counted: [expect.objectContaining({ reason: 'count_not_convertible_to_mass_or_volume' })] });
    expect(milk.status).toBe('need_to_buy');
  });

  it('count + count: 2 rolls purchased satisfies a 2-count requirement', async () => {
    const res = await A().post(`${itemPath(gen1, BREAD())}/purchases`, { quantity: 2, unit: 'count' });
    expect(itemOf(res.body, F.bread)).toMatchObject({ generated_quantity: { quantity: 2, unit: 'count' }, purchased: { quantity: 2, unit: 'count' }, status: 'purchased' });
  });
});

describe('J-L: user shopping quantity', () => {
  it('J/K: a 1 L adjustment becomes the target (user_adjusted); generated and already-have are untouched', async () => {
    const res = await A().post(`${itemPath(gen1, MILK())}/shopping-quantity`, { quantity: 1, unit: 'l' });
    expect(res.status).toBe(201);
    expect(itemOf(res.body, F.milk)).toMatchObject({
      generated_quantity: { quantity: 500, unit: 'ml' },
      already_have: { normalized_quantity: 100 },
      derived_need: { quantity: 400 },
      shopping_adjustment: { normalized_quantity: 1000 },
      shopping_target: { quantity: 1000, unit: 'ml' },
      shopping_target_source: 'user_adjusted',
      remaining_to_purchase: { quantity: 1000 },
    });
  });

  it('L: clearing the adjustment returns to the generated-derived target; history kept', async () => {
    const res = await A().post(`${itemPath(gen1, MILK())}/shopping-quantity/clear`);
    const milk = itemOf(res.body, F.milk);
    expect(milk).toMatchObject({ shopping_adjustment: null, shopping_target: { quantity: 400 }, shopping_target_source: 'generated' });
    expect(milk.history.shopping_adjustments).toEqual([expect.objectContaining({ revoked_at: expect.any(String) })]);
  });
});

describe('Q: unresolved generated items stay visible and usable', () => {
  it('an unresolved Food requirement is shown and can be checked off (not given a quantity)', async () => {
    let s = await shopping(gen1);
    expect(itemOf(s, null, '50 g tahini')).toMatchObject({ food: null, generation_resolution_status: 'unresolved_food', generated_quantity: null, status: 'comparison_unresolved', purchase_mode: 'check_off' });
    expect((await A().post(`${itemPath(gen1, TAHINI())}/purchases`, { quantity: 50, unit: 'g' })).status).toBe(400);
    const res = await A().post(`${itemPath(gen1, TAHINI())}/purchases`, { note: 'got a jar' });
    expect(res.status).toBe(201);
    expect(itemOf(res.body, null, '50 g tahini')).toMatchObject({ status: 'purchased', purchased: { checked_off: true } });
    // an already-have cannot be compared with an unresolved requirement
    s = (await A().post(`${itemPath(gen1, TAHINI())}/already-have`, { quantity: 1, unit: 'count' })).body;
    expect(itemOf(s, null, '50 g tahini').already_have).toMatchObject({ comparison: 'unresolved', unresolved_reason: 'generated_quantity_unresolved' });
  });

  it('an unresolved-quantity item can get a user shopping quantity, then quantity purchases', async () => {
    const res = await A().post(`${itemPath(gen1, SPINACH())}/shopping-quantity`, { quantity: 50, unit: 'g' });
    const spinach = itemOf(res.body, F.spinach);
    expect(spinach).toMatchObject({ generation_resolution_status: 'unresolved_quantity', generated_quantity: null, shopping_target: { quantity: 50, unit: 'g' }, shopping_target_source: 'user_adjusted', purchase_mode: 'quantity' });
    const bought = await A().post(`${itemPath(gen1, SPINACH())}/purchases`, { quantity: 50, unit: 'g' });
    expect(itemOf(bought.body, F.spinach).status).toBe('purchased');
  });
});

describe('M-P: manual items', () => {
  it('M/O/P: non-food items with and without a quantity; quantity-aware or check-off purchases', async () => {
    let res = await A().post(`${lists(SEED.profileA)}/${gen1}/manual-items`, { name: 'Coffee beans', quantity: 250, unit: 'g', notes: 'medium roast' });
    expect(res.status).toBe(201);
    res = await A().post(`${lists(SEED.profileA)}/${gen1}/manual-items`, { name: 'Paper towels' });
    const coffee = manualOf(res.body, 'Coffee beans');
    const towels = manualOf(res.body, 'Paper towels');
    expect(coffee).toMatchObject({ source: 'manual', food: null, shopping_target: { quantity: 250, unit: 'g' }, status: 'need_to_buy', purchase_mode: 'quantity' });
    expect(towels).toMatchObject({ source: 'manual', shopping_target: null, status: 'need_to_buy', purchase_mode: 'check_off' });
    expect((await A().post(`${lists(SEED.profileA)}/${gen1}/manual-items/${towels.grocery_manual_item_id}/purchases`, { quantity: 1, unit: 'count' })).status).toBe(400);
    res = await A().post(`${lists(SEED.profileA)}/${gen1}/manual-items/${towels.grocery_manual_item_id}/purchases`);
    expect(manualOf(res.body, 'Paper towels')).toMatchObject({ status: 'purchased', purchased: { checked_off: true } });
    res = await A().post(`${lists(SEED.profileA)}/${gen1}/manual-items/${coffee.grocery_manual_item_id}/purchases`, { quantity: 0.1, unit: 'kg' });
    expect(manualOf(res.body, 'Coffee beans')).toMatchObject({ status: 'partially_purchased', remaining_to_purchase: { quantity: 150, unit: 'g' } });
  });

  it('N: a manual Food item stays manual — no plan provenance, no generated rows', async () => {
    const sourcesBefore = (await pool.query('select count(*)::int as n from grocery_list_item_source')).rows[0].n;
    const res = await A().post(`${lists(SEED.profileA)}/${gen1}/manual-items`, { name: 'Extra rice', food_id: F.rice, quantity: 1, unit: 'kg' });
    expect(res.status).toBe(201);
    expect(manualOf(res.body, 'Extra rice')).toMatchObject({ source: 'manual', food: { food_id: F.rice }, shopping_target: { quantity: 1000 } });
    expect(res.body.items).toHaveLength(6);
    expect(itemOf(res.body, F.rice).generated_quantity).toEqual({ quantity: 1200, quantity_exact: '1200/1', unit: 'g' });
    expect((await pool.query('select count(*)::int as n from grocery_list_item_source')).rows[0].n).toBe(sourcesBefore);
    expect((await A().post(`${lists(SEED.profileA)}/${gen1}/manual-items`, { name: 'Ghost', food_id: '00000000-0000-4000-8000-00000000dead' })).status).toBe(400);
  });

  it('removing a manual item revokes it (kept as history) and blocks further purchases', async () => {
    const s = await shopping(gen1);
    const towels = manualOf(s, 'Paper towels');
    const res = await A().post(`${lists(SEED.profileA)}/${gen1}/manual-items/${towels.grocery_manual_item_id}/revoke`);
    expect(res.status).toBe(200);
    expect(res.body.manual_items.map((m: ManualView) => m.name)).not.toContain('Paper towels');
    expect(manualOf(res.body, 'Paper towels')).toMatchObject({ revoked_at: expect.any(String), purchases: [expect.any(Object)] });
    expect((await A().post(`${lists(SEED.profileA)}/${gen1}/manual-items/${towels.grocery_manual_item_id}/purchases`)).status).toBe(409);
  });
});

describe('A, V, AC-AE: separation and immutability', () => {
  it('A/V: 9B never touched a generated row; clients cannot modify generated data', async () => {
    expect(await generatedHash()).toEqual(generatedBefore);
    await expect(asAccountSql(SEED.accountA, 'update grocery_list_item set quantity = 1 where id = $1', [RICE()])).rejects.toThrow(/permission denied/);
    await expect(asAccountSql(SEED.accountA, 'update grocery_list_item_source set source_quantity = 1 where grocery_list_id = $1', [gen1])).rejects.toThrow(/permission denied/);
    await expect(asAccountSql(SEED.accountA, "update grocery_list set source_fingerprint = repeat('0', 64) where id = $1", [gen1])).rejects.toThrow(/permission denied/);
    await expect(asAccountSql(SEED.accountA, 'update grocery_item_already_have set quantity = 9 where grocery_list_item_id = $1', [RICE()])).rejects.toThrow(/only permitted change is revocation/);
    await expect(asAccountSql(SEED.accountA, 'delete from grocery_purchase where grocery_list_id = $1', [gen1])).rejects.toThrow(/permission denied/);
  });

  it('AC: no retailer, product, price or cart data exists', async () => {
    const tables = await pool.query("select table_name from information_schema.tables where table_schema = 'public' and table_name ~ '(retailer|cart|checkout|price|order)'");
    expect(tables.rows).toEqual([]);
    const cols = await pool.query("select table_name, column_name from information_schema.columns where table_name like 'grocery%' and column_name ~ '(retailer|price|product|cart|store)'");
    expect(cols.rows).toEqual([]);
  });

  it('AD/AE: shopping state never changes MealPlan, MealLog/MealItem, Food or Recipe data', async () => {
    expect(await worldState()).toEqual(worldBefore);
  });
});

describe('S-U: staleness and regeneration', () => {
  let gen2: string;

  it('S: a stale list keeps its shopping state and stays writable until regenerated', async () => {
    const riceItem = P.itemIds[0] as string;
    expect((await A().post(`${plans(SEED.profileA)}/${P.id}/items/${riceItem}/skip`)).status).toBe(201);
    const s = await shopping(gen1);
    expect(s.grocery_list.is_stale).toBe(true);
    expect(s.state_writable).toBe(true);
    expect(itemOf(s, F.rice)).toMatchObject({ already_have: { normalized_quantity: 400 }, purchased: { quantity: 800 }, status: 'purchased' });
    expect((await A().post(`${itemPath(gen1, RICE())}/purchases`, { quantity: 10, unit: 'g' })).status).toBe(201);
  });

  it('T: a new generation starts clean — nothing is carried forward', async () => {
    const res = await A().post(`${plans(SEED.profileA)}/${P.id}/grocery-lists`);
    expect(res.status).toBe(201);
    gen2 = res.body.id;
    const s = await shopping(gen2);
    expect(s).toMatchObject({ grocery_list: { generation_number: 2, is_current_generation: true }, manual_items: [], removed_manual_items: [], carry_forward: 'none' });
    for (const item of s.items) {
      expect(item.already_have).toBeNull();
      expect(item.shopping_adjustment).toBeNull();
      expect(item.history.purchases).toEqual([]);
    }
    expect(s.items.some((i) => i.food?.food_id === F.rice)).toBe(false); // the skipped item is gone from gen 2
  });

  it('U: the historical generation keeps its state, readable but no longer writable (API and database)', async () => {
    const s = await shopping(gen1);
    expect(s).toMatchObject({ state_writable: false, grocery_list: { status: 'superseded' } });
    expect(itemOf(s, F.rice).purchased.quantity).toBe(810);
    expect(manualOf(s, 'Coffee beans').status).toBe('partially_purchased');
    expect((await A().post(`${itemPath(gen1, MILK())}/already-have`, { quantity: 1, unit: 'ml' })).status).toBe(409);
    expect((await A().post(`${lists(SEED.profileA)}/${gen1}/manual-items`, { name: 'Late' })).status).toBe(409);
    await expect(
      asAccountSql(SEED.accountA, 'insert into grocery_purchase (profile_id, grocery_list_id, grocery_list_item_id, quantity, unit) values ($1, $2, $3, 1, $4)', [SEED.profileA, gen1, MILK(), 'ml']),
    ).rejects.toMatchObject({ constraint: 'grocery_shopping_list_writable' });
    const purchaseId = itemOf(s, F.rice).history.purchases[0]?.id as string;
    expect((await A().post(`${lists(SEED.profileA)}/${gen1}/purchases/${purchaseId}/revoke`)).status).toBe(409);
  });

  it('W: an item of another generation cannot be targeted through this list (API and database)', async () => {
    expect((await A().post(`${itemPath(gen2, MILK())}/already-have`, { quantity: 1, unit: 'ml' })).status).toBe(404);
    await expect(
      asAccountSql(SEED.accountA, "insert into grocery_item_already_have (profile_id, grocery_list_id, grocery_list_item_id, quantity, unit) values ($1, $2, $3, 1, 'ml')", [SEED.profileA, gen2, MILK()]),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(23503|23505)$/) }); // FK (item, list) or the per-item active index
    await expect(
      asAccountSql(SEED.accountA, "insert into grocery_purchase (profile_id, grocery_list_id, grocery_list_item_id, quantity, unit) values ($1, $2, $3, 1, 'ml')", [SEED.profileA, gen2, MILK()]),
    ).rejects.toMatchObject({ code: '23503' });
    // the gen-1 state was not touched by the refused writes
    expect((await pool.query('select count(*)::int as n from grocery_item_already_have where grocery_list_item_id = $1 and revoked_at is null', [MILK()])).rows[0].n).toBe(1);
  });
});

describe('W-AB: authorization and Profile isolation', () => {
  let childList: string;
  let childItem: string;

  it('W: a Profile A list is unreachable through Profile A2, even by the Account that owns both', async () => {
    expect((await A().get(`${lists(PROFILE_A2)}/${gen1}/shopping`)).status).toBe(404);
    const a2 = await makePlan(SEED.accountA, PROFILE_A2, 'A2 plan', [{ meal_type: 'lunch', items: [food(F.rice, 100)] }]);
    const a2List = (await A().post(`${plans(PROFILE_A2)}/${a2.id}/grocery-lists`)).body.id;
    // A2 state pointing at a Profile A list, and Profile A state pointing at an A2 list
    await expect(
      asAccountSql(SEED.accountA, "insert into grocery_manual_item (profile_id, grocery_list_id, name) values ($1, $2, 'x')", [PROFILE_A2, gen1]),
    ).rejects.toMatchObject({ code: 'P0002' });
    await expect(
      asAccountSql(SEED.accountA, "insert into grocery_item_already_have (profile_id, grocery_list_id, grocery_list_item_id, quantity, unit) values ($1, $2, $3, 1, 'g')", [SEED.profileA, a2List, RICE()]),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(P0002|23503)$/) });
  });

  it('Y: full_management manages the child’s shopping state', async () => {
    const plan = await makePlan(SEED.accountFullManagement, SEED.profileChild, 'Child week', [{ meal_type: 'lunch', items: [food(F.rice, 80)] }]);
    const gen = await as(SEED.accountFullManagement).post(`${plans(SEED.profileChild)}/${plan.id}/grocery-lists`);
    childList = gen.body.id;
    childItem = gen.body.items[0].id;
    const res = await as(SEED.accountFullManagement).post(`${itemPath(childList, childItem, SEED.profileChild)}/already-have`, { quantity: 30, unit: 'g' });
    expect(res.status).toBe(201);
    expect(res.body.items[0]).toMatchObject({ derived_need: { quantity: 50 } });
  });

  it('X: view_only reads the shopping view but cannot change it (API and database)', async () => {
    const v = as(SEED.accountViewOnly);
    expect((await v.get(`${lists(SEED.profileChild)}/${childList}/shopping`)).status).toBe(200);
    expect((await v.post(`${itemPath(childList, childItem, SEED.profileChild)}/purchases`, { quantity: 10, unit: 'g' })).status).toBe(403);
    expect((await v.post(`${lists(SEED.profileChild)}/${childList}/manual-items`, { name: 'x' })).status).toBe(403);
    expect((await v.post(`${itemPath(childList, childItem, SEED.profileChild)}/already-have/clear`)).status).toBe(403);
    await expect(asAccountSql(SEED.accountViewOnly, "insert into grocery_manual_item (profile_id, grocery_list_id, name) values ($1, $2, 'x')", [SEED.profileChild, childList])).rejects.toMatchObject({ code: '42501' });
    const updated = await asAccountSql(SEED.accountViewOnly, 'update grocery_item_already_have set revoked_at = now() where profile_id = $1', [SEED.profileChild]);
    expect(updated.rowCount).toBe(0);
  });

  it('Z: pediatric_weight_management records purchases for the authorized child (operational only)', async () => {
    const p = as(SEED.accountPediatric);
    const res = await p.post(`${itemPath(childList, childItem, SEED.profileChild)}/purchases`, { quantity: 50, unit: 'g' });
    expect(res.status).toBe(201);
    expect(res.body.items[0]).toMatchObject({ status: 'purchased' });
    expect(JSON.stringify(res.body)).not.toMatch(/calorie|deficit|advice|score|recommend/i);
  });

  it('AA/AB: a revoked guardian and unrelated Accounts see and change nothing (API and database)', async () => {
    for (const account of [SEED.accountRevoked, SEED.accountUnrelated]) {
      expect((await as(account).get(`${lists(SEED.profileChild)}/${childList}/shopping`)).status).toBe(404);
      expect((await as(account).post(`${itemPath(childList, childItem, SEED.profileChild)}/purchases`, { quantity: 1, unit: 'g' })).status).toBe(404);
    }
    for (const account of [SEED.accountRevoked, SEED.accountUnrelated, SEED.accountB]) {
      const r = await asAccountSql(
        account,
        'select (select count(*)::int from grocery_manual_item) as m, (select count(*)::int from grocery_item_already_have) as h, (select count(*)::int from grocery_item_shopping_adjustment) as a, (select count(*)::int from grocery_purchase) as p',
      );
      expect(r.rows[0]).toEqual({ m: 0, h: 0, a: 0, p: 0 });
    }
    await expect(asAccountSql(SEED.accountRevoked, "insert into grocery_manual_item (profile_id, grocery_list_id, name) values ($1, $2, 'x')", [SEED.profileChild, childList])).rejects.toMatchObject({ code: '42501' });
  });
});

describe('plan states', () => {
  it('a completed plan’s current list stays writable; an archived plan’s is read-only', async () => {
    const plan = await makePlan(SEED.accountA, SEED.profileA, 'Lifecycle', [{ meal_type: 'lunch', items: [food(F.rice, 100)] }]);
    const gen = await A().post(`${plans(SEED.profileA)}/${plan.id}/grocery-lists`);
    const [listId, itemId] = [gen.body.id, gen.body.items[0].id];
    expect((await A().patch(`${plans(SEED.profileA)}/${plan.id}`, { status: 'completed' })).status).toBe(200);
    expect((await A().post(`${itemPath(listId, itemId)}/purchases`, { quantity: 100, unit: 'g' })).status).toBe(201);
    expect((await A().patch(`${plans(SEED.profileA)}/${plan.id}`, { status: 'archived' })).status).toBe(200);
    expect((await A().post(`${itemPath(listId, itemId)}/purchases`, { quantity: 1, unit: 'g' })).status).toBe(409);
    const s = await shopping(listId);
    expect(s).toMatchObject({ state_writable: false });
    expect(s.items[0]).toMatchObject({ status: 'purchased' });
  });
});
