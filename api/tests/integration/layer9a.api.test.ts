// Layer 9A integration tests — Grocery Planning core (preview + immutable
// generated lists) against the real migration chain and RLS harness.
// TEST FIXTURES ONLY — not production food, recipe, plan or grocery data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app';
import { logger } from '../../src/lib/logger';
import { PgHarnessProfileRepository } from '../helpers/pgHarnessProfileRepository';
import { PgHarnessScopedDbFactory } from '../helpers/pgHarnessScopedDb';
import { rebuildTestDatabase } from '../helpers/testDb';
import { seedScenario, SEED } from '../helpers/seed';
import { F, SRV, seedNutritionFixtures } from '../helpers/nutritionFixtures';
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
const RICE_OTHER = 'a5a5a5a5-0000-4000-8000-000000000001';
const TZ = 'Asia/Dubai';
const D1 = '2026-11-02';
const D2 = '2026-11-03';
const D3 = '2026-11-04';

const food = (food_id: string, quantity: number, unit = 'g') => ({ type: 'food', food_id, quantity, unit });
const serving = (food_id: string, quantity: number, serving_id: string) => ({ type: 'food', food_id, quantity, serving_id });
const recipeItem = (recipe_id: string, recipe_version_id: string, servings: number) => ({ type: 'recipe', recipe_id, recipe_version_id, servings });

type MealSpec = { meal_type: string; items: unknown[] };
type Ids = Record<string, Record<string, string[]>>;

async function makePlan(account: string, profile: string, name: string, spec: Record<string, MealSpec[]>, opts: { confirm?: boolean } = {}) {
  const c = as(account);
  const plan = await c.post(plans(profile), { name, start_date: D1, end_date: D3, local_timezone: TZ });
  expect(plan.status).toBe(201);
  const id: string = plan.body.id;
  for (const [date, mealSpecs] of Object.entries(spec)) {
    const day = await c.post(`${plans(profile)}/${id}/days`, { plan_date: date });
    const dayId = day.body.days.find((d: { plan_date: string }) => d.plan_date === date).id;
    for (const [position, m] of mealSpecs.entries()) expect((await c.post(`${plans(profile)}/${id}/days/${dayId}/meals`, { ...m, position })).status).toBe(201);
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

type Source = { planned_meal_item_id: string; source_type: string; recipe_version_id: string | null; recipe_ingredient_id: string | null; plan_date: string; contribution_quantity: number | null; scaled_quantity: number | null; meal_type: string | null; [k: string]: unknown };
type Item = { id?: string; food: { food_id: string } | null; display_name: string; dimension: string | null; quantity: number | null; quantity_exact: string | null; unit: string | null; resolution_status: string; aggregation_status: string; unresolved_reason: string | null; source_count: number; sources: Source[] };
type Grocery = { items: Item[]; summary: Record<string, number>; [k: string]: unknown };

const foodItems = (g: Grocery, foodId: string) => g.items.filter((i) => i.food?.food_id === foodId);
const one = (g: Grocery, foodId: string, dimension: string) => {
  const found = g.items.find((i) => i.food?.food_id === foodId && i.dimension === dimension);
  if (!found) throw new Error(`no ${dimension} item for ${foodId}`);
  return found;
};
const preview = async (planId: string, account: string = SEED.accountA, profile: string = SEED.profileA) => {
  const res = await as(account).get(`${plans(profile)}/${planId}/grocery-preview`);
  expect(res.status).toBe(200);
  return res.body as Grocery & { preview_type: string; source_fingerprint: string; current_grocery_list: null | { id: string; is_stale: boolean }; excluded_unconfirmed_sources: Array<{ planned_meal_item_id: string; reason: string }>; excluded_skipped_sources: Array<{ planned_meal_item_id: string }> };
};
const generate = (planId: string, body: unknown = {}, account: string = SEED.accountA, profile: string = SEED.profileA) => as(account).post(`${plans(profile)}/${planId}/grocery-lists`, body);
const getList = async (id: string, account: string = SEED.accountA, profile: string = SEED.profileA) => {
  const res = await as(account).get(`${lists(profile)}/${id}`);
  expect(res.status).toBe(200);
  return res.body as Grocery & { id: string; status: string; generation_number: number; is_stale: boolean; superseded_by_grocery_list_id: string | null; supersedes_grocery_list_id: string | null; generated_source_fingerprint: string; current_source_fingerprint: string; plan_context: Record<string, string>; excluded_unconfirmed_sources: Array<{ planned_meal_item_id: string; reason: string }> };
};
/** Items without row ids, for comparing a preview with a persisted list. */
const shape = (g: Grocery) => g.items.map(({ id: _id, ...rest }) => rest);

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

/** A generate_grocery_list() payload built from an API preview (for direct database tests). */
function rpcPayload(p: Awaited<ReturnType<typeof preview>>) {
  return {
    source_fingerprint: p.source_fingerprint,
    fingerprint_version: 'grocery-source-fingerprint-9a.1',
    calculation_version: 'grocery-calculation-9a.1',
    conversion_version: 'conversion-5a.1',
    excluded_sources: [],
    items: p.items.map((i, position) => ({
      ...i,
      position,
      food_id: i.food?.food_id ?? null,
      quantity: i.quantity === null ? null : String(i.quantity),
      sources: i.sources,
    })),
  };
}

async function worldState() {
  const { rows } = await pool.query(`select
    (select count(*)::int from meal_log) as meal_logs,
    (select md5(coalesce(string_agg(to_jsonb(m)::text, ',' order by id), '')) from meal_item m) as meal_items,
    (select md5(coalesce(string_agg(to_jsonb(l)::text, ',' order by id), '')) from planned_actual_link l) as links,
    (select md5(coalesce(string_agg(to_jsonb(s)::text, ',' order by id), '')) from planned_meal_item_skip s) as skips,
    (select md5(coalesce(string_agg(to_jsonb(p)::text, ',' order by id), '')) from planned_meal_item p) as planned_items,
    (select md5(coalesce(string_agg(to_jsonb(p)::text, ',' order by id), '')) from meal_plan p) as plans,
    (select md5(coalesce(string_agg(to_jsonb(f)::text, ',' order by id), '')) from food f) as foods,
    (select md5(coalesce(string_agg(to_jsonb(s)::text, ',' order by id), '')) from food_serving s) as servings,
    (select md5(coalesce(string_agg(to_jsonb(n)::text, ',' order by id), '')) from food_nutrient n) as food_nutrients,
    (select md5(coalesce(string_agg(to_jsonb(r)::text, ',' order by id), '')) from recipe r) as recipes,
    (select md5(coalesce(string_agg(to_jsonb(v)::text, ',' order by id), '')) from recipe_version v) as recipe_versions,
    (select md5(coalesce(string_agg(to_jsonb(i)::text, ',' order by id), '')) from recipe_ingredient i) as recipe_ingredients`);
  return rows[0];
}
const groceryRowCounts = async () =>
  (
    await pool.query(
      'select (select count(*)::int from grocery_list) as lists, (select count(*)::int from grocery_list_item) as items, (select count(*)::int from grocery_list_item_source) as sources',
    )
  ).rows[0];

let r1: { id: string; v1: string };
let r2: { id: string; v1: string };
let P: { id: string; ids: Ids };
let gen1: string;
let gen2: string;
let gen3: string;

beforeAll(async () => {
  pool = await rebuildTestDatabase('recipebook_api_test_layer9a');
  await seedScenario(pool);
  await seedNutritionFixtures(pool);
  await pool.query("insert into profile (id, account_id, display_name, is_child) values ($1, $2, 'Profile A2', false)", [PROFILE_A2, SEED.accountA]);
  await pool.query("insert into food (id, canonical_name, source) values ($1, 'fixture9a_rice_other', 'trusted_database')", [RICE_OTHER]);
  // both fixture rices are called "Rice" by users
  await pool.query("insert into food_alias (food_id, locale, alias_text, is_primary, source) values ($1, 'en', 'Rice', true, 'trusted_database'), ($2, 'en', 'Rice', true, 'trusted_database')", [F.rice, RICE_OTHER]);
  app = createApp({
    profileRepository: new PgHarnessProfileRepository(pool),
    scopedDbFactory: new PgHarnessScopedDbFactory(pool),
    jwtSecret: TEST_JWT_SECRET,
    logger,
  });
  const recipe = async (body: unknown) => {
    const res = await A().post(`/v1/profiles/${SEED.profileA}/recipes`, body);
    expect(res.status).toBe(201);
    return { id: res.body.id as string, v1: res.body.current_version.id as string };
  };
  // R1: yield 4
  r1 = await recipe({
    title: 'Fixture Rice Bowl',
    servings: 4,
    ingredients: [
      { text: '600 g rice', food_id: F.rice, quantity: 600, unit: 'g' },
      { text: '0.4 kg spinach', food_id: F.spinach, quantity: 0.4, unit: 'kg' },
      { text: '2 slices bread', food_id: F.bread, quantity: 2 },
      { text: 'spinach to garnish', food_id: F.spinach },
      { text: '50 g tahini', quantity: 50, unit: 'g' },
    ],
  });
  // R2: yield 2
  r2 = await recipe({
    title: 'Fixture Milk Porridge',
    servings: 2,
    ingredients: [
      { text: '500 ml milk', food_id: F.milk, quantity: 500, unit: 'ml' },
      { text: '100 g rice', food_id: F.rice, quantity: 100, unit: 'g' },
      { text: '1 slice bread', food_id: F.bread, quantity: 1, serving_id: SRV.breadSlice },
      { text: '3 bread rolls', food_id: F.bread, quantity: 3 },
    ],
  });
  P = await makePlan(SEED.accountA, SEED.profileA, 'Grocery week', {
    [D1]: [
      { meal_type: 'breakfast', items: [food(F.rice, 150), serving(F.bread, 4, SRV.breadSlice)] },
      { meal_type: 'lunch', items: [recipeItem(r1.id, r1.v1, 2)] },
      { meal_type: 'dinner', items: [food(F.milk, 250, 'ml')] },
    ],
    [D2]: [
      { meal_type: 'breakfast', items: [food(F.rice, 0.2, 'kg')] },
      { meal_type: 'lunch', items: [recipeItem(r2.id, r2.v1, 1)] },
      { meal_type: 'dinner', items: [food(F.milk, 0.5, 'l')] },
      { meal_type: 'snack', items: [food(F.milk, 103)] },
    ],
    [D3]: [{ meal_type: 'breakfast', items: [food(F.juice, 200, 'ml'), food(F.juice, 100), food(F.juice, 0.3, 'l')] }],
  });
}, 90_000);

afterAll(async () => {
  await pool.end();
});

describe('A-P, U, V: deterministic derivation (active-plan preview)', () => {
  let p: Awaited<ReturnType<typeof preview>>;

  it('15/W: a preview persists nothing and writes nothing', async () => {
    const [rows, world] = [await groceryRowCounts(), await worldState()];
    p = await preview(P.id);
    expect(p).toMatchObject({ preview_type: 'active_plan_preview', persisted: false, includes_unconfirmed: false, current_grocery_list: null });
    expect(await groceryRowCounts()).toEqual(rows);
    expect(await worldState()).toEqual(world);
  });

  it('A/B/C/I/J/M: direct Food + recipe ingredients of one Food aggregate in g (150 g + 0.2 kg + 600x2/4 + 100x1/2 = 700 g)', () => {
    expect(foodItems(p, F.rice)).toHaveLength(1);
    expect(one(p, F.rice, 'mass')).toMatchObject({ quantity: 700, quantity_exact: '700/1', unit: 'g', resolution_status: 'resolved', aggregation_status: 'aggregated', source_count: 4 });
    const contributions = one(p, F.rice, 'mass').sources.map((s) => [s.source_type, s.contribution_quantity]);
    expect(contributions).toEqual([
      ['planned_food', 150],
      ['recipe_ingredient', 300],
      ['planned_food', 200],
      ['recipe_ingredient', 50],
    ]);
  });

  it('D/E: ml + L aggregate; mass + volume merge only through the Food’s trusted density (milk 1000 ml x 1.03 + 103 g = 1133 g)', () => {
    expect(foodItems(p, F.milk)).toHaveLength(1);
    const milk = one(p, F.milk, 'mass');
    expect(milk).toMatchObject({ quantity: 1133, unit: 'g', resolution_status: 'resolved', source_count: 4 });
    const fromLitres = milk.sources.find((s) => s.source_unit === 'l') as Source & { conversion: { steps: Array<{ operation: string }> } };
    expect(fromLitres.contribution_quantity).toBe(515);
    expect(fromLitres.conversion.steps.map((s) => s.operation)).toEqual(['unit_to_base', 'base_to_unit', 'density']);
  });

  it('F/P: mass + volume WITHOUT density is never guessed — separate, explained components (juice)', () => {
    const juice = foodItems(p, F.juice);
    expect(juice.map((i) => [i.dimension, i.quantity, i.resolution_status, i.unresolved_reason])).toEqual([
      ['mass', 100, 'incompatible_units', 'mass_volume_density_unavailable'],
      ['volume', 500, 'incompatible_units', 'mass_volume_density_unavailable'],
    ]);
    expect(one(p, F.juice, 'volume').sources).toHaveLength(2);
  });

  it('G/K/25/26: FoodServing converts (4 slices = 120 g, 0.5 slice = 15 g); count + count aggregates; count never merges with mass', () => {
    const bread = foodItems(p, F.bread);
    expect(bread.map((i) => [i.dimension, i.quantity, i.unit, i.resolution_status])).toEqual([
      ['mass', 135, 'g', 'incompatible_units'],
      ['count', 2.5, 'count', 'incompatible_units'],
    ]);
    expect(one(p, F.bread, 'count').unresolved_reason).toBe('count_not_convertible_to_mass_or_volume');
    expect(one(p, F.bread, 'count').sources.map((s) => s.contribution_quantity)).toEqual([1, 1.5]);
    expect(one(p, F.bread, 'mass').sources.map((s) => s.contribution_quantity)).toEqual([120, 15]);
  });

  it('O/24: unresolved ingredients stay visible — no quantity, and no matched Food', () => {
    const noQuantity = p.items.find((i) => i.resolution_status === 'unresolved_quantity');
    expect(noQuantity).toMatchObject({ food: { food_id: F.spinach }, display_name: 'fixture5b_spinach', quantity: null, unresolved_reason: 'no_quantity', aggregation_status: 'not_aggregated' });
    const tahini = p.items.find((i) => i.resolution_status === 'unresolved_food');
    expect(tahini).toMatchObject({ food: null, display_name: '50 g tahini', unresolved_reason: 'ingredient_unmatched' });
    expect(tahini?.sources[0]).toMatchObject({ source_quantity: 50, source_unit: 'g', scaled_quantity: 25, ingredient_text: '50 g tahini', recipe_version_id: r1.v1 });
    expect(one(p, F.spinach, 'mass')).toMatchObject({ quantity: 200, resolution_status: 'resolved' }); // 0.4 kg x 2/4
    expect(p.summary).toMatchObject({ unresolved_item_count: 2, contributing_planned_item_count: 11, recipe_version_count: 2, recipe_ingredient_source_count: 9, direct_food_source_count: 9 });
  });

  it('U/V/28: every source is traceable to plan, day, meal, planned item, RecipeVersion and RecipeIngredient; plan dates are preserved', async () => {
    const all = p.items.flatMap((i) => i.sources);
    const planned = new Set(all.map((s) => s.planned_meal_item_id));
    expect(planned.size).toBe(11);
    for (const s of all) {
      expect(s).toMatchObject({ meal_plan_id: P.id });
      expect([D1, D2, D3]).toContain(s.plan_date);
      expect(typeof s.meal_type).toBe('string');
    }
    const ingredientRows = (await pool.query('select id, recipe_version_id from recipe_ingredient where recipe_version_id = any($1)', [[r1.v1, r2.v1]])).rows;
    const recipeSources = all.filter((s) => s.source_type === 'recipe_ingredient');
    expect(new Set(recipeSources.map((s) => s.recipe_ingredient_id))).toEqual(new Set(ingredientRows.map((r) => r.id)));
    const lunch = recipeSources.find((s) => s.planned_meal_item_id === at(P.ids, D1, 'lunch'));
    expect(lunch).toMatchObject({ plan_date: D1, meal_type: 'lunch', recipe_id: r1.id, recipe_version_id: r1.v1, planned_servings: 2, recipe_yield: 4, scale_factor_exact: '1/2' });
  });

  it('N/27: different Food ids with the same user-facing name are not merged', async () => {
    const other = await makePlan(SEED.accountA, SEED.profileA, 'Two rices', { [D1]: [{ meal_type: 'lunch', items: [food(F.rice, 100), food(RICE_OTHER, 100)] }] });
    const q = await preview(other.id);
    expect(q.items.map((i) => i.food?.food_id).sort()).toEqual([F.rice, RICE_OTHER].sort());
    expect(q.items.every((i) => i.quantity === 100)).toBe(true);
  });
});

describe('H, G4: legacy ambiguous units and unconfirmed ingredient matches', () => {
  it('H/24: an ambiguous household unit and a needs_confirmation ingredient remain unresolved', async () => {
    const res = await A().post(`/v1/profiles/${SEED.profileA}/recipes`, { title: 'Legacy', servings: 1, ingredients: [{ text: '100 g rice', food_id: F.rice, quantity: 100, unit: 'g' }] });
    const version = res.body.current_version.id;
    await pool.query(
      "insert into recipe_ingredient (recipe_version_id, food_id, raw_ingredient_text, quantity, unit, match_status, sort_order) values ($1, $2, '1 cup milk', 1, 'cup', 'matched', 2), ($1, $3, 'some spinach?', 30, 'g', 'needs_confirmation', 3)",
      [version, F.milk, F.spinach],
    );
    const plan = await makePlan(SEED.accountA, SEED.profileA, 'Legacy plan', { [D1]: [{ meal_type: 'dinner', items: [recipeItem(res.body.id, version, 1)] }] });
    const q = await preview(plan.id);
    expect(q.items.find((i) => i.resolution_status === 'ambiguous_unit')).toMatchObject({
      food: { food_id: F.milk },
      quantity: null,
      unresolved_reason: 'ambiguous_unit:cup_us|cup_metric|cup_us_legal',
    });
    expect(q.items.find((i) => i.resolution_status === 'unresolved_food')).toMatchObject({ food: null, display_name: 'some spinach?', unresolved_reason: 'ingredient_needs_confirmation' });
    expect(q.items.some((i) => i.food?.food_id === F.spinach)).toBe(false);
    // generation keeps them
    const gen = await generate(plan.id);
    expect(gen.status).toBe(201);
    expect(gen.body.items.map((i: Item) => i.resolution_status).sort()).toEqual(['ambiguous_unit', 'resolved', 'unresolved_food']);
  });
});

describe('1-16: generation, immutability, staleness and regeneration', () => {
  let draftId: string;

  it('1/2: a draft plan previews its unconfirmed intent but cannot be generated', async () => {
    const draft = await makePlan(SEED.accountA, SEED.profileA, 'Draft', { [D1]: [{ meal_type: 'lunch', items: [food(F.rice, 80)] }] }, { confirm: false });
    const q = await preview(draft.id);
    expect(q).toMatchObject({ preview_type: 'unconfirmed_plan_preview', includes_unconfirmed: true, persisted: false });
    expect(one(q, F.rice, 'mass').quantity).toBe(80);
    const res = await generate(draft.id);
    expect(res.status).toBe(409);
    await expect(asAccountSql(SEED.accountA, 'select generate_grocery_list($1, $2, $3)', [SEED.profileA, draft.id, rpcPayload(q)])).rejects.toMatchObject({ constraint: 'grocery_list_plan_active' });
  });

  it('3/4/16: active generation uses confirmed current items only; unconfirmed items are reported; client quantities are ignored', async () => {
    const mealId = (await A().get(`${plans(SEED.profileA)}/${P.id}`)).body.days[0].meals[0].id;
    const added = await A().post(`${plans(SEED.profileA)}/${P.id}/meals/${mealId}/items`, { items: [food(F.rice, 999)] });
    draftId = added.body.days[0].meals[0].items.find((i: { status: string }) => i.status === 'draft').id;
    const p = await preview(P.id);
    expect(one(p, F.rice, 'mass').quantity).toBe(700);
    expect(p.excluded_unconfirmed_sources).toEqual([expect.objectContaining({ planned_meal_item_id: draftId, reason: 'unconfirmed', status: 'draft' })]);

    const res = await generate(P.id, { items: [{ food_id: F.rice, quantity: 1 }], source_fingerprint: '0'.repeat(64), generation_number: 7 });
    expect(res.status).toBe(201);
    gen1 = res.body.id;
    expect(res.body).toMatchObject({ generation_number: 1, status: 'active', is_current_generation: true, is_stale: false, supersedes_grocery_list_id: null });
    expect(res.body.generated_source_fingerprint).toBe(p.source_fingerprint);
    expect(shape(res.body)).toEqual(shape(p)); // same engine, same result
    expect(res.body.excluded_unconfirmed_sources.map((e: { planned_meal_item_id: string }) => e.planned_meal_item_id)).toEqual([draftId]);
    expect(res.body.plan_context).toEqual({ status_at_generation: 'active', start_date: D1, end_date: D3, local_timezone: TZ });
    const row = (await pool.query('select generated_by_account_id from grocery_list where id = $1', [gen1])).rows[0];
    expect(row.generated_by_account_id).toBe(SEED.accountA);
    expect(res.body).not.toHaveProperty('generated_by_account_id');
  });

  it('T: a cancelled item neither contributes nor is reported', async () => {
    expect((await A().patch(`${plans(SEED.profileA)}/${P.id}/items/${draftId}`, { status: 'cancelled' })).status).toBe(200);
    const p = await preview(P.id);
    expect(p.excluded_unconfirmed_sources).toEqual([]);
    expect(p.items.flatMap((i) => i.sources).some((s) => s.planned_meal_item_id === draftId)).toBe(false);
    expect((await getList(gen1)).is_stale).toBe(false); // cancelling an unconfirmed item changes no source
  });

  it('generated lists are immutable in the database (no update, no delete, sealed after generation)', async () => {
    await expect(asAccountSql(SEED.accountA, 'update grocery_list_item set quantity = 1 where grocery_list_id = $1', [gen1])).rejects.toThrow(/permission denied/);
    await expect(asAccountSql(SEED.accountA, "update grocery_list set status = 'superseded' where id = $1", [gen1])).rejects.toThrow(/permission denied/);
    await expect(asAccountSql(SEED.accountA, 'delete from grocery_list where id = $1', [gen1])).rejects.toThrow(/permission denied/);
    await expect(
      asAccountSql(SEED.accountA, "insert into grocery_list_item (grocery_list_id, profile_id, position, food_id, display_name, resolution_status, aggregation_status, unresolved_reason, source_count) values ($1, $2, 99, $3, 'x', 'unresolved_quantity', 'not_aggregated', 'no_quantity', 1)", [gen1, SEED.profileA, F.rice]),
    ).rejects.toMatchObject({ constraint: 'grocery_list_sealed' });
    await expect(pool.query('update grocery_list_item set quantity = 1 where grocery_list_id = $1', [gen1])).rejects.toThrow();
  });

  let beforeSkip: Awaited<ReturnType<typeof getList>>;

  it('5/6/7/S: skipping a confirmed item leaves the list unchanged, marks it stale, and new previews exclude it', async () => {
    beforeSkip = await getList(gen1);
    const riceItem = at(P.ids, D1, 'breakfast', 0);
    expect((await A().post(`${plans(SEED.profileA)}/${P.id}/items/${riceItem}/skip`, { reason: 'eating out' })).status).toBe(201);
    const after = await getList(gen1);
    expect(after.items).toEqual(beforeSkip.items); // 6
    expect(after).toMatchObject({ is_stale: true, status: 'active', generated_source_fingerprint: beforeSkip.generated_source_fingerprint }); // 7
    expect(after.current_source_fingerprint).not.toBe(after.generated_source_fingerprint);
    const p = await preview(P.id);
    expect(one(p, F.rice, 'mass').quantity).toBe(550); // 5
    expect(p.excluded_skipped_sources.map((e) => e.planned_meal_item_id)).toEqual([riceItem]);
    expect(p.current_grocery_list).toMatchObject({ id: gen1, is_stale: true });
  });

  it('8/9/10: regeneration creates generation 2; generation 1 stays readable, superseded by it', async () => {
    const res = await generate(P.id);
    expect(res.status).toBe(201);
    gen2 = res.body.id;
    expect(res.body).toMatchObject({ generation_number: 2, status: 'active', supersedes_grocery_list_id: gen1, is_stale: false });
    expect(one(res.body, F.rice, 'mass').quantity).toBe(550);
    const old = await getList(gen1);
    expect(old).toMatchObject({ status: 'superseded', superseded_by_grocery_list_id: gen2, is_current_generation: false, is_stale: true });
    expect(old.items).toEqual(beforeSkip.items);
    const generations = await A().get(`${plans(SEED.profileA)}/${P.id}/grocery-lists`);
    expect(generations.body.data.map((l: { generation_number: number; status: string }) => [l.generation_number, l.status])).toEqual([
      [2, 'active'],
      [1, 'superseded'],
    ]);
    const active = await A().get(`${lists(SEED.profileA)}?meal_plan_id=${P.id}&status=active`);
    expect(active.body.data.map((l: { id: string }) => l.id)).toEqual([gen2]);
  });

  it('10/11: an uncommitted generation does not supersede anything; a failed or rolled-back one leaves the active list active', async () => {
    const p = await preview(P.id);
    const c = await txAs(SEED.accountA);
    try {
      const created = await c.query('select generate_grocery_list($1, $2, $3) as id', [SEED.profileA, P.id, rpcPayload(p)]);
      expect(created.rows[0].id).toBeTruthy();
      // other sessions still see generation 2 as active until commit
      expect((await pool.query('select status from grocery_list where id = $1', [gen2])).rows[0].status).toBe('active');
    } finally {
      await c.query('rollback');
      c.release();
    }
    // a payload whose source is the SKIPPED item fails as a whole
    const bad = rpcPayload(p);
    (bad.items[0] as { sources: Array<Record<string, unknown>> }).sources[0] = {
      ...(bad.items[0] as { sources: Array<Record<string, unknown>> }).sources[0],
      planned_meal_item_id: at(P.ids, D1, 'breakfast', 0),
    };
    await expect(asAccountSql(SEED.accountA, 'select generate_grocery_list($1, $2, $3)', [SEED.profileA, P.id, bad])).rejects.toMatchObject({ code: '23514' });
    expect((await pool.query('select status from grocery_list where id = $1', [gen2])).rows[0].status).toBe('active');
    expect((await pool.query('select count(*)::int as n from grocery_list where meal_plan_id = $1', [P.id])).rows[0].n).toBe(2);
    expect((await getList(gen2)).is_stale).toBe(false);
  });

  it('Q/R/12: a pending replacement does not count; once confirmed it counts once and the fingerprint changes', async () => {
    const original = at(P.ids, D2, 'breakfast');
    const replaced = await A().post(`${plans(SEED.profileA)}/${P.id}/items/${original}/replace`, food(F.rice, 250));
    expect(replaced.status).toBe(201);
    let p = await preview(P.id);
    expect(one(p, F.rice, 'mass').quantity).toBe(550);
    expect(p.excluded_unconfirmed_sources).toEqual([expect.objectContaining({ planned_meal_item_id: replaced.body.id, reason: 'pending_replacement_not_confirmed' })]);
    expect((await getList(gen2)).is_stale).toBe(false);

    expect((await A().post(`${plans(SEED.profileA)}/${P.id}/confirm`)).status).toBe(200);
    p = await preview(P.id);
    const rice = one(p, F.rice, 'mass');
    expect(rice.quantity).toBe(600); // 300 + 250 + 50
    const ids = rice.sources.map((s) => s.planned_meal_item_id);
    expect(ids).toContain(replaced.body.id);
    expect(ids).not.toContain(original);
    expect((await getList(gen2)).is_stale).toBe(true); // 12
    const res = await generate(P.id);
    gen3 = res.body.id;
    expect(res.body).toMatchObject({ generation_number: 3, supersedes_grocery_list_id: gen2 });
  });

  it('L/13/14: a Recipe edit (new current version) changes nothing for the planned exact RecipeVersion', async () => {
    const before = await getList(gen3);
    const edited = await A().patch(`/v1/profiles/${SEED.profileA}/recipes/${r1.id}`, {
      servings: 2,
      ingredients: [{ text: '1 kg rice', food_id: F.rice, quantity: 1, unit: 'kg' }],
      expected_current_version_id: r1.v1,
    });
    expect(edited.status).toBe(200);
    expect(edited.body.current_version.id).not.toBe(r1.v1);
    const after = await getList(gen3);
    expect(after).toMatchObject({ is_stale: false });
    expect(after.items).toEqual(before.items);
    const p = await preview(P.id);
    expect(shape(p)).toEqual(shape(after));
    expect(p.items.flatMap((i) => i.sources).filter((s) => s.source_type === 'recipe_ingredient' && s.recipe_id === r1.id).every((s) => s.recipe_version_id === r1.v1)).toBe(true);
  });

  it('23/G6: a Food reference change does not rewrite a persisted list; the live preview follows it', async () => {
    const before = await getList(gen3);
    await pool.query('update food_serving set canonical_quantity = 35 where id = $1', [SRV.breadSlice]);
    try {
      const after = await getList(gen3);
      expect(after.items).toEqual(before.items);
      expect(one(after, F.bread, 'mass').quantity).toBe(135);
      expect(one(await preview(P.id), F.bread, 'mass').quantity).toBe(157.5); // 4x35 + 0.5x35
      expect(after.is_stale).toBe(false); // reference data is not a plan source
    } finally {
      await pool.query('update food_serving set canonical_quantity = 30 where id = $1', [SRV.breadSlice]);
    }
  });

  it('29/30/X/Y: generation touches no MealLog/MealItem, links/skips, plan, Food or Recipe data', async () => {
    const world = await worldState();
    const res = await generate(P.id);
    expect(res.status).toBe(201);
    expect(await worldState()).toEqual(world);
  });
});

describe('17-19: plan states', () => {
  it('17/19: a completed plan rejects preview and generation; archived too; its lists stay readable', async () => {
    expect((await A().patch(`${plans(SEED.profileA)}/${P.id}`, { status: 'completed' })).status).toBe(200);
    expect((await generate(P.id)).status).toBe(409);
    expect((await A().get(`${plans(SEED.profileA)}/${P.id}/grocery-preview`)).status).toBe(409);
    expect((await getList(gen1)).status).toBe('superseded');
    expect((await A().patch(`${plans(SEED.profileA)}/${P.id}`, { status: 'archived' })).status).toBe(200);
    expect((await generate(P.id)).status).toBe(409);
    expect((await A().get(`${plans(SEED.profileA)}/${P.id}/grocery-preview`)).status).toBe(409);
    const list = await getList(gen3);
    expect(list.items.length).toBeGreaterThan(0);
    expect(list).toMatchObject({ plan_context: { status_at_generation: 'active' } });
  });

  it('18: a cancelled plan rejects preview and generation; its lists stay readable', async () => {
    const plan = await makePlan(SEED.accountA, SEED.profileA, 'To cancel', { [D1]: [{ meal_type: 'lunch', items: [food(F.rice, 50)] }] });
    const res = await generate(plan.id);
    expect(res.status).toBe(201);
    expect((await A().patch(`${plans(SEED.profileA)}/${plan.id}`, { status: 'cancelled' })).status).toBe(200);
    expect((await A().get(`${plans(SEED.profileA)}/${plan.id}/grocery-preview`)).status).toBe(409);
    expect((await generate(plan.id)).status).toBe(409);
    expect((await getList(res.body.id)).items).toHaveLength(1);
  });

  it('a plan with nothing confirmed and non-skipped cannot be generated', async () => {
    const plan = await makePlan(SEED.accountA, SEED.profileA, 'Skipped all', { [D1]: [{ meal_type: 'lunch', items: [food(F.rice, 50)] }] });
    expect((await A().post(`${plans(SEED.profileA)}/${plan.id}/items/${at(plan.ids, D1, 'lunch')}/skip`)).status).toBe(201);
    expect((await generate(plan.id)).status).toBe(400);
  });
});

describe('Z, 20-22, AA-AE: authorization and Profile isolation', () => {
  let childPlan: { id: string; ids: Ids };
  let childList: string;

  it('AB: full_management generates for the child', async () => {
    childPlan = await makePlan(SEED.accountFullManagement, SEED.profileChild, 'Child week', { [D1]: [{ meal_type: 'lunch', items: [food(F.rice, 80)] }] });
    const res = await generate(childPlan.id, {}, SEED.accountFullManagement, SEED.profileChild);
    expect(res.status).toBe(201);
    childList = res.body.id;
  });

  it('20/AA: view_only reads previews and lists but cannot generate (API and database)', async () => {
    const v = as(SEED.accountViewOnly);
    expect((await v.get(`${plans(SEED.profileChild)}/${childPlan.id}/grocery-preview`)).status).toBe(200);
    expect((await v.get(`${lists(SEED.profileChild)}/${childList}`)).status).toBe(200);
    expect((await v.get(lists(SEED.profileChild))).body.data).toHaveLength(1);
    expect((await generate(childPlan.id, {}, SEED.accountViewOnly, SEED.profileChild)).status).toBe(403);
    await expect(asAccountSql(SEED.accountViewOnly, 'insert into grocery_list (profile_id, meal_plan_id) values ($1, $2)', [SEED.profileChild, childPlan.id])).rejects.toMatchObject({ code: '42501' });
  });

  it('21/AC: pediatric_weight_management generates for the authorized child', async () => {
    const res = await generate(childPlan.id, {}, SEED.accountPediatric, SEED.profileChild);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ generation_number: 2, supersedes_grocery_list_id: childList });
    expect((await as(SEED.accountPediatric).get(`${lists(SEED.profileChild)}/${childList}`)).body.status).toBe('superseded');
    expect(JSON.stringify(res.body)).not.toMatch(/calorie|deficit|advice|score|recommend/i);
  });

  it('AD/AE: a revoked guardian and unrelated Accounts see nothing (API and database)', async () => {
    for (const account of [SEED.accountRevoked, SEED.accountUnrelated]) {
      expect((await as(account).get(`${lists(SEED.profileChild)}/${childList}`)).status).toBe(404);
      expect((await as(account).get(`${plans(SEED.profileChild)}/${childPlan.id}/grocery-preview`)).status).toBe(404);
      expect((await generate(childPlan.id, {}, account, SEED.profileChild)).status).toBe(404);
    }
    for (const account of [SEED.accountRevoked, SEED.accountUnrelated, SEED.accountB]) {
      const counts = await asAccountSql(account, 'select (select count(*)::int from grocery_list) as l, (select count(*)::int from grocery_list_item) as i, (select count(*)::int from grocery_list_item_source) as s');
      expect(counts.rows[0]).toEqual({ l: 0, i: 0, s: 0 });
    }
    expect((await as(SEED.accountB).get(`${lists(SEED.profileA)}/${gen1}`)).status).toBe(404);
  });

  it('Z/22: a list is only reachable through its own Profile; cross-Profile sources cannot be injected', async () => {
    // accountA also owns PROFILE_A2: the list is still not visible through it
    expect((await A().get(`${lists(PROFILE_A2)}/${gen1}`)).status).toBe(404);
    expect((await A().get(`${plans(PROFILE_A2)}/${P.id}/grocery-preview`)).status).toBe(404);
    const a2Plan = await makePlan(SEED.accountA, PROFILE_A2, 'A2 plan', { [D1]: [{ meal_type: 'lunch', items: [food(F.rice, 10)] }] });
    const other = await makePlan(SEED.accountA, SEED.profileA, 'A source plan', { [D1]: [{ meal_type: 'lunch', items: [food(F.rice, 10)] }] });
    const p = await preview(other.id);
    // Profile A2 list claiming Profile A plan sources
    await expect(asAccountSql(SEED.accountA, 'select generate_grocery_list($1, $2, $3)', [PROFILE_A2, a2Plan.id, rpcPayload(p)])).rejects.toMatchObject({ code: '23514' });
    // Profile A2 list for a Profile A plan
    await expect(asAccountSql(SEED.accountA, 'select generate_grocery_list($1, $2, $3)', [PROFILE_A2, other.id, rpcPayload(p)])).rejects.toMatchObject({ code: 'P0002' });
    // Profile A list for its own plan, sources from another Profile A plan
    const own = await makePlan(SEED.accountA, SEED.profileA, 'A target plan', { [D1]: [{ meal_type: 'lunch', items: [food(F.rice, 10)] }] });
    await expect(asAccountSql(SEED.accountA, 'select generate_grocery_list($1, $2, $3)', [SEED.profileA, own.id, rpcPayload(p)])).rejects.toMatchObject({ constraint: 'grocery_source_in_plan' });
    // a tampered structural fact is refused
    const tampered = rpcPayload(p);
    (tampered.items[0] as { sources: Array<Record<string, unknown>> }).sources[0] = { ...(tampered.items[0] as { sources: Array<Record<string, unknown>> }).sources[0], source_quantity: 5 };
    await expect(asAccountSql(SEED.accountA, 'select generate_grocery_list($1, $2, $3)', [SEED.profileA, other.id, tampered])).rejects.toMatchObject({ constraint: 'grocery_source_matches_plan' });
  });
});
