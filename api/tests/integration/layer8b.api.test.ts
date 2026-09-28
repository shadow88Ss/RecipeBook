// Layer 8B integration tests — planned vs actual (explicit links, skips,
// derived fulfillment) against the real migration chain and RLS harness.
// TEST FIXTURES ONLY — not production food, recipe, plan or meal data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
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
const meals = (profile: string) => `/v1/profiles/${profile}/meals`;
const PROFILE_A2 = 'b0b0b0b0-0000-4000-8000-0000000000a2';
const TZ = 'Asia/Dubai'; // UTC+4, no DST
const D1 = '2026-09-10';
const D2 = '2026-09-11';
const D3 = '2026-09-12';

const food = (food_id: string, quantity: number, unit = 'g') => ({ type: 'food', food_id, quantity, unit });
const serving = (food_id: string, quantity: number, serving_id: string) => ({ type: 'food', food_id, quantity, serving_id });
const recipeItem = (recipe_id: string, recipe_version_id: string, servings: number) => ({ type: 'recipe', recipe_id, recipe_version_id, servings });

type MealSpec = { meal_type: string; items: unknown[] };
/** ids[date][meal_type][index] of the items as created. */
type Ids = Record<string, Record<string, string[]>>;

async function makePlan(account: string, profile: string, name: string, spec: Record<string, MealSpec[]>, opts: { confirm?: boolean; start?: string; end?: string } = {}) {
  const c = as(account);
  const plan = await c.post(plans(profile), { name, start_date: opts.start ?? D1, end_date: opts.end ?? D3, local_timezone: TZ });
  expect(plan.status).toBe(201);
  const id: string = plan.body.id;
  for (const [date, mealSpecs] of Object.entries(spec)) {
    const day = await c.post(`${plans(profile)}/${id}/days`, { plan_date: date });
    expect(day.status).toBe(201);
    const dayId = day.body.days.find((d: { plan_date: string }) => d.plan_date === date).id;
    for (const [position, m] of mealSpecs.entries()) {
      expect((await c.post(`${plans(profile)}/${id}/days/${dayId}/meals`, { ...m, position })).status).toBe(201);
    }
  }
  if (opts.confirm !== false) expect((await c.post(`${plans(profile)}/${id}/confirm`)).status).toBe(200);
  const detail = await c.get(`${plans(profile)}/${id}`);
  const ids: Ids = {};
  for (const d of detail.body.days) {
    ids[d.plan_date] = {};
    for (const m of d.meals) (ids[d.plan_date] as Record<string, string[]>)[m.meal_type] = m.items.map((i: { id: string }) => i.id);
  }
  return { id, ids };
}

const at = (ids: Ids, date: string, mealType: string, index = 0) => {
  const v = ids[date]?.[mealType]?.[index];
  if (!v) throw new Error(`no item ${date}/${mealType}/${index}`);
  return v;
};

/** Logs one meal; returns the created MealItem ids in order. */
async function logMeal(account: string, profile: string, body: { logged_date: string; local_timezone?: string; consumed_at: string; items: unknown[]; meal_type?: string }) {
  const res = await as(account).post(meals(profile), { meal_type: body.meal_type ?? 'lunch', local_timezone: body.local_timezone ?? TZ, ...body });
  expect(res.status).toBe(201);
  return { mealLogId: res.body.id as string, itemIds: res.body.items.map((i: { id: string }) => i.id) as string[] };
}

/** consumed_at at the given Dubai wall-clock hour on a date. */
const dubai = (date: string, hour = 12) => new Date(`${date}T${String(hour).padStart(2, '0')}:00:00+04:00`).toISOString();

const link = (planId: string, itemId: string, mealItemId: string, relationship_type: 'same_item' | 'substitution', account: string = SEED.accountA, profile: string = SEED.profileA) =>
  as(account).post(`${plans(profile)}/${planId}/items/${itemId}/actual-links`, { meal_item_id: mealItemId, relationship_type });

type Fulfillment = {
  days: Array<{ plan_date: string; items: FItem[]; unplanned_actual_items: Array<{ id: string }>; state_counts: Record<string, number> }>;
  historical_items: FItem[];
  unplanned_actual_items: Array<{ id: string; plan_local_date: string }>;
  cancelled_item_ids: string[];
  state_counts: Record<string, number>;
};
type FItem = {
  planned_meal_item_id: string;
  fulfillment_state: string;
  links: Array<{ id: string; link_state: string; counted: boolean; linked_meal_item_id: string; active_meal_item_id: string | null; relationship_type: string }>;
  breakdown: null | {
    same_item: { link_count: number; actual_meal_item_ids: string[]; quantity_comparison: null | { status: string; basis: string | null; planned: number | null; actual: number | null; unit: string | null } };
    substitution: { link_count: number; actual_meal_item_ids: string[]; actual_nutrition: unknown };
  };
  nutrition_comparison: null | {
    nutrients: Array<{ nutrient_key: string; planned_value: number | null; actual_value: number | null; difference: number | null; difference_status: string; planned_coverage: string; actual_coverage: string }>;
    summary_difference: Record<string, { difference: number | null }>;
    planned: { summary: Record<string, { value: number | null }> };
    actual: { summary: Record<string, { value: number | null }> };
  };
  skip: null | { id: string; reason: string | null };
  history: { revoked_links: Array<{ id: string }>; revoked_skips: Array<{ id: string }> };
};

async function fulfillment(planId: string, account: string = SEED.accountA, profile: string = SEED.profileA): Promise<Fulfillment> {
  const res = await as(account).get(`${plans(profile)}/${planId}/fulfillment`);
  expect(res.status).toBe(200);
  return res.body;
}
const fItem = (f: Fulfillment, id: string): FItem => {
  const found = [...f.days.flatMap((d) => d.items), ...f.historical_items].find((i) => i.planned_meal_item_id === id);
  if (!found) throw new Error(`no fulfillment for ${id}`);
  return found;
};
const stateOf = async (planId: string, itemId: string) => fItem(await fulfillment(planId), itemId).fulfillment_state;

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

const insertLinkSql = 'insert into planned_actual_link (profile_id, planned_meal_item_id, meal_item_id, relationship_type) values ($1, $2, $3, $4) returning id';
const insertSkipSql = 'insert into planned_meal_item_skip (profile_id, planned_meal_item_id) values ($1, $2) returning id';

async function worldState() {
  const { rows } = await pool.query(`select
    (select count(*)::int from meal_log) as meal_logs,
    (select md5(coalesce(string_agg(to_jsonb(m)::text, ',' order by id), '')) from meal_item m) as meal_items,
    (select md5(coalesce(string_agg(to_jsonb(p)::text, ',' order by id), '')) from planned_meal_item p) as planned_items,
    (select md5(coalesce(string_agg(to_jsonb(l)::text, ',' order by id), '')) from planned_actual_link l) as links,
    (select md5(coalesce(string_agg(to_jsonb(s)::text, ',' order by id), '')) from planned_meal_item_skip s) as skips,
    (select md5(string_agg(id::text || amount_per_canonical_unit::text, ',' order by id)) from food_nutrient) as food_nutrients,
    (select count(*)::int from food_serving) as food_servings,
    (select count(*)::int from recipe_version) as recipe_versions,
    (select count(*)::int from effective_target_snapshot) as target_snapshots`);
  return rows[0];
}

let recipeId: string;
let recipeV1: string;
let recipeV2: string;
let P: { id: string; ids: Ids };
let iRice: string;
let iBread: string;
let iRecipe: string;
let iSpinach: string;
let iRiceSnack: string;
let iMilk: string;
let iR2a: string;
let iSkip: string;
let iUnlinked: string;
let iRec2: string;
let iAbove: string;
let iNoE: string;
let iRace1: string;
let iRace2: string;
let iRace3: string;
let baseline: Awaited<ReturnType<typeof worldState>>;

beforeAll(async () => {
  pool = await rebuildTestDatabase('recipebook_api_test_layer8b');
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

  P = await makePlan(SEED.accountA, SEED.profileA, 'Fixture week', {
    [D1]: [
      { meal_type: 'breakfast', items: [food(F.rice, 150), serving(F.bread, 2, SRV.breadSlice)] },
      { meal_type: 'lunch', items: [recipeItem(recipeId, recipeV1, 1.5)] },
      { meal_type: 'dinner', items: [food(F.spinach, 50)] },
      { meal_type: 'snack', items: [food(F.rice, 100), serving(F.milk, 1, SRV.milkCup)] },
    ],
    [D2]: [
      { meal_type: 'breakfast', items: [food(F.rice, 100)] },
      { meal_type: 'lunch', items: [food(F.spinach, 100)] },
      { meal_type: 'dinner', items: [food(F.rice, 200)] },
      { meal_type: 'snack', items: [recipeItem(recipeId, recipeV1, 1)] },
    ],
    [D3]: [
      { meal_type: 'breakfast', items: [food(F.rice, 100)] },
      { meal_type: 'lunch', items: [food(F.noEnergy, 100)] },
      { meal_type: 'dinner', items: [food(F.rice, 100)] },
      { meal_type: 'snack', items: [food(F.spinach, 40), food(F.rice, 100)] },
    ],
  });
  const ids = P.ids;
  [iRice, iBread] = [at(ids, D1, 'breakfast', 0), at(ids, D1, 'breakfast', 1)];
  iRecipe = at(ids, D1, 'lunch');
  iSpinach = at(ids, D1, 'dinner');
  [iRiceSnack, iMilk] = [at(ids, D1, 'snack', 0), at(ids, D1, 'snack', 1)];
  iR2a = at(ids, D2, 'breakfast');
  iSkip = at(ids, D2, 'lunch');
  iUnlinked = at(ids, D2, 'dinner');
  iRec2 = at(ids, D2, 'snack');
  iAbove = at(ids, D3, 'breakfast');
  iNoE = at(ids, D3, 'lunch');
  iRace1 = at(ids, D3, 'dinner');
  [iRace2, iRace3] = [at(ids, D3, 'snack', 0), at(ids, D3, 'snack', 1)];
  baseline = await worldState();
}, 90_000);

afterAll(async () => {
  await pool.end();
});

describe('schema', () => {
  it('links and skips are relationship records only: no stored fulfillment state, no delete grant', async () => {
    const cols = await pool.query("select column_name from information_schema.columns where table_name = 'planned_actual_link' order by ordinal_position");
    expect(cols.rows.map((r) => r.column_name)).toEqual([
      'id',
      'profile_id',
      'planned_meal_item_id',
      'meal_item_id',
      'relationship_type',
      'meal_item_chain_root_id',
      'created_at',
      'created_by_account_id',
      'revoked_at',
      'revoked_by_account_id',
    ]);
    const enums = await pool.query("select unnest(enum_range(null::planned_actual_relationship))::text as v");
    expect(enums.rows.map((r) => r.v)).toEqual(['same_item', 'substitution']);
    const grants = await pool.query(
      "select table_name, privilege_type from information_schema.role_table_grants where grantee = 'authenticated' and table_name in ('planned_actual_link', 'planned_meal_item_skip') order by 1, 2",
    );
    expect(grants.rows.every((r) => r.privilege_type !== 'DELETE')).toBe(true);
  });

  it('a fresh plan reports every current confirmed item as unlinked', async () => {
    const f = await fulfillment(P.id);
    expect(f.state_counts.unlinked).toBe(15);
    expect(f.days.map((d) => d.plan_date)).toEqual([D1, D2, D3]);
    expect(f.unplanned_actual_items).toEqual([]);
  });
});

describe('A-F, I, R: explicit links and derived quantities', () => {
  let rice150: string;

  it('A/C/13: exact Food link on an active plan -> fulfilled_exact (declared amount)', async () => {
    rice150 = (await logMeal(SEED.accountA, SEED.profileA, { logged_date: D1, consumed_at: dubai(D1, 8), items: [food(F.rice, 150)] })).itemIds[0] as string;
    const res = await link(P.id, iRice, rice150, 'same_item');
    expect(res.status).toBe(201);
    expect(res.body.link).toMatchObject({ planned_meal_item_id: iRice, meal_item_id: rice150, relationship_type: 'same_item', is_active: true, revoked_at: null });
    expect(res.body.link).not.toHaveProperty('created_by_account_id');
    expect(res.body.item_fulfillment.fulfillment_state).toBe('fulfilled_exact');
    expect(res.body.item_fulfillment.breakdown.same_item.quantity_comparison).toMatchObject({ status: 'equal', basis: 'declared_amount', unit: 'g', planned: 150, actual: 150 });
    const row = await pool.query('select created_by_account_id, meal_item_chain_root_id from planned_actual_link where id = $1', [res.body.link.id]);
    expect(row.rows[0]).toEqual({ created_by_account_id: SEED.accountA, meal_item_chain_root_id: rice150 });
  });

  it('R: a duplicate active link is rejected (API and database)', async () => {
    expect((await link(P.id, iRice, rice150, 'same_item')).status).toBe(409);
    await expect(asAccountSql(SEED.accountA, insertLinkSql, [SEED.profileA, iRice, rice150, 'same_item'])).rejects.toMatchObject({ constraint: 'uq_planned_actual_link_active' });
  });

  it('I: same_item needs the exact planned identity; substitution needs a different one', async () => {
    const spinach = (await logMeal(SEED.accountA, SEED.profileA, { logged_date: D1, consumed_at: dubai(D1, 19), items: [food(F.spinach, 30)] })).itemIds[0] as string;
    const wrong = await link(P.id, iRiceSnack, spinach, 'same_item');
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.details.issues[0].path).toBe('relationship_type');
    expect((await link(P.id, iSpinach, spinach, 'substitution')).status).toBe(400);
    await expect(asAccountSql(SEED.accountA, insertLinkSql, [SEED.profileA, iRiceSnack, spinach, 'same_item'])).rejects.toMatchObject({ constraint: 'planned_actual_link_same_identity' });
    await expect(asAccountSql(SEED.accountA, insertLinkSql, [SEED.profileA, iSpinach, spinach, 'substitution'])).rejects.toMatchObject({
      constraint: 'planned_actual_link_substitution_identity',
    });
    // D: 30 g of a planned 50 g -> partial
    const res = await link(P.id, iSpinach, spinach, 'same_item');
    expect(res.status).toBe(201);
    expect(res.body.item_fulfillment.fulfillment_state).toBe('partial');
    expect(res.body.item_fulfillment.breakdown.same_item.quantity_comparison).toMatchObject({ status: 'below_planned', planned: 50, actual: 30, difference: -20 });
  });

  it('serving-based plan vs gram log compare on the declared canonical amount (2 slices = 60 g)', async () => {
    const bread = (await logMeal(SEED.accountA, SEED.profileA, { logged_date: D1, consumed_at: dubai(D1, 8), items: [food(F.bread, 60)] })).itemIds[0] as string;
    const res = await link(P.id, iBread, bread, 'same_item');
    expect(res.status).toBe(201);
    expect(res.body.item_fulfillment.fulfillment_state).toBe('fulfilled_exact');
    expect(res.body.item_fulfillment.breakdown.same_item.quantity_comparison).toMatchObject({ basis: 'declared_amount', unit: 'g', planned: 60, actual: 60 });
  });

  it('quantity_not_comparable: a 1-cup (ml) plan vs a gram log of the same Food is never guessed', async () => {
    const milk = (await logMeal(SEED.accountA, SEED.profileA, { logged_date: D1, consumed_at: dubai(D1, 16), items: [food(F.milk, 250)] })).itemIds[0] as string;
    const res = await link(P.id, iMilk, milk, 'same_item');
    expect(res.status).toBe(201);
    expect(res.body.item_fulfillment.fulfillment_state).toBe('quantity_not_comparable');
    expect(res.body.item_fulfillment.breakdown.same_item.quantity_comparison).toMatchObject({ status: 'not_comparable', planned: null, actual: null });
  });

  it('B/E/F/10: two fractional RecipeVersion logs cumulatively fulfil one planned recipe item', async () => {
    const first = (await logMeal(SEED.accountA, SEED.profileA, { logged_date: D1, consumed_at: dubai(D1, 13), items: [recipeItem(recipeId, recipeV1, 0.75)] })).itemIds[0] as string;
    const r1 = await link(P.id, iRecipe, first, 'same_item');
    expect(r1.body.item_fulfillment.fulfillment_state).toBe('partial');
    const second = (await logMeal(SEED.accountA, SEED.profileA, { logged_date: D1, consumed_at: dubai(D1, 14), items: [recipeItem(recipeId, recipeV1, 0.75)] })).itemIds[0] as string;
    const r2 = await link(P.id, iRecipe, second, 'same_item');
    expect(r2.status).toBe(201);
    const item = r2.body.item_fulfillment as FItem;
    expect(item.fulfillment_state).toBe('fulfilled_exact');
    expect(item.links).toHaveLength(2);
    expect(item.breakdown?.same_item).toMatchObject({ link_count: 2, quantity_comparison: { basis: 'recipe_servings', planned: 1.5, actual: 1.5 } });
    // J: 0.75 + 0.75 servings of the same version = the planned snapshot exactly
    for (const n of item.nutrition_comparison?.nutrients ?? []) {
      if (n.difference_status === 'actual_minus_planned') expect(n.difference).toBe(0);
    }
  });

  it('above_planned_quantity: 100 g + 30 g against a planned 100 g', async () => {
    const logs = await logMeal(SEED.accountA, SEED.profileA, { logged_date: D3, consumed_at: dubai(D3, 8), items: [food(F.rice, 100), food(F.rice, 30)] });
    expect((await link(P.id, iAbove, logs.itemIds[0] as string, 'same_item')).body.item_fulfillment.fulfillment_state).toBe('fulfilled_exact');
    const res = await link(P.id, iAbove, logs.itemIds[1] as string, 'same_item');
    expect(res.body.item_fulfillment.fulfillment_state).toBe('above_planned_quantity');
    expect(res.body.item_fulfillment.breakdown.same_item.quantity_comparison).toMatchObject({ status: 'above_planned', planned: 100, actual: 130, difference: 30 });
  });
});

describe('G, 9, J: substitution and nutrition differences', () => {
  it('G/9: Food->Food substitution plus a partial same_item -> fulfilled_with_substitution with separate breakdowns', async () => {
    const logs = await logMeal(SEED.accountA, SEED.profileA, { logged_date: D1, consumed_at: dubai(D1, 17), items: [food(F.spinach, 80), food(F.rice, 50)] });
    const [spinach, rice] = logs.itemIds as [string, string];
    const sub = await link(P.id, iRiceSnack, spinach, 'substitution');
    expect(sub.status).toBe(201);
    expect(sub.body.item_fulfillment.fulfillment_state).toBe('fulfilled_with_substitution');
    const mixed = (await link(P.id, iRiceSnack, rice, 'same_item')).body.item_fulfillment as FItem;
    expect(mixed.fulfillment_state).toBe('fulfilled_with_substitution');
    expect(mixed.breakdown?.same_item).toMatchObject({ link_count: 1, actual_meal_item_ids: [rice], quantity_comparison: { status: 'below_planned', planned: 100, actual: 50 } });
    expect(mixed.breakdown?.substitution).toMatchObject({ link_count: 1, actual_meal_item_ids: [spinach] });
    expect(mixed.breakdown?.substitution.actual_nutrition).not.toBeNull();
    expect(JSON.stringify(mixed)).not.toMatch(/percent|adherence|score/i);
  });

  it('J: differences are actual - planned from the stored snapshots; incomplete data is never a difference', async () => {
    const f = await fulfillment(P.id);
    const spinachItem = fItem(f, iSpinach);
    const snaps = await pool.query(
      `select p.nutrition_snapshot as planned, m.nutrition_snapshot as actual from planned_meal_item p, planned_actual_link l join meal_item m on m.id = l.meal_item_id
        where p.id = $1 and l.planned_meal_item_id = p.id`,
      [iSpinach],
    );
    const exact = (snap: { nutrients: Array<{ nutrient_key: string; value_exact: string | null }> }, key: string) => {
      const v = snap.nutrients.find((n) => n.nutrient_key === key)?.value_exact;
      if (!v) return null;
      const [n, d] = v.split('/').map(Number) as [number, number];
      return n / d;
    };
    const protein = spinachItem.nutrition_comparison?.nutrients.find((n) => n.nutrient_key === 'protein');
    const plannedP = exact(snaps.rows[0].planned, 'protein') as number;
    const actualP = exact(snaps.rows[0].actual, 'protein') as number;
    expect(protein?.difference).toBeCloseTo(actualP - plannedP, 6);
    expect(protein?.difference).toBeLessThan(0);
    expect(spinachItem.nutrition_comparison?.summary_difference.protein_g?.difference).toBe(protein?.difference);

    const noE = (await logMeal(SEED.accountA, SEED.profileA, { logged_date: D3, consumed_at: dubai(D3, 12), items: [food(F.noEnergy, 100)] })).itemIds[0] as string;
    const res = (await link(P.id, iNoE, noE, 'same_item')).body.item_fulfillment as FItem;
    expect(res.fulfillment_state).toBe('fulfilled_exact');
    const energy = res.nutrition_comparison?.nutrients.find((n) => n.nutrient_key === 'energy');
    expect(energy?.planned_coverage).not.toBe('complete');
    expect(energy).toMatchObject({ difference: null, difference_status: 'not_comparable_incomplete_data' });
    expect(res.nutrition_comparison?.summary_difference.energy_kcal?.difference).toBeNull();
  });
});

describe('M, N, 12, 18: unlinked, unplanned and plan-time-zone day matching', () => {
  let nyEvening: string;

  it('M: an unlinked planned item is reported as unlinked', async () => {
    expect(await stateOf(P.id, iUnlinked)).toBe('unlinked');
  });

  it('12: consumed_at is converted to the PLAN time zone; the MealLog logged_date/zone are not compared', async () => {
    // New York 2026-09-09 22:30 = Dubai 2026-09-10 06:30 -> plan day D1
    const early = await logMeal(SEED.accountA, SEED.profileA, { logged_date: '2026-09-09', local_timezone: 'America/New_York', consumed_at: '2026-09-10T02:30:00.000Z', items: [food(F.rice, 40)] });
    expect((await link(P.id, iRiceSnack, early.itemIds[0] as string, 'same_item')).status).toBe(201);
    // New York 2026-09-10 20:30 = Dubai 2026-09-11 04:30 -> NOT plan day D1
    const late = await logMeal(SEED.accountA, SEED.profileA, { logged_date: D1, local_timezone: 'America/New_York', consumed_at: '2026-09-11T00:30:00.000Z', items: [food(F.rice, 40)] });
    nyEvening = late.itemIds[0] as string;
    const refused = await link(P.id, iRiceSnack, nyEvening, 'same_item');
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toMatch(/2026-09-11/);
    await expect(asAccountSql(SEED.accountA, insertLinkSql, [SEED.profileA, iRiceSnack, nyEvening, 'same_item'])).rejects.toMatchObject({ constraint: 'planned_actual_link_same_plan_day' });
  });

  it('N/18: unplanned actual items are active chain records only, dated in the plan time zone', async () => {
    const milk = await logMeal(SEED.accountA, SEED.profileA, { logged_date: D2, consumed_at: dubai(D2, 10), items: [food(F.milk, 200, 'ml')], meal_type: 'snack' });
    const original = milk.itemIds[0] as string;
    const corrected = await A().post(`${meals(SEED.profileA)}/${milk.mealLogId}/items/${original}/correct`, { correction_reason: 'was 250', item: food(F.milk, 250, 'ml') });
    expect(corrected.status).toBe(201);
    const f = await fulfillment(P.id);
    const unplanned = f.unplanned_actual_items.map((u) => u.id);
    expect(unplanned).toContain(corrected.body.id);
    expect(unplanned).not.toContain(original);
    expect(unplanned).toContain(nyEvening);
    expect(f.unplanned_actual_items.find((u) => u.id === nyEvening)?.plan_local_date).toBe(D2);
    expect(f.days.find((d) => d.plan_date === D2)?.unplanned_actual_items.map((u) => u.id)).toEqual(expect.arrayContaining([corrected.body.id, nyEvening]));
    const linkedIds = (await pool.query('select meal_item_id from planned_actual_link where revoked_at is null')).rows.map((r) => r.meal_item_id);
    for (const id of linkedIds) expect(unplanned).not.toContain(id);
    expect(f.unplanned_actual_items[0]).toMatchObject({ classification: 'not_linked_to_current_planned_item' });

    const day = await A().get(`${plans(SEED.profileA)}/${P.id}/fulfillment/days/${D2}`);
    expect(day.status).toBe(200);
    expect(day.body).toMatchObject({ plan_date: D2, meal_plan_id: P.id });
    expect(day.body.unplanned_actual_items.map((u: { id: string }) => u.id)).toContain(corrected.body.id);
    expect((await A().get(`${plans(SEED.profileA)}/${P.id}/fulfillment/days/2026-09-20`)).status).toBe(400);
  });
});

describe('O, 6, 7, 8, H, 11: correction chains', () => {
  it('O/6: a corrected actual is read through its chain to the active record and counted once', async () => {
    const logs = await logMeal(SEED.accountA, SEED.profileA, { logged_date: D2, consumed_at: dubai(D2, 21), items: [food(F.rice, 200)] });
    const original = logs.itemIds[0] as string;
    const l = await link(P.id, iUnlinked, original, 'same_item');
    expect(l.body.item_fulfillment.fulfillment_state).toBe('fulfilled_exact');
    const corr = await A().post(`${meals(SEED.profileA)}/${logs.mealLogId}/items/${original}/correct`, { correction_reason: 'weighed', item: food(F.rice, 180) });
    const item = fItem(await fulfillment(P.id), iUnlinked);
    expect(item.fulfillment_state).toBe('partial');
    expect(item.links).toEqual([expect.objectContaining({ linked_meal_item_id: original, active_meal_item_id: corr.body.id, link_state: 'valid', counted: true })]);
    expect(item.breakdown?.same_item).toMatchObject({ actual_meal_item_ids: [corr.body.id], quantity_comparison: { actual: 180 } });
    // the link row still names the original MealItem (no rewrite)
    expect((await pool.query('select meal_item_id from planned_actual_link where id = $1', [l.body.link.id])).rows[0].meal_item_id).toBe(original);
    // the superseded record cannot be linked; the correction is the same consumption (already linked)
    expect((await link(P.id, iUnlinked, original, 'same_item')).status).toBe(409);
    expect((await link(P.id, iUnlinked, corr.body.id, 'same_item')).status).toBe(409);
    await expect(asAccountSql(SEED.accountA, insertLinkSql, [SEED.profileA, iUnlinked, corr.body.id, 'same_item'])).rejects.toMatchObject({ constraint: 'uq_planned_actual_link_active' });
  });

  it('7: a Food A -> B correction on a same_item link shows identity_changed_by_correction; relinking is explicit', async () => {
    const logs = await logMeal(SEED.accountA, SEED.profileA, { logged_date: D2, consumed_at: dubai(D2, 8), items: [food(F.rice, 100)] });
    const l = await link(P.id, iR2a, logs.itemIds[0] as string, 'same_item');
    expect(l.body.item_fulfillment.fulfillment_state).toBe('fulfilled_exact');
    const corr = await A().post(`${meals(SEED.profileA)}/${logs.mealLogId}/items/${logs.itemIds[0]}/correct`, { correction_reason: 'it was spinach', item: food(F.spinach, 100) });
    const item = fItem(await fulfillment(P.id), iR2a);
    expect(item.fulfillment_state).toBe('identity_changed_by_correction');
    expect(item.links[0]).toMatchObject({ link_state: 'identity_changed_by_correction', counted: false, active_meal_item_id: corr.body.id });
    expect(item.nutrition_comparison).toBeNull();
    // never auto-converted: the stored relationship is unchanged
    expect((await pool.query('select relationship_type from planned_actual_link where id = $1', [l.body.link.id])).rows[0].relationship_type).toBe('same_item');
    expect((await A().post(`${plans(SEED.profileA)}/${P.id}/actual-links/${l.body.link.id}/revoke`)).status).toBe(200);
    const relinked = await link(P.id, iR2a, corr.body.id, 'substitution');
    expect(relinked.status).toBe(201);
    expect(relinked.body.item_fulfillment.fulfillment_state).toBe('fulfilled_with_substitution');
  });

  it('8/H/L/20: a RecipeVersion A -> B correction is identity_changed; relinked as a Recipe->Recipe substitution; recipe edits change nothing', async () => {
    const before = await fulfillment(P.id);
    const edited = await A().patch(`/v1/profiles/${SEED.profileA}/recipes/${recipeId}`, { servings: 2, expected_current_version_id: recipeV1 });
    expect(edited.status).toBe(200);
    recipeV2 = edited.body.current_version.id;
    expect(await fulfillment(P.id)).toEqual(before); // L/20

    const logs = await logMeal(SEED.accountA, SEED.profileA, { logged_date: D2, consumed_at: dubai(D2, 16), items: [recipeItem(recipeId, recipeV1, 1)] });
    const l = await link(P.id, iRec2, logs.itemIds[0] as string, 'same_item');
    expect(l.body.item_fulfillment.fulfillment_state).toBe('fulfilled_exact');
    const corr = await A().post(`${meals(SEED.profileA)}/${logs.mealLogId}/items/${logs.itemIds[0]}/correct`, { correction_reason: 'new version', item: recipeItem(recipeId, recipeV2, 1) });
    expect(corr.status).toBe(201);
    expect(await stateOf(P.id, iRec2)).toBe('identity_changed_by_correction');
    expect((await A().post(`${plans(SEED.profileA)}/${P.id}/actual-links/${l.body.link.id}/revoke`)).status).toBe(200);
    expect((await link(P.id, iRec2, corr.body.id, 'same_item')).status).toBe(400);
    const sub = await link(P.id, iRec2, corr.body.id, 'substitution');
    expect(sub.status).toBe(201);
    expect(sub.body.item_fulfillment.fulfillment_state).toBe('fulfilled_with_substitution');
    expect(sub.body.item_fulfillment.breakdown.substitution.actual_meal_item_ids).toEqual([corr.body.id]);
  });

  it('11: one actual chain cannot actively fulfil two current planned items (API and database)', async () => {
    const rice = (await pool.query('select meal_item_id from planned_actual_link where planned_meal_item_id = $1 and revoked_at is null', [iRice])).rows[0].meal_item_id;
    const res = await link(P.id, iRiceSnack, rice, 'same_item');
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/another current planned item/);
    await expect(asAccountSql(SEED.accountA, insertLinkSql, [SEED.profileA, iRiceSnack, rice, 'same_item'])).rejects.toMatchObject({ constraint: 'planned_actual_link_one_current_plan_item' });
  });
});

describe('Z, AA, 1, 2, 3, 5, 17: skips and revocation', () => {
  let skipId: string;

  it('Z/1: skipping a confirmed item records a skip and does not modify the PlannedMealItem', async () => {
    const before = (await pool.query('select to_jsonb(p) as row from planned_meal_item p where id = $1', [iSkip])).rows[0].row;
    const res = await A().post(`${plans(SEED.profileA)}/${P.id}/items/${iSkip}/skip`, { reason: 'ate out' });
    expect(res.status).toBe(201);
    skipId = res.body.skip.id;
    expect(res.body.skip).toMatchObject({ planned_meal_item_id: iSkip, reason: 'ate out', is_active: true });
    expect(res.body.item_fulfillment).toMatchObject({ fulfillment_state: 'skipped', skip: { id: skipId, reason: 'ate out' } });
    expect((await pool.query('select to_jsonb(p) as row from planned_meal_item p where id = $1', [iSkip])).rows[0].row).toEqual(before);
    expect((await pool.query('select skipped_by_account_id from planned_meal_item_skip where id = $1', [skipId])).rows[0].skipped_by_account_id).toBe(SEED.accountA);
    expect((await A().post(`${plans(SEED.profileA)}/${P.id}/items/${iSkip}/skip`)).status).toBe(409);
    await expect(asAccountSql(SEED.accountA, insertSkipSql, [SEED.profileA, iSkip])).rejects.toMatchObject({ constraint: 'uq_planned_meal_item_skip_active' });
  });

  it('3: a skipped item cannot be linked and a linked item cannot be skipped (API and database)', async () => {
    const spinach = (await logMeal(SEED.accountA, SEED.profileA, { logged_date: D2, consumed_at: dubai(D2, 13), items: [food(F.spinach, 100)] })).itemIds[0] as string;
    expect((await link(P.id, iSkip, spinach, 'same_item')).status).toBe(409);
    await expect(asAccountSql(SEED.accountA, insertLinkSql, [SEED.profileA, iSkip, spinach, 'same_item'])).rejects.toMatchObject({ constraint: 'planned_actual_link_not_skipped' });
    expect((await A().post(`${plans(SEED.profileA)}/${P.id}/items/${iRice}/skip`)).status).toBe(409);
    await expect(asAccountSql(SEED.accountA, insertSkipSql, [SEED.profileA, iRice])).rejects.toMatchObject({ constraint: 'planned_meal_item_skip_no_links' });
  });

  it('5: unskip revokes (never deletes) the skip; a later skip is a new record', async () => {
    const res = await A().post(`${plans(SEED.profileA)}/${P.id}/items/${iSkip}/unskip`);
    expect(res.status).toBe(200);
    expect(res.body.skip).toMatchObject({ id: skipId, is_active: false });
    expect(res.body.item_fulfillment.fulfillment_state).toBe('unlinked');
    expect(res.body.item_fulfillment.history.revoked_skips.map((s: { id: string }) => s.id)).toEqual([skipId]);
    const row = (await pool.query('select revoked_at, revoked_by_account_id from planned_meal_item_skip where id = $1', [skipId])).rows[0];
    expect(row.revoked_at).not.toBeNull();
    expect(row.revoked_by_account_id).toBe(SEED.accountA);
    expect((await A().post(`${plans(SEED.profileA)}/${P.id}/items/${iSkip}/unskip`)).status).toBe(409);
    expect((await A().post(`${plans(SEED.profileA)}/${P.id}/items/${iSkip}/skip`, { reason: 'again' })).status).toBe(201);
    expect((await pool.query('select count(*)::int as n from planned_meal_item_skip where planned_meal_item_id = $1', [iSkip])).rows[0].n).toBe(2);
    // a revoked record is immutable; nothing can be deleted
    await expect(asAccountSql(SEED.accountA, "update planned_meal_item_skip set reason = 'x' where id = $1", [skipId])).rejects.toThrow(/immutable/);
    await expect(asAccountSql(SEED.accountA, 'delete from planned_meal_item_skip where id = $1', [skipId])).rejects.toThrow(/permission denied/);
    await expect(asAccountSql(SEED.accountA, 'delete from planned_actual_link')).rejects.toThrow(/permission denied/);
  });

  it('17: a revoked link does not contribute but stays as history', async () => {
    const f = await fulfillment(P.id);
    const iR2 = fItem(f, iR2a);
    expect(iR2.history.revoked_links).toHaveLength(1);
    expect(iR2.links.every((l) => l.relationship_type === 'substitution')).toBe(true);
    const bread = fItem(f, iBread);
    const linkId = bread.links[0]?.id as string;
    const res = await A().post(`${plans(SEED.profileA)}/${P.id}/actual-links/${linkId}/revoke`);
    expect(res.body.item_fulfillment).toMatchObject({ fulfillment_state: 'unlinked', breakdown: null, nutrition_comparison: null });
    expect(res.body.item_fulfillment.history.revoked_links.map((l: { id: string }) => l.id)).toEqual([linkId]);
    expect((await A().post(`${plans(SEED.profileA)}/${P.id}/actual-links/${linkId}/revoke`)).status).toBe(409);
    expect((await pool.query('select count(*)::int as n from planned_actual_link where id = $1', [linkId])).rows[0].n).toBe(1);
    await expect(asAccountSql(SEED.accountA, 'update planned_actual_link set relationship_type = $2 where id = $1', [linkId, 'substitution'])).rejects.toThrow(/immutable/);
  });

  it('AA/2: a cancelled item is not a skipped item and cannot be skipped', async () => {
    const detail = await A().get(`${plans(SEED.profileA)}/${P.id}`);
    const mealId = detail.body.days[2].meals[0].id;
    const added = await A().post(`${plans(SEED.profileA)}/${P.id}/meals/${mealId}/items`, { items: [food(F.spinach, 10)] });
    const draftId = added.body.days[2].meals[0].items.find((i: { status: string }) => i.status === 'draft').id;
    expect((await A().patch(`${plans(SEED.profileA)}/${P.id}/items/${draftId}`, { status: 'cancelled' })).status).toBe(200);
    expect((await A().post(`${plans(SEED.profileA)}/${P.id}/items/${draftId}/skip`)).status).toBe(409);
    await expect(asAccountSql(SEED.accountA, insertSkipSql, [SEED.profileA, draftId])).rejects.toMatchObject({ constraint: 'planned_item_current_confirmed' });
    const f = await fulfillment(P.id);
    expect(f.cancelled_item_ids).toEqual([draftId]);
    expect(f.days.flatMap((d) => d.items).some((i) => i.planned_meal_item_id === draftId)).toBe(false);
    expect(f.state_counts.skipped).toBe(1); // only iSkip
  });
});

describe('4: concurrency (skip/link and chain races are serialized in the database)', () => {
  async function race(first: (c: PoolClient) => Promise<unknown>, second: (c: PoolClient) => Promise<unknown>) {
    const c1 = await txAs(SEED.accountA);
    const c2 = await txAs(SEED.accountA);
    try {
      await first(c1);
      let settled = false;
      const pending = second(c2).then(
        () => {
          settled = true;
          return null;
        },
        (err: unknown) => {
          settled = true;
          return err as { constraint?: string };
        },
      );
      await new Promise((r) => setTimeout(r, 300));
      expect(settled).toBe(false); // blocked on the first transaction's lock
      await c1.query('commit');
      return await pending;
    } finally {
      await c2.query('rollback').catch(() => undefined);
      c1.release();
      c2.release();
    }
  }

  it('skip committed first -> the concurrent link fails', async () => {
    const rice = (await logMeal(SEED.accountA, SEED.profileA, { logged_date: D3, consumed_at: dubai(D3, 20), items: [food(F.rice, 100)] })).itemIds[0] as string;
    const err = await race(
      (c) => c.query(insertSkipSql, [SEED.profileA, iRace1]),
      (c) => c.query(insertLinkSql, [SEED.profileA, iRace1, rice, 'same_item']),
    );
    expect(err).toMatchObject({ constraint: 'planned_actual_link_not_skipped' });
    expect(await stateOf(P.id, iRace1)).toBe('skipped');
  });

  it('link committed first -> the concurrent skip fails', async () => {
    const spinach = (await logMeal(SEED.accountA, SEED.profileA, { logged_date: D3, consumed_at: dubai(D3, 17), items: [food(F.spinach, 40)] })).itemIds[0] as string;
    const err = await race(
      (c) => c.query(insertLinkSql, [SEED.profileA, iRace2, spinach, 'same_item']),
      (c) => c.query(insertSkipSql, [SEED.profileA, iRace2]),
    );
    expect(err).toMatchObject({ constraint: 'planned_meal_item_skip_no_links' });
    expect(await stateOf(P.id, iRace2)).toBe('fulfilled_exact');
  });

  it('one chain linked concurrently to two current planned items -> exactly one succeeds', async () => {
    const rice = (await logMeal(SEED.accountA, SEED.profileA, { logged_date: D3, consumed_at: dubai(D3, 18), items: [food(F.rice, 100)] })).itemIds[0] as string;
    const err = await race(
      (c) => c.query(insertLinkSql, [SEED.profileA, iRace3, rice, 'same_item']),
      (c) => c.query(insertLinkSql, [SEED.profileA, iAbove, rice, 'same_item']),
    );
    expect(err).toMatchObject({ constraint: 'planned_actual_link_one_current_plan_item' });
    expect((await pool.query('select count(*)::int as n from planned_actual_link where meal_item_id = $1 and revoked_at is null', [rice])).rows[0].n).toBe(1);
  });
});

describe('K/19, AB, AC, AD, AE, 21, 22: history is snapshots only; reads write nothing', () => {
  it('K/19: a Food reference change after snapshotting does not alter fulfillment', async () => {
    const before = await fulfillment(P.id);
    await pool.query("update food_nutrient set amount_per_canonical_unit = 3 where food_id = $1 and nutrient_id = $2 and source = 'trusted_database'", [F.rice, NUT.protein]);
    try {
      expect(await fulfillment(P.id)).toEqual(before);
    } finally {
      await pool.query("update food_nutrient set amount_per_canonical_unit = 2.7 where food_id = $1 and nutrient_id = $2 and source = 'trusted_database'", [F.rice, NUT.protein]);
    }
  });

  it('AD: fulfillment reads perform no writes anywhere', async () => {
    const before = await worldState();
    await fulfillment(P.id);
    await A().get(`${plans(SEED.profileA)}/${P.id}/fulfillment/days/${D1}`);
    await A().get(`${plans(SEED.profileA)}/${P.id}/items/${iRice}/fulfillment`);
    expect(await worldState()).toEqual(before);
  });

  it('AB/AC/21/22/AE: linking and skipping never modify planned items, meal items, logs, Food or Recipe data', async () => {
    const plannedBefore = await pool.query('select md5(string_agg(to_jsonb(p)::text, \',\' order by id)) as h from planned_meal_item p where p.status = \'confirmed\'');
    const mealsBefore = (await pool.query('select md5(string_agg(to_jsonb(m)::text, \',\' order by id)) as h from meal_item m')).rows[0].h;
    const planDetail = (await A().get(`${plans(SEED.profileA)}/${P.id}`)).body;
    const rice = (await logMeal(SEED.accountA, SEED.profileA, { logged_date: D2, consumed_at: dubai(D2, 22), items: [food(F.spinach, 5)] })).itemIds[0] as string;
    const mealsAfterLog = (await pool.query('select md5(string_agg(to_jsonb(m)::text, \',\' order by id)) as h from meal_item m')).rows[0].h;
    const logsAfterLog = (await pool.query('select md5(string_agg(to_jsonb(l)::text, \',\' order by id)) as h from meal_log l')).rows[0].h;
    expect(mealsAfterLog).not.toBe(mealsBefore);
    const linked = await link(P.id, iUnlinked, rice, 'substitution');
    expect(linked.status).toBe(201);
    expect((await A().post(`${plans(SEED.profileA)}/${P.id}/actual-links/${linked.body.link.id}/revoke`)).status).toBe(200);
    expect((await pool.query('select md5(string_agg(to_jsonb(p)::text, \',\' order by id)) as h from planned_meal_item p where p.status = \'confirmed\'')).rows[0].h).toBe(plannedBefore.rows[0].h);
    expect((await pool.query('select md5(string_agg(to_jsonb(m)::text, \',\' order by id)) as h from meal_item m')).rows[0].h).toBe(mealsAfterLog);
    expect((await pool.query('select md5(string_agg(to_jsonb(l)::text, \',\' order by id)) as h from meal_log l')).rows[0].h).toBe(logsAfterLog);
    expect((await A().get(`${plans(SEED.profileA)}/${P.id}`)).body).toEqual(planDetail);
    const world = await worldState();
    expect({ fn: world.food_nutrients, fs: world.food_servings, t: world.target_snapshots }).toEqual({ fn: baseline.food_nutrients, fs: baseline.food_servings, t: baseline.target_snapshots });
    expect(world.recipe_versions).toBe(baseline.recipe_versions + 1); // only the explicit PATCH in test 8
  });
});

describe('P, Q: superseded planned intent', () => {
  it('P/Q: replacing a linked confirmed item moves the old intent to history; the new one is current and unlinked', async () => {
    const replaced = await A().post(`${plans(SEED.profileA)}/${P.id}/items/${iSpinach}/replace`, { ...food(F.spinach, 60) });
    expect(replaced.status).toBe(201);
    expect((await A().post(`${plans(SEED.profileA)}/${P.id}/confirm`)).status).toBe(200);
    const f = await fulfillment(P.id);
    const old = f.historical_items.find((i) => i.planned_meal_item_id === iSpinach) as FItem & { is_current: boolean };
    expect(old).toMatchObject({ is_current: false, fulfillment_state: 'partial' });
    expect(old.links).toHaveLength(1);
    expect(f.days.flatMap((d) => d.items).some((i) => i.planned_meal_item_id === iSpinach)).toBe(false);
    expect(fItem(f, replaced.body.id).fulfillment_state).toBe('unlinked');
    // the old intent is no longer current: its actual can now be linked to the replacement
    const spinach = old.links[0]?.active_meal_item_id as string;
    const relinked = await link(P.id, replaced.body.id, spinach, 'same_item');
    expect(relinked.status).toBe(201);
    expect(relinked.body.item_fulfillment.fulfillment_state).toBe('partial');
    // a superseded item cannot be linked or skipped
    expect((await A().post(`${plans(SEED.profileA)}/${P.id}/items/${iSpinach}/skip`)).status).toBe(409);
  });
});

describe('S, T, U, V, W, X, Y: security', () => {
  let childPlan: { id: string; ids: Ids };
  let childRice: string;

  it('S: a MealItem of another Profile cannot be linked (API and database)', async () => {
    const other = (await logMeal(SEED.accountA, PROFILE_A2, { logged_date: D3, consumed_at: dubai(D3, 9), items: [food(F.rice, 100)] })).itemIds[0] as string;
    const res = await link(P.id, iRace3, other, 'same_item');
    expect(res.status).toBe(400);
    expect(res.body.error.details.issues[0].path).toBe('meal_item_id');
    await expect(asAccountSql(SEED.accountA, insertLinkSql, [SEED.profileA, iRace3, other, 'same_item'])).rejects.toMatchObject({ constraint: 'planned_actual_link_actual_active' });
    await expect(asAccountSql(SEED.accountA, insertLinkSql, [PROFILE_A2, iRace3, other, 'same_item'])).rejects.toMatchObject({ constraint: 'planned_item_current_confirmed' });
  });

  it('T: a planned item of another plan cannot be addressed through this plan', async () => {
    const other = await makePlan(SEED.accountA, SEED.profileA, 'Other', { [D3]: [{ meal_type: 'breakfast', items: [food(F.rice, 100)] }] });
    const rice = (await logMeal(SEED.accountA, SEED.profileA, { logged_date: D3, consumed_at: dubai(D3, 7), items: [food(F.rice, 100)] })).itemIds[0] as string;
    expect((await link(P.id, at(other.ids, D3, 'breakfast'), rice, 'same_item')).status).toBe(404);
    expect((await A().post(`${plans(SEED.profileA)}/${P.id}/items/${at(other.ids, D3, 'breakfast')}/skip`)).status).toBe(404);
    const linkId = (await pool.query('select id from planned_actual_link where revoked_at is null limit 1')).rows[0].id;
    expect((await A().post(`${plans(SEED.profileA)}/${other.id}/actual-links/${linkId}/revoke`)).status).toBe(404);
    // overlapping plans: consumption linked in one plan is not "unplanned" in the other
    expect((await link(other.id, at(other.ids, D3, 'breakfast'), rice, 'same_item')).status).toBe(201);
    const f = await fulfillment(P.id);
    expect(f.unplanned_actual_items.map((u) => u.id)).not.toContain(rice);
    expect((f as unknown as { actual_items_linked_to_other_plans: Array<{ meal_item_id: string }> }).actual_items_linked_to_other_plans.map((x) => x.meal_item_id)).toContain(rice);
  });

  it('X: full_management links and skips for the child', async () => {
    childPlan = await makePlan(SEED.accountFullManagement, SEED.profileChild, 'Child week', {
      [D1]: [{ meal_type: 'lunch', items: [food(F.rice, 80)] }, { meal_type: 'snack', items: [food(F.spinach, 20)] }],
    });
    childRice = (await logMeal(SEED.accountFullManagement, SEED.profileChild, { logged_date: D1, consumed_at: dubai(D1, 12), items: [food(F.rice, 80)] })).itemIds[0] as string;
    const res = await link(childPlan.id, at(childPlan.ids, D1, 'lunch'), childRice, 'same_item', SEED.accountFullManagement, SEED.profileChild);
    expect(res.status).toBe(201);
    expect(res.body.item_fulfillment.fulfillment_state).toBe('fulfilled_exact');
    expect((await as(SEED.accountFullManagement).post(`${plans(SEED.profileChild)}/${childPlan.id}/items/${at(childPlan.ids, D1, 'snack')}/skip`)).status).toBe(201);
  });

  it('W: view_only reads fulfillment but cannot link, skip, unskip or revoke (API and database)', async () => {
    const v = as(SEED.accountViewOnly);
    expect((await v.get(`${plans(SEED.profileChild)}/${childPlan.id}/fulfillment`)).status).toBe(200);
    expect((await v.get(`${plans(SEED.profileChild)}/${childPlan.id}/fulfillment/days/${D1}`)).status).toBe(200);
    expect((await link(childPlan.id, at(childPlan.ids, D1, 'lunch'), childRice, 'same_item', SEED.accountViewOnly, SEED.profileChild)).status).toBe(403);
    expect((await v.post(`${plans(SEED.profileChild)}/${childPlan.id}/items/${at(childPlan.ids, D1, 'snack')}/unskip`)).status).toBe(403);
    expect((await v.post(`${plans(SEED.profileChild)}/${childPlan.id}/items/${at(childPlan.ids, D1, 'lunch')}/skip`)).status).toBe(403);
    await expect(asAccountSql(SEED.accountViewOnly, insertSkipSql, [SEED.profileChild, at(childPlan.ids, D1, 'lunch')])).rejects.toMatchObject({ code: '42501' });
    const updated = await asAccountSql(SEED.accountViewOnly, 'update planned_actual_link set revoked_at = now() where profile_id = $1', [SEED.profileChild]);
    expect(updated.rowCount).toBe(0);
    expect((await asAccountSql(SEED.accountViewOnly, 'select count(*)::int as n from planned_actual_link where profile_id = $1', [SEED.profileChild])).rows[0].n).toBe(1);
  });

  it('Y: pediatric_weight_management reads and writes fulfillment for the authorized child', async () => {
    const p = as(SEED.accountPediatric);
    expect((await p.get(`${plans(SEED.profileChild)}/${childPlan.id}/fulfillment`)).status).toBe(200);
    const res = await p.post(`${plans(SEED.profileChild)}/${childPlan.id}/items/${at(childPlan.ids, D1, 'snack')}/unskip`);
    expect(res.status).toBe(200);
    expect(res.body.item_fulfillment.fulfillment_state).toBe('unlinked');
  });

  it('U/V: unrelated Accounts and a revoked guardian see nothing (API and database)', async () => {
    for (const account of [SEED.accountB, SEED.accountUnrelated]) {
      expect((await as(account).get(`${plans(SEED.profileA)}/${P.id}/fulfillment`)).status).toBe(404);
      expect((await link(P.id, iRace3, childRice, 'same_item', account)).status).toBe(404);
    }
    expect((await as(SEED.accountRevoked).get(`${plans(SEED.profileChild)}/${childPlan.id}/fulfillment`)).status).toBe(404);
    expect((await link(childPlan.id, at(childPlan.ids, D1, 'snack'), childRice, 'substitution', SEED.accountRevoked, SEED.profileChild)).status).toBe(404);
    for (const account of [SEED.accountRevoked, SEED.accountUnrelated, SEED.accountB]) {
      expect((await asAccountSql(account, 'select count(*)::int as n from planned_actual_link')).rows[0].n).toBe(0);
      expect((await asAccountSql(account, 'select count(*)::int as n from planned_meal_item_skip')).rows[0].n).toBe(0);
    }
    await expect(asAccountSql(SEED.accountRevoked, insertLinkSql, [SEED.profileChild, at(childPlan.ids, D1, 'snack'), childRice, 'substitution'])).rejects.toMatchObject({ code: '42501' });
  });
});

describe('6.4 plan status: 14, 15, 16', () => {
  it('15: draft and cancelled plans reject new links and skips (API and database)', async () => {
    const draft = await makePlan(SEED.accountA, SEED.profileA, 'Draft', { [D1]: [{ meal_type: 'lunch', items: [food(F.rice, 100)] }] }, { confirm: false });
    const rice = (await logMeal(SEED.accountA, SEED.profileA, { logged_date: D1, consumed_at: dubai(D1, 11), items: [food(F.rice, 100)] })).itemIds[0] as string;
    expect((await link(draft.id, at(draft.ids, D1, 'lunch'), rice, 'same_item')).status).toBe(409);
    expect((await A().post(`${plans(SEED.profileA)}/${draft.id}/items/${at(draft.ids, D1, 'lunch')}/skip`)).status).toBe(409);

    const cancelled = await makePlan(SEED.accountA, SEED.profileA, 'Cancelled', { [D1]: [{ meal_type: 'lunch', items: [food(F.rice, 100)] }] });
    expect((await A().patch(`${plans(SEED.profileA)}/${cancelled.id}`, { status: 'cancelled' })).status).toBe(200);
    expect((await link(cancelled.id, at(cancelled.ids, D1, 'lunch'), rice, 'same_item')).status).toBe(409);
    await expect(asAccountSql(SEED.accountA, insertLinkSql, [SEED.profileA, at(cancelled.ids, D1, 'lunch'), rice, 'same_item'])).rejects.toMatchObject({ constraint: 'planned_item_plan_status' });
    await expect(asAccountSql(SEED.accountA, insertSkipSql, [SEED.profileA, at(cancelled.ids, D1, 'lunch')])).rejects.toMatchObject({ constraint: 'planned_item_plan_status' });
  });

  it('14: a completed plan accepts retrospective links', async () => {
    expect((await A().patch(`${plans(SEED.profileA)}/${P.id}`, { status: 'completed' })).status).toBe(200);
    const bread = (await logMeal(SEED.accountA, SEED.profileA, { logged_date: D1, consumed_at: dubai(D1, 9), items: [serving(F.bread, 2, SRV.breadSlice)] })).itemIds[0] as string;
    const res = await link(P.id, iBread, bread, 'same_item');
    expect(res.status).toBe(201);
    expect(res.body.item_fulfillment.fulfillment_state).toBe('fulfilled_exact');
  });

  it('15/16: an archived plan rejects new links, skips and revocations but keeps its history readable', async () => {
    const before = await fulfillment(P.id);
    expect((await A().patch(`${plans(SEED.profileA)}/${P.id}`, { status: 'archived' })).status).toBe(200);
    const rice = (await logMeal(SEED.accountA, SEED.profileA, { logged_date: D3, consumed_at: dubai(D3, 21), items: [food(F.rice, 100)] })).itemIds[0] as string;
    expect((await link(P.id, iRace3, rice, 'same_item')).status).toBe(409);
    expect((await A().post(`${plans(SEED.profileA)}/${P.id}/items/${iUnlinked}/skip`)).status).toBe(409);
    const linkId = fItem(before, iRice).links[0]?.id as string;
    expect((await A().post(`${plans(SEED.profileA)}/${P.id}/actual-links/${linkId}/revoke`)).status).toBe(409);
    await expect(asAccountSql(SEED.accountA, 'update planned_actual_link set revoked_at = now() where id = $1', [linkId])).rejects.toMatchObject({ constraint: 'planned_item_plan_status' });
    const after = await fulfillment(P.id);
    expect(after.days).toEqual(before.days.map((d) => ({ ...d, unplanned_actual_items: after.days.find((x) => x.plan_date === d.plan_date)?.unplanned_actual_items })));
    expect(fItem(after, iRice).fulfillment_state).toBe('fulfilled_exact');
    expect(fItem(after, iR2a).history.revoked_links).toHaveLength(1);
  });
});
