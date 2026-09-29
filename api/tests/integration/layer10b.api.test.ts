// Layer 10B integration tests — Progress & Adherence (three separate
// read-only analytics) against the real migration chain and RLS harness.
// TEST FIXTURES ONLY.
//
// Past daily target snapshots cannot be captured through the API (Layer
// 10A: only the current local date). The tests therefore write them as
// FIXTURES — rows exactly as a capture on that day would have stored them —
// with triggers bypassed; today's snapshot is captured through the API.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app';
import { logger } from '../../src/lib/logger';
import { localDateOf } from '../../src/domain/meals/meal.time';
import { PgHarnessProfileRepository } from '../helpers/pgHarnessProfileRepository';
import { PgHarnessScopedDbFactory } from '../helpers/pgHarnessScopedDb';
import { rebuildTestDatabase } from '../helpers/testDb';
import { seedScenario, SEED } from '../helpers/seed';
import { F, NUT, SRV, seedNutritionFixtures } from '../helpers/nutritionFixtures';
import { signTestToken, TEST_JWT_SECRET } from '../helpers/jwt';

let pool: Pool;
let app: ReturnType<typeof createApp>;

const as = (account: string) => ({
  get: (path: string, query: Record<string, string> = {}) => request(app).get(path).query(query).set('Authorization', `Bearer ${signTestToken(account)}`),
  post: (path: string, body: unknown = {}) => request(app).post(path).set('Authorization', `Bearer ${signTestToken(account)}`).send(body as object),
  patch: (path: string, body: unknown) => request(app).patch(path).set('Authorization', `Bearer ${signTestToken(account)}`).send(body as object),
});
const A = () => as(SEED.accountA);
const PROFILE_A2 = 'b0b0b0b0-0000-4000-8000-0000000000a2';
const UTC = 'UTC';
const day = (offset: number) => {
  const d = new Date(`${localDateOf(new Date(), UTC)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const TODAY = () => day(0);
const noon = (date: string) => `${date}T12:00:00.000Z`;
const food = (food_id: string, quantity: number, unit = 'g') => ({ type: 'food', food_id, quantity, unit });

const progress = (account: string, profile: string, from: string, to: string, timezone = UTC) => as(account).get(`/v1/profiles/${profile}/progress`, { from, to, timezone });

async function logMeal(account: string, profile: string, date: string, items: unknown[]) {
  const res = await as(account).post(`/v1/profiles/${profile}/meals`, { meal_type: 'lunch', logged_date: date, local_timezone: UTC, consumed_at: noon(date), items });
  expect(res.status).toBe(201);
  return { mealLogId: res.body.id as string, itemIds: res.body.items.map((i: { id: string }) => i.id) as string[] };
}

/** A daily target snapshot exactly as a capture on `date` would have stored it (test fixture). */
async function fixtureSnapshot(profile: string, date: string, fields: Record<string, { value: number; unit: string; source: 'user_target' | 'clinician_target' }>) {
  const payload = Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, { ...f, source_reference: randomUUID() }]));
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    await client.query(
      "insert into effective_target_snapshot (profile_id, snapshot_payload, resolver_version, resolved_at, snapshot_reason, local_date, local_timezone, unresolved_fields, created_at) values ($1, $2, 'phase2-canonical-target-keys-v2', $3, 'daily_tracking', $4, 'UTC', '[]', $3)",
      [profile, JSON.stringify(payload), noon(date), date],
    );
    await client.query('commit');
  } finally {
    client.release();
  }
}

const worldState = async () =>
  (
    await pool.query(`select
      (select md5(coalesce(string_agg(to_jsonb(s)::text, ',' order by id), '')) from effective_target_snapshot s) as snapshots,
      (select md5(coalesce(string_agg(to_jsonb(m)::text, ',' order by id), '')) from meal_item m) as meal_items,
      (select count(*)::int from meal_log) as meal_logs,
      (select md5(coalesce(string_agg(to_jsonb(p)::text, ',' order by id), '')) from meal_plan p) as plans,
      (select md5(coalesce(string_agg(to_jsonb(p)::text, ',' order by id), '')) from planned_meal_item p) as planned_items,
      (select md5(coalesce(string_agg(to_jsonb(l)::text, ',' order by id), '')) from planned_actual_link l) as links,
      (select md5(coalesce(string_agg(to_jsonb(s)::text, ',' order by id), '')) from planned_meal_item_skip s) as skips,
      (select md5(coalesce(string_agg(to_jsonb(g)::text, ',' order by id), '')) from goal g) as goals,
      (select md5(coalesce(string_agg(to_jsonb(w)::text, ',' order by id), '')) from weight_measurement w) as weights,
      (select count(*)::int from grocery_list) as grocery_lists,
      (select count(*)::int from audit_event) as audit_events,
      (select md5(coalesce(string_agg(to_jsonb(t)::text, ',' order by id), '')) from nutrition_target t) as targets`)
  ).rows[0];

type NutrientDay = { nutrient_key: string; comparison_status: string; percentage_of_target: number | null; percentage_of_target_at_least: number | null; percentage_status: string; target: { value: number; source: string }; actual: { value: number | null; coverage: string } | null };
type Day = { date: string; target_context: string; has_consumption: boolean; nutrients: NutrientDay[]; actual: { basis: string } };
const dayOf = (body: { nutrition_adherence: { daily: Day[] } }, date: string) => body.nutrition_adherence.daily.find((d) => d.date === date) as Day;
const nutrientOf = (d: Day, key: string) => d.nutrients.find((n) => n.nutrient_key === key) as NutrientDay;

let recipe: { id: string; v1: string };
let planId: string;
let milkUnplanned: string;
let riceOfReplacedLunch: string;

beforeAll(async () => {
  pool = await rebuildTestDatabase('recipebook_api_test_layer10b');
  await seedScenario(pool);
  await seedNutritionFixtures(pool);
  await pool.query("insert into profile (id, account_id, display_name, is_child) values ($1, $2, 'Profile A2', false)", [PROFILE_A2, SEED.accountA]);
  app = createApp({
    profileRepository: new PgHarnessProfileRepository(pool),
    scopedDbFactory: new PgHarnessScopedDbFactory(pool),
    jwtSecret: TEST_JWT_SECRET,
    logger,
  });

  // ---- nutrition (Profile A2): days today-5 .. today ----
  await logMeal(SEED.accountA, PROFILE_A2, day(-4), [food(F.rice, 100)]); // no snapshot
  await logMeal(SEED.accountA, PROFILE_A2, day(-3), [food(F.rice, 100)]); // 130 kcal, 2.7 g protein
  await logMeal(SEED.accountA, PROFILE_A2, day(-2), [food(F.spinach, 100), food(F.bread, 30)]); // energy/iron partial
  await logMeal(SEED.accountA, PROFILE_A2, day(-1), [food(F.noEnergy, 100)]); // energy unavailable, 10 g protein
  const r = await A().post(`/v1/profiles/${PROFILE_A2}/recipes`, { title: 'Fixture rice pot', servings: 2, ingredients: [{ text: '200 g rice', food_id: F.rice, quantity: 200, unit: 'g' }] });
  recipe = { id: r.body.id, v1: r.body.current_version.id };
  await logMeal(SEED.accountA, PROFILE_A2, day(-4), [{ type: 'recipe', recipe_id: recipe.id, recipe_version_id: recipe.v1, servings: 1 }]);
  await logMeal(SEED.accountA, PROFILE_A2, TODAY(), [food(F.rice, 100)]);

  await fixtureSnapshot(PROFILE_A2, day(-5), { energy: { value: 2000, unit: 'kcal', source: 'user_target' } });
  await fixtureSnapshot(PROFILE_A2, day(-3), { energy: { value: 200, unit: 'kcal', source: 'user_target' }, protein: { value: 2, unit: 'g', source: 'clinician_target' } });
  await fixtureSnapshot(PROFILE_A2, day(-2), { energy: { value: 100, unit: 'kcal', source: 'user_target' }, iron: { value: 2, unit: 'mg', source: 'user_target' } });
  await fixtureSnapshot(PROFILE_A2, day(-1), { energy: { value: 2000, unit: 'kcal', source: 'user_target' }, protein: { value: 8, unit: 'g', source: 'user_target' } });
  expect((await A().post(`/v1/profiles/${PROFILE_A2}/nutrition-targets`, { field_name: 'energy', value: 130, unit: 'kcal' })).status).toBe(201);
  expect((await A().post(`/v1/profiles/${PROFILE_A2}/clinician-targets`, { field_name: 'protein', value: 2.7, unit: 'g' })).status).toBe(201);
  expect((await A().post(`/v1/profiles/${PROFILE_A2}/target-snapshots`, { local_date: TODAY(), timezone: UTC })).status).toBe(201);

  // ---- measurements & goals (Profile A2), inserted out of order ----
  const weigh = async (date: string, hour: number, value_kg: number, corrects?: string) => {
    const res = await A().post(`/v1/profiles/${PROFILE_A2}/weight-measurements`, { measured_at: `${date}T${String(hour).padStart(2, '0')}:00:00.000Z`, value_kg, ...(corrects ? { corrects_measurement_id: corrects } : {}) });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };
  await weigh(day(-1), 7, 78.8);
  await weigh(day(-30), 7, 82);
  await weigh(day(-5), 7, 80);
  const m3 = await weigh(day(-3), 7, 79.5);
  await weigh(day(-3), 7, 79, m3); // correction
  const m4 = await weigh(day(-2), 7, 78.9);
  await weigh(day(-2), 7, 78.95, m4); // two corrections of one row -> conflicting branch
  await weigh(day(-2), 7, 78.85, m4);
  for (const body of [
    { goal_type: 'weight_loss', target_weight_kg: 75 },
    { goal_type: 'maintenance' },
    { goal_type: 'fiber_improvement' },
    { goal_type: 'weight_gain', target_weight_kg: 90, is_active: false },
  ]) {
    expect((await A().post(`/v1/profiles/${PROFILE_A2}/goals`, body)).status).toBe(201);
  }

  // ---- plan fulfillment (Profile A): plan days today-3 and today-2 (UTC) ----
  const plan = await A().post(`/v1/profiles/${SEED.profileA}/meal-plans`, { name: 'Past week', start_date: day(-3), end_date: day(-2), local_timezone: UTC });
  planId = plan.body.id;
  const addDay = async (date: string, meals: Array<{ meal_type: string; items: unknown[] }>) => {
    const d = await A().post(`/v1/profiles/${SEED.profileA}/meal-plans/${planId}/days`, { plan_date: date });
    const dayId = d.body.days.find((x: { plan_date: string }) => x.plan_date === date).id;
    for (const [position, m] of meals.entries()) expect((await A().post(`/v1/profiles/${SEED.profileA}/meal-plans/${planId}/days/${dayId}/meals`, { ...m, position })).status).toBe(201);
  };
  await addDay(day(-3), [
    { meal_type: 'breakfast', items: [food(F.rice, 150)] },
    { meal_type: 'lunch', items: [{ type: 'food', food_id: F.bread, quantity: 2, serving_id: SRV.breadSlice }] },
    { meal_type: 'dinner', items: [food(F.spinach, 50)] },
    { meal_type: 'snack', items: [food(F.rice, 100)] },
  ]);
  await addDay(day(-2), [
    { meal_type: 'breakfast', items: [food(F.rice, 200)] },
    { meal_type: 'lunch', items: [food(F.rice, 100)] },
    { meal_type: 'dinner', items: [food(F.milk, 250, 'ml')] },
  ]);
  expect((await A().post(`/v1/profiles/${SEED.profileA}/meal-plans/${planId}/confirm`)).status).toBe(200);
  const detail = (await A().get(`/v1/profiles/${SEED.profileA}/meal-plans/${planId}`)).body;
  const itemAt = (date: string, mealType: string) => detail.days.find((d: { plan_date: string }) => d.plan_date === date).meals.find((m: { meal_type: string }) => m.meal_type === mealType).items[0].id as string;
  const link = async (item: string, mealItem: string, relationship_type: string) =>
    expect((await A().post(`/v1/profiles/${SEED.profileA}/meal-plans/${planId}/items/${item}/actual-links`, { meal_item_id: mealItem, relationship_type })).status).toBe(201);

  const rice = await logMeal(SEED.accountA, SEED.profileA, day(-3), [food(F.rice, 150), food(F.spinach, 30), food(F.spinach, 80), food(F.milk, 200, 'ml')]);
  await link(itemAt(day(-3), 'breakfast'), rice.itemIds[0] as string, 'same_item');
  // L: corrected actual counted once
  expect((await A().post(`/v1/profiles/${SEED.profileA}/meals/${rice.mealLogId}/items/${rice.itemIds[0]}/correct`, { correction_reason: 're-weighed', item: food(F.rice, 150) })).status).toBe(201);
  await link(itemAt(day(-3), 'dinner'), rice.itemIds[1] as string, 'same_item'); // partial 30/50
  await link(itemAt(day(-3), 'snack'), rice.itemIds[2] as string, 'substitution');
  milkUnplanned = rice.itemIds[3] as string;
  expect((await A().post(`/v1/profiles/${SEED.profileA}/meal-plans/${planId}/items/${itemAt(day(-3), 'lunch')}/skip`)).status).toBe(201);
  const d2 = await logMeal(SEED.accountA, SEED.profileA, day(-2), [food(F.rice, 100), food(F.milk, 250)]);
  const lunch = itemAt(day(-2), 'lunch');
  riceOfReplacedLunch = d2.itemIds[0] as string;
  await link(lunch, d2.itemIds[0] as string, 'same_item');
  await link(itemAt(day(-2), 'dinner'), d2.itemIds[1] as string, 'same_item'); // ml plan vs g log -> not comparable
  // M: replace the linked lunch; the original becomes history
  expect((await A().post(`/v1/profiles/${SEED.profileA}/meal-plans/${planId}/items/${lunch}/replace`, food(F.rice, 120))).status).toBe(201);
  expect((await A().post(`/v1/profiles/${SEED.profileA}/meal-plans/${planId}/confirm`)).status).toBe(200);
}, 120_000);

afterAll(async () => {
  await pool.end();
});

describe('range validation (A, B, D, E)', () => {
  it('D: invalid ranges are rejected', async () => {
    expect((await progress(SEED.accountA, PROFILE_A2, day(-1), day(-2))).status).toBe(400);
    expect((await progress(SEED.accountA, PROFILE_A2, day(-100), day(-1))).status).toBe(400);
    expect((await progress(SEED.accountA, PROFILE_A2, day(-1), day(1))).status).toBe(400);
    expect((await progress(SEED.accountA, PROFILE_A2, day(-1), day(-1), 'GMT+4')).status).toBe(400);
    expect((await as(SEED.accountA).get(`/v1/profiles/${PROFILE_A2}/progress`, { from: day(-1) })).status).toBe(400);
  });

  it('A: an empty range returns zero counts and no scores', async () => {
    const res = await progress(SEED.accountB, SEED.profileB, day(-7), day(-1));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      range: { from: day(-7), to: day(-1), timezone: UTC, days_requested: 7 },
      combined_score: null,
      plan_fulfillment: { plan_count: 0, counts: { confirmed_planned_items: 0 }, unplanned_actual_item_count: 0, unplanned_actual_nutrition: null, fulfilled_item_rate: { value: null } },
      nutrition_adherence: { range_summary: { days_requested: 7, days_with_consumption: 0, days_with_historical_target: 0 }, nutrient_summary: [] },
      goal_progress: { measurements: [], first_active: null, latest_active: null, absolute_change_kg: null, goals: [] },
    });
    expect(res.body).not.toHaveProperty('score');
  });

  it('B/E: a one-day range; the caller’s time zone decides a measurement’s local date', async () => {
    const at = `${day(-3)}T22:00:00.000Z`; // day(-3) in UTC, day(-2) in Dubai (UTC+4)
    expect((await as(SEED.accountB).post(`/v1/profiles/${SEED.profileB}/weight-measurements`, { measured_at: at, value_kg: 70 })).status).toBe(201);
    const utc = await progress(SEED.accountB, SEED.profileB, day(-2), day(-2));
    const dubai = await progress(SEED.accountB, SEED.profileB, day(-2), day(-2), 'Asia/Dubai');
    expect(utc.body.range.days_requested).toBe(1);
    expect(utc.body.goal_progress.measurements).toHaveLength(0);
    expect(dubai.body.goal_progress.measurements).toEqual([expect.objectContaining({ value: 70, local_date: day(-2) })]);
  });
});

describe('plan fulfillment (C, F-M)', () => {
  it('C/F-M: Layer 8B states are counted per state; superseded intent excluded; corrected actual counted once; no fulfilled-rate', async () => {
    const res = await progress(SEED.accountA, SEED.profileA, day(-5), TODAY());
    expect(res.status).toBe(200);
    const pf = res.body.plan_fulfillment;
    expect(pf).toMatchObject({ source: 'layer_8b_derived_fulfillment', plan_count: 1 });
    expect(pf.counts).toMatchObject({
      confirmed_planned_items: 7, // the replaced lunch counts once (its replacement)
      fulfilled_exact: 1,
      partial: 1,
      fulfilled_with_substitution: 1,
      skipped: 1,
      unlinked: 2, // untouched breakfast + the replacement
      not_comparable: 1,
      above_planned_quantity: 0,
    });
    expect(pf.counts.by_state).toMatchObject({ quantity_not_comparable: 1, identity_changed_by_correction: 0 });
    expect(pf.fulfilled_item_rate).toMatchObject({ value: null, status: 'classification_not_approved' });
    // K: unplanned actuals are factual (active chain records only). The rice
    // linked only to the replaced (no longer current) lunch is unplanned, as in 8B.
    expect(pf.unplanned_actual_item_count).toBe(2);
    expect(pf.unplanned_actual_items).toEqual([
      { id: milkUnplanned, plan_local_date: day(-3) },
      { id: riceOfReplacedLunch, plan_local_date: day(-2) },
    ]);
    expect(pf.unplanned_actual_nutrition.summary.energy_kcal.value).toBe(258); // 200 ml milk + 100 g rice
    expect(pf.plans).toEqual([expect.objectContaining({ meal_plan_id: planId, counts: expect.objectContaining({ confirmed_planned_items: 7 }) })]);
    expect(JSON.stringify(pf)).not.toMatch(/fail|noncompliance|compliance|success/i);
  });

  it('a range covering only one plan day counts only that day', async () => {
    const res = await progress(SEED.accountA, SEED.profileA, day(-2), day(-2));
    expect(res.body.plan_fulfillment.counts).toMatchObject({ confirmed_planned_items: 3, unlinked: 2, not_comparable: 1 });
    expect(res.body.plan_fulfillment.unplanned_actual_item_count).toBe(1);
  });
});

describe('nutrition adherence (N-Z)', () => {
  let body: { nutrition_adherence: { daily: Day[]; range_summary: Record<string, number>; nutrient_summary: Array<Record<string, unknown>> } };

  it('N/O/S/T/U/Y: historical targets per day, percentages of target, >100% kept, mixed provenance', async () => {
    const res = await progress(SEED.accountA, PROFILE_A2, day(-5), TODAY());
    body = res.body;
    expect(body.nutrition_adherence.range_summary).toEqual({
      days_requested: 6,
      days_with_consumption: 5,
      days_with_historical_target: 5,
      days_without_historical_target: 1,
      days_with_consumption_and_target: 4,
      days_with_consumption_without_target: 1,
    });
    const d3 = dayOf(body, day(-3));
    expect(d3.target_context).toBe('daily_snapshot');
    expect(nutrientOf(d3, 'energy')).toMatchObject({ comparison_status: 'below_target', percentage_of_target: 65, percentage_status: 'exact', target: { value: 200, source: 'user_target' } });
    expect(nutrientOf(d3, 'protein')).toMatchObject({ comparison_status: 'above_target', percentage_of_target: 135, target: { value: 2, source: 'clinician_target' } });
    const today = dayOf(body, TODAY());
    expect(nutrientOf(today, 'energy')).toMatchObject({ comparison_status: 'at_target', percentage_of_target: 100 });
    expect(nutrientOf(today, 'protein')).toMatchObject({ percentage_of_target: 100, target: { source: 'clinician_target' } });
  });

  it('O: a day with consumption but no historical target is excluded — never today’s target', () => {
    const d4 = dayOf(body, day(-4));
    expect(d4).toMatchObject({ target_context: 'target_context_unavailable', has_consumption: true, nutrients: [] });
  });

  it('V/W/X: partial actuals are lower bounds only; unavailable actuals are not zero; untargeted nutrients are absent', () => {
    const d2 = dayOf(body, day(-2));
    expect(nutrientOf(d2, 'energy')).toMatchObject({ percentage_of_target: null, percentage_of_target_at_least: 79.5, percentage_status: 'lower_bound_partial_actual', actual: { coverage: 'partial' } });
    expect(nutrientOf(d2, 'iron')).toMatchObject({ percentage_of_target: null, percentage_of_target_at_least: 135, percentage_status: 'lower_bound_partial_actual' });
    const d1 = dayOf(body, day(-1));
    expect(nutrientOf(d1, 'energy')).toMatchObject({ comparison_status: 'actual_unavailable', percentage_of_target: null, percentage_status: 'actual_unavailable' });
    expect(nutrientOf(d1, 'protein')).toMatchObject({ percentage_of_target: 125 });
    expect(d1.nutrients.some((n) => n.nutrient_key === 'fat')).toBe(false);
    const d5 = dayOf(body, day(-5));
    expect(d5).toMatchObject({ target_context: 'daily_snapshot', has_consumption: false, actual: { basis: 'no_consumption_logged' } });
    expect(nutrientOf(d5, 'energy')).toMatchObject({ comparison_status: 'no_consumption_logged', percentage_of_target: null });
  });

  it('Z: range averages use comparable days only (no zero-filled, partial or unavailable days)', () => {
    const energy = body.nutrition_adherence.nutrient_summary.find((n) => n.nutrient_key === 'energy');
    expect(energy).toMatchObject({
      days_with_target: 5,
      days_comparable: 2, // day-3 (65%) and today (100%)
      days_partial_actual: 1,
      days_actual_unavailable: 1,
      days_no_consumption_logged: 1,
      average_actual: 130,
      average_target: 165,
      average_percentage_of_target: 82.5,
      averages_basis: 'comparable_days_only',
    });
    const protein = body.nutrition_adherence.nutrient_summary.find((n) => n.nutrient_key === 'protein');
    expect(protein).toMatchObject({ days_comparable: 3, average_percentage_of_target: 120 });
    expect(body.nutrition_adherence.nutrient_summary.map((n) => n.nutrient_key)).toEqual(['energy', 'iron', 'protein']);
  });

  it('P/Q/R: later target, Food reference and Recipe changes do not rewrite past analytics', async () => {
    const before = (await progress(SEED.accountA, PROFILE_A2, day(-5), TODAY())).body.nutrition_adherence;
    expect((await A().post(`/v1/profiles/${PROFILE_A2}/nutrition-targets`, { field_name: 'energy', value: 999, unit: 'kcal' })).status).toBe(201);
    await pool.query("update food_nutrient set amount_per_canonical_unit = 999 where food_id = $1 and nutrient_id = $2 and source = 'trusted_database'", [F.rice, NUT.energy]);
    expect((await A().patch(`/v1/profiles/${PROFILE_A2}/recipes/${recipe.id}`, { servings: 4, expected_current_version_id: recipe.v1 })).status).toBe(200);
    try {
      const after = (await progress(SEED.accountA, PROFILE_A2, day(-5), TODAY())).body.nutrition_adherence;
      expect(after).toEqual(before);
    } finally {
      await pool.query("update food_nutrient set amount_per_canonical_unit = 130 where food_id = $1 and nutrient_id = $2 and source = 'trusted_database'", [F.rice, NUT.energy]);
    }
  });
});

describe('goal progress (AA-AF)', () => {
  it('AA-AD: measurements ordered by measured_at; corrections counted once; conflicting branches excluded; latest and change', async () => {
    const gp = (await progress(SEED.accountA, PROFILE_A2, day(-5), TODAY())).body.goal_progress;
    expect(gp.measurements.map((m: { local_date: string; value: number; state: string }) => [m.local_date, m.value, m.state])).toEqual([
      [day(-5), 80, 'active'],
      [day(-3), 79.5, 'superseded_by_correction'],
      [day(-3), 79, 'active'],
      [day(-2), 78.9, 'superseded_by_correction'],
      [day(-2), 78.95, 'conflicting_correction'],
      [day(-2), 78.85, 'conflicting_correction'],
      [day(-1), 78.8, 'active'],
    ]);
    expect(gp).toMatchObject({
      measurement_type: 'body_weight',
      active_measurement_count: 3,
      excluded: { superseded_by_correction: 2, conflicting_correction: 2 },
      first_active: { value: 80, unit: 'kg' },
      latest_active: { value: 78.8, unit: 'kg' },
      absolute_change_kg: -1.2,
      interpretation: 'none',
    });
  });

  it('AE/AF: only weight goals with a target are compared; no percent-to-goal is invented', async () => {
    const gp = (await progress(SEED.accountA, PROFILE_A2, day(-5), TODAY())).body.goal_progress;
    expect(gp.goals.map((g: { goal_type: string; measurement_comparison: string }) => [g.goal_type, g.measurement_comparison])).toEqual([
      ['weight_loss', 'latest_measurement_vs_target'],
      ['maintenance', 'no_target_weight'],
      ['fiber_improvement', 'not_a_measurement_goal'],
    ]);
    expect(gp.goals[0]).toMatchObject({ target_weight_kg: 75, latest_measurement: { value: 78.8 }, difference_from_target_kg: 3.8, progress_percentage: null, progress_percentage_status: 'not_computable_goal_has_no_start_value' });
    expect(gp.inactive_goal_count).toBe(1);
    for (const g of gp.goals) expect(g.progress_percentage).toBeNull();
  });
});

describe('authorization, pediatric boundary and read-only guarantee (AG-AM)', () => {
  it('AK/AJ: full_management and view_only read the child’s progress', async () => {
    await as(SEED.accountFullManagement).post(`/v1/profiles/${SEED.profileChild}/goals`, { goal_type: 'weight_loss', target_weight_kg: 40 });
    await as(SEED.accountFullManagement).post(`/v1/profiles/${SEED.profileChild}/weight-measurements`, { measured_at: noon(day(-2)), value_kg: 42 });
    expect((await progress(SEED.accountFullManagement, SEED.profileChild, day(-5), TODAY())).status).toBe(200);
    expect((await progress(SEED.accountViewOnly, SEED.profileChild, day(-5), TODAY())).status).toBe(200);
  });

  it('AL/AG: pediatric_weight_management reads factual analytics only — no evaluative interpretation', async () => {
    const res = await progress(SEED.accountPediatric, SEED.profileChild, day(-5), TODAY());
    expect(res.status).toBe(200);
    expect(res.body.goal_progress.goals[0]).toMatchObject({ goal_type: 'weight_loss', difference_from_target_kg: 2, progress_percentage: null });
    expect(res.body.combined_score).toBeNull();
    expect(JSON.stringify(res.body)).not.toMatch(/success|failure|on_track|bmi|percentile|deficit|compliance|recommend|advice/i);
  });

  it('AH/AI: unrelated Accounts and a revoked guardian are blocked', async () => {
    for (const account of [SEED.accountUnrelated, SEED.accountRevoked]) expect((await progress(account, SEED.profileChild, day(-5), TODAY())).status).toBe(404);
    expect((await progress(SEED.accountB, SEED.profileA, day(-5), TODAY())).status).toBe(404);
  });

  it('AM: progress GET writes nothing', async () => {
    const before = await worldState();
    await progress(SEED.accountA, SEED.profileA, day(-5), TODAY());
    await progress(SEED.accountA, PROFILE_A2, day(-5), TODAY());
    await progress(SEED.accountPediatric, SEED.profileChild, day(-5), TODAY());
    expect(await worldState()).toEqual(before);
  });
});
