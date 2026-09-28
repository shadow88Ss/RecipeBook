// Layer 7B integration tests — Daily Nutrition Tracker against the real
// migration chain and RLS harness. Food data: tests/helpers/
// nutritionFixtures.ts; meals/recipes/targets are created through the API.
// TEST FIXTURES ONLY — not production food, recipe, target or consumption data.

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
  get: (path: string, query: Record<string, string> = {}) => request(app).get(path).query(query).set('Authorization', `Bearer ${signTestToken(account)}`),
  post: (path: string, body: unknown) => request(app).post(path).set('Authorization', `Bearer ${signTestToken(account)}`).send(body as object),
  patch: (path: string, body: unknown) => request(app).patch(path).set('Authorization', `Bearer ${signTestToken(account)}`).send(body as object),
});
const A = () => as(SEED.accountA);
const tracker = (account: string, profile: string, date: string, timezone = 'UTC') => as(account).get(`/v1/profiles/${profile}/daily-tracker`, { date, timezone });
const meals = (profile: string) => `/v1/profiles/${profile}/meals`;

// "Today" in UTC, and a time on it that is never in the future.
const TODAY = new Date().toISOString().slice(0, 10);
const TODAY_AT = `${TODAY}T00:00:01Z`;
// A past day (Dubai local).
const PAST = { logged_date: '2026-09-20', local_timezone: 'Asia/Dubai' };
const PAST_AT = '2026-09-20T07:30:00Z';

type Nutrient = { nutrient_key: string; value: number | null; coverage: string; is_zero: boolean };
const actualOf = (body: { actual: { nutrients: Nutrient[] } }, key: string) => {
  const n = body.actual.nutrients.find((x) => x.nutrient_key === key);
  if (!n) throw new Error(`no ${key}`);
  return n;
};
type Comparison = { nutrient_key: string; comparison_status: string; remaining: number | null; remaining_at_most: number | null; over_target_by: number | null; over_target_by_at_least: number | null; target: { value: number; source: string } };
const cmp = (body: { comparison: { nutrients: Comparison[] } }, key: string) => body.comparison.nutrients.find((c) => c.nutrient_key === key);

async function rowCounts() {
  const { rows } = await pool.query(`select
    (select count(*)::int from meal_log) as meal_log, (select count(*)::int from meal_item) as meal_item,
    (select count(*)::int from effective_target_snapshot) as snapshots, (select count(*)::int from goal) as goals,
    (select count(*)::int from nutrition_target) as nutrition_targets, (select count(*)::int from clinician_target) as clinician_targets,
    (select count(*)::int from food) as foods, (select count(*)::int from food_nutrient) as food_nutrients,
    (select count(*)::int from recipe) as recipes, (select count(*)::int from recipe_version) as recipe_versions,
    (select count(*)::int from audit_event) as audit_events,
    (select max(updated_at)::text from meal_log) as meal_log_updated, (select max(updated_at)::text from meal_item) as meal_item_updated`);
  return rows[0];
}

let recipeId: string;
let recipeV1: string;

beforeAll(async () => {
  pool = await rebuildTestDatabase('recipebook_api_test_layer7b');
  await seedScenario(pool);
  await seedNutritionFixtures(pool);
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

  // Today (UTC), profile A: breakfast rice 100 g, lunch 1 serving of the recipe, snack 1 slice of bread.
  const day = { logged_date: TODAY, local_timezone: 'UTC', consumed_at: TODAY_AT };
  for (const body of [
    { meal_type: 'breakfast', ...day, items: [{ type: 'food', food_id: F.rice, quantity: 100, unit: 'g' }] },
    { meal_type: 'lunch', ...day, items: [{ type: 'recipe', recipe_id: recipeId, recipe_version_id: recipeV1, servings: 1 }] },
    { meal_type: 'snack', ...day, notes: 'afternoon', items: [{ type: 'food', food_id: F.bread, quantity: 1, serving_id: SRV.breadSlice }] },
  ]) {
    const res = await A().post(meals(SEED.profileA), body);
    if (res.status !== 201) throw new Error(`fixture meal failed: ${JSON.stringify(res.body)}`);
  }
}, 60_000);

afterAll(async () => {
  await pool.end();
});

describe('A, O: empty day', () => {
  it('returns known zero consumption, no meals, and creates nothing', async () => {
    const before = await rowCounts();
    const res = await tracker(SEED.accountB, SEED.profileB, '2026-09-10');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ date: '2026-09-10', meal_count: 0, active_item_count: 0, meal_groups: [] });
    expect(res.body.actual.basis).toBe('no_consumption');
    expect(res.body.actual.summary.energy_kcal).toMatchObject({ value: 0, is_zero: true, coverage: 'complete' });
    expect(actualOf(res.body, 'iron')).toMatchObject({ value: 0, is_zero: true, coverage: 'complete' });
    expect(await rowCounts()).toEqual(before);
  });
});

describe('B-L: actual consumption for the current day', () => {
  it('B-F: groups food and recipe meals by type and aggregates their snapshots', async () => {
    const res = await tracker(SEED.accountA, SEED.profileA, TODAY);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ is_current_day: true, meal_count: 3, active_item_count: 3 });
    expect(res.body.actual.basis).toBe('recorded_snapshots');
    expect(res.body.meal_groups.map((g: { meal_type: string }) => g.meal_type)).toEqual(['breakfast', 'lunch', 'snack']); // dinner absent
    const lunch = res.body.meal_groups[1].meals[0];
    expect(lunch.items[0]).toMatchObject({ source_type: 'recipe', recipe: { recipe_version_id: recipeV1 }, amount: { servings: 1 } });
    expect(res.body.meal_groups[2].meals[0]).toMatchObject({ notes: 'afternoon', active_item_count: 1 });
    expect(res.body.meal_groups[0].meals[0].nutrition.summary.protein_g).toMatchObject({ value: 2.7, coverage: 'complete' });
  });

  it('G-L: energy/macros/fiber and micronutrients with complete, partial, unavailable and known zero', async () => {
    const res = await tracker(SEED.accountA, SEED.profileA, TODAY);
    const s = res.body.actual.summary;
    // I: protein known for every item: 2.7 + (5.4 + 2.9) / 4 + 2.7
    expect(s.protein_g).toMatchObject({ value: 7.475, coverage: 'complete' });
    // J: energy: rice 130 + recipe 65 (partial: spinach has none) + bread 79.5
    expect(s.energy_kcal).toMatchObject({ value: 274.5, coverage: 'partial' });
    expect(s.fiber_g).toMatchObject({ coverage: 'partial' });
    // H: micronutrients through the same aggregate
    expect(actualOf(res.body, 'iron')).toMatchObject({ value: 2.475, coverage: 'partial' });
    // K: calcium known nowhere
    expect(actualOf(res.body, 'calcium')).toMatchObject({ value: null, coverage: 'unavailable' });
    // L: vitamin D is a known zero where known (rice 0, recipe 0), unknown for bread -> partial zero
    expect(actualOf(res.body, 'vitamin_d')).toMatchObject({ value: 0, is_zero: true, coverage: 'partial' });
  });
});

describe('M-U: effective targets (current day)', () => {
  it('S: no targets -> actual only, nothing invented', async () => {
    const res = await tracker(SEED.accountA, SEED.profileA, TODAY);
    expect(res.body.target).toMatchObject({ status: 'current', fields: [], implemented_sources: ['clinician_target', 'user_target'] });
    expect(res.body.comparison).toMatchObject({ status: 'available', nutrients: [], unmapped_targets: [] });
  });

  it('M/O/P: current user target -> exact remaining with provenance', async () => {
    expect((await A().post(`/v1/profiles/${SEED.profileA}/nutrition-targets`, { field_name: 'protein', value: 20, unit: 'g' })).status).toBe(201);
    const res = await tracker(SEED.accountA, SEED.profileA, TODAY);
    expect(res.body.target.fields).toEqual([expect.objectContaining({ field_name: 'protein', value: 20, unit: 'g', source: 'user_target' })]);
    expect(cmp(res.body, 'protein')).toMatchObject({
      comparison_status: 'below_target',
      target: { value: 20, source: 'user_target' },
      remaining: 12.525,
      over_target_by: 0,
    });
  });

  it('N/Q: a clinician target overrides the user target; actual exactly at target', async () => {
    expect((await A().post(`/v1/profiles/${SEED.profileA}/clinician-targets`, { field_name: 'protein', value: 7.475, unit: 'g' })).status).toBe(201);
    const res = await tracker(SEED.accountA, SEED.profileA, TODAY);
    expect(cmp(res.body, 'protein')).toMatchObject({ comparison_status: 'at_target', target: { value: 7.475, source: 'clinician_target' }, remaining: 0, over_target_by: 0 });
  });

  it('R: actual above target -> remaining 0 and over_target_by (never negative)', async () => {
    await A().post(`/v1/profiles/${SEED.profileA}/clinician-targets`, { field_name: 'protein', value: 5, unit: 'g' });
    const res = await tracker(SEED.accountA, SEED.profileA, TODAY);
    expect(cmp(res.body, 'protein')).toMatchObject({ comparison_status: 'above_target', remaining: 0, over_target_by: 2.475 });
  });

  it('T/U + micronutrients: partial actual never yields an exact remaining; unit conversion and unsafe mappings handled', async () => {
    for (const body of [
      { field_name: 'energy_kcal', value: 2000, unit: 'kcal' }, // partial actual below target
      { field_name: 'fiber', value: 1, unit: 'g' }, // partial actual already above target
      { field_name: 'iron', value: 0.008, unit: 'g' }, // 8 mg, converted exactly
      { field_name: 'calcium', value: 1000, unit: 'mg' }, // actual unavailable
      { field_name: 'calories', value: 2000, unit: 'kcal' }, // Layer 7C alias -> energy (supersedes energy_kcal)
    ]) {
      expect((await A().post(`/v1/profiles/${SEED.profileA}/nutrition-targets`, body)).status).toBe(201);
    }
    // Layer 7C: an incompatible unit is now refused at write time
    expect((await A().post(`/v1/profiles/${SEED.profileA}/nutrition-targets`, { field_name: 'carbohydrate', value: 250, unit: 'kcal' })).status).toBe(400);
    const res = await tracker(SEED.accountA, SEED.profileA, TODAY);
    expect(cmp(res.body, 'energy')).toMatchObject({ comparison_status: 'undetermined', remaining: null, remaining_at_most: 1725.5, over_target_by: null });
    expect(cmp(res.body, 'fiber')).toMatchObject({ comparison_status: 'above_target', remaining: 0, over_target_by: null });
    expect(cmp(res.body, 'fiber')?.over_target_by_at_least).toBeGreaterThan(0);
    expect(cmp(res.body, 'iron')).toMatchObject({ comparison_status: 'undetermined', target: { value: 8 }, remaining: null, remaining_at_most: 5.525 });
    expect(cmp(res.body, 'calcium')).toMatchObject({ comparison_status: 'actual_unavailable', remaining: null, remaining_at_most: null, over_target_by: null });
    expect(res.body.comparison.unmapped_targets).toEqual([]);
    expect(res.body.target.fields.map((f: { field_name: string }) => f.field_name)).toEqual(['calcium', 'energy', 'fiber', 'iron', 'protein']);
    // provenance names the source of every resolved field; no account ids
    expect(res.body.target.fields.every((f: { source: string }) => ['user_target', 'clinician_target'].includes(f.source))).toBe(true);
  });
});

describe('Historical days: no target is guessed', () => {
  it('a past day returns historical_target_unavailable, not today\'s target', async () => {
    await A().post(meals(SEED.profileA), { meal_type: 'dinner', ...PAST, consumed_at: PAST_AT, items: [{ type: 'food', food_id: F.rice, quantity: 150, unit: 'g' }] });
    const res = await tracker(SEED.accountA, SEED.profileA, PAST.logged_date);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ is_current_day: false, meal_count: 1 });
    expect(res.body.target).toMatchObject({ status: 'historical_target_unavailable', fields: [] });
    expect(res.body.comparison).toMatchObject({ status: 'historical_target_unavailable', nutrients: [], unmapped_targets: [] });
    expect(res.body.actual.summary.protein_g).toMatchObject({ value: 4.05, coverage: 'complete' });
  });

  it('a future local date is rejected; date and timezone are required', async () => {
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    expect((await tracker(SEED.accountA, SEED.profileA, tomorrow)).status).toBe(400);
    expect((await A().get(`/v1/profiles/${SEED.profileA}/daily-tracker`, { timezone: 'UTC' })).status).toBe(400);
    expect((await A().get(`/v1/profiles/${SEED.profileA}/daily-tracker`, { date: TODAY })).status).toBe(400);
    expect((await tracker(SEED.accountA, SEED.profileA, TODAY, '+04:00')).status).toBe(400);
    expect((await tracker(SEED.accountA, SEED.profileA, '2026-02-30')).status).toBe(400);
  });
});

describe('V/W: corrections', () => {
  it('counts only the active correction — the original stops contributing, no double count', async () => {
    const day = { logged_date: '2026-09-15', local_timezone: 'Europe/London' };
    const meal = await as(SEED.accountB).post(meals(SEED.profileB), { meal_type: 'lunch', ...day, consumed_at: '2026-09-15T12:00:00Z', items: [{ type: 'food', food_id: F.rice, quantity: 150, unit: 'g' }] });
    const before = await tracker(SEED.accountB, SEED.profileB, day.logged_date);
    expect(before.body.actual.summary.protein_g.value).toBe(4.05);

    const fixed = await as(SEED.accountB).post(`${meals(SEED.profileB)}/${meal.body.id}/items/${meal.body.items[0].id}/correct`, {
      correction_reason: 'weighed again',
      item: { type: 'food', food_id: F.rice, quantity: 120, unit: 'g' },
    });
    expect(fixed.status).toBe(201);
    const after = await tracker(SEED.accountB, SEED.profileB, day.logged_date);
    expect(after.body).toMatchObject({ active_item_count: 1 });
    expect(after.body.actual.summary.protein_g).toMatchObject({ value: 3.24, coverage: 'complete' });
    const items = after.body.meal_groups[0].meals[0].items;
    expect(items.map((i: { id: string }) => i.id)).toEqual([fixed.body.id]); // superseded original not shown as active
  });
});

describe('X/Y: historical integrity', () => {
  it('X: a Food reference-data change does not change a historical day', async () => {
    const day = { logged_date: '2026-09-14', local_timezone: 'Europe/London' };
    await as(SEED.accountB).post(meals(SEED.profileB), { meal_type: 'dinner', ...day, consumed_at: '2026-09-14T18:00:00Z', items: [{ type: 'food', food_id: F.noEnergy, quantity: 200, unit: 'g' }] });
    const before = await tracker(SEED.accountB, SEED.profileB, day.logged_date);
    expect(before.body.actual.summary.protein_g.value).toBe(20);
    await pool.query("update food_nutrient set amount_per_canonical_unit = 12 where food_id = $1 and nutrient_id = $2 and source = 'trusted_database'", [F.noEnergy, NUT.protein]);
    try {
      const after = await tracker(SEED.accountB, SEED.profileB, day.logged_date);
      expect(after.body).toEqual(before.body);
    } finally {
      await pool.query("update food_nutrient set amount_per_canonical_unit = 10 where food_id = $1 and nutrient_id = $2 and source = 'trusted_database'", [F.noEnergy, NUT.protein]);
    }
  });

  it('Y: editing the recipe does not change a day on which version 1 was consumed', async () => {
    const before = await tracker(SEED.accountA, SEED.profileA, TODAY);
    const edited = await A().patch(`/v1/profiles/${SEED.profileA}/recipes/${recipeId}`, { servings: 1, ingredients: [{ text: '500 g rice', food_id: F.rice, quantity: 500, unit: 'g' }] });
    expect(edited.body.current_version.version_number).toBe(2);
    const after = await tracker(SEED.accountA, SEED.profileA, TODAY);
    expect(after.body.actual).toEqual(before.body.actual);
    expect(after.body.meal_groups).toEqual(before.body.meal_groups);
    expect(after.body.meal_groups[1].meals[0].items[0].recipe.recipe_version_id).toBe(recipeV1);
  });
});

describe('Z/AA: local calendar day', () => {
  it('the same instant belongs to different local days in different zones; the tracker follows logged_date, not UTC', async () => {
    const instant = '2026-09-11T22:30:00Z'; // 02:30 on the 12th in Dubai, 18:30 on the 11th in New York
    const b = as(SEED.accountB);
    const dubai = await b.post(meals(SEED.profileB), { meal_type: 'snack', logged_date: '2026-09-12', local_timezone: 'Asia/Dubai', consumed_at: instant, items: [{ type: 'food', food_id: F.rice, quantity: 100, unit: 'g' }] });
    const newYork = await b.post(meals(SEED.profileB), { meal_type: 'dinner', logged_date: '2026-09-11', local_timezone: 'America/New_York', consumed_at: instant, items: [{ type: 'food', food_id: F.bread, quantity: 1, serving_id: SRV.breadSlice }] });
    expect([dubai.status, newYork.status]).toEqual([201, 201]);

    const eleventh = await tracker(SEED.accountB, SEED.profileB, '2026-09-11');
    const twelfth = await tracker(SEED.accountB, SEED.profileB, '2026-09-12');
    expect(eleventh.body.meal_groups.flatMap((g: { meals: Array<{ id: string }> }) => g.meals.map((m) => m.id))).toEqual([newYork.body.id]);
    expect(twelfth.body.meal_groups.flatMap((g: { meals: Array<{ id: string }> }) => g.meals.map((m) => m.id))).toEqual([dubai.body.id]);
    expect(twelfth.body.meal_groups[0].meals[0]).toMatchObject({ local_timezone: 'Asia/Dubai', logged_date: '2026-09-12' });
  });
});

describe('AB-AF: authorization (read-only, existing RLS)', () => {
  let childDate: string;

  beforeAll(async () => {
    childDate = TODAY;
    const res = await as(SEED.accountFullManagement).post(meals(SEED.profileChild), {
      meal_type: 'lunch',
      logged_date: childDate,
      local_timezone: 'UTC',
      consumed_at: TODAY_AT,
      items: [{ type: 'food', food_id: F.rice, quantity: 80, unit: 'g' }],
    });
    if (res.status !== 201) throw new Error('child fixture failed');
  });

  it('AE/AD/AF: full_management, view_only and pediatric_weight_management can read the child\'s day', async () => {
    for (const account of [SEED.accountFullManagement, SEED.accountViewOnly, SEED.accountPediatric]) {
      const res = await tracker(account, SEED.profileChild, childDate);
      expect(res.status).toBe(200);
      expect(res.body.actual.summary.protein_g.value).toBe(2.16);
      expect(res.body).not.toHaveProperty('goal');
    }
  });

  it('AC/AB: a revoked guardian and an unrelated Account are refused (404)', async () => {
    expect((await tracker(SEED.accountRevoked, SEED.profileChild, childDate)).status).toBe(404);
    expect((await tracker(SEED.accountUnrelated, SEED.profileA, TODAY)).status).toBe(404);
    expect((await tracker(SEED.accountB, SEED.profileA, TODAY)).status).toBe(404);
  });

  it('the route is GET only', async () => {
    const res = await request(app).post(`/v1/profiles/${SEED.profileA}/daily-tracker`).set('Authorization', `Bearer ${signTestToken(SEED.accountA)}`).send({});
    expect(res.status).toBe(404);
  });
});

describe('AG/AH: read-only and no internals', () => {
  it('AG: GET writes nothing to any table', async () => {
    const before = await rowCounts();
    await tracker(SEED.accountA, SEED.profileA, TODAY);
    await tracker(SEED.accountA, SEED.profileA, PAST.logged_date);
    await tracker(SEED.accountPediatric, SEED.profileChild, TODAY);
    await tracker(SEED.accountB, SEED.profileB, '2026-09-01');
    expect(await rowCounts()).toEqual(before);
  });

  it('AH: no account ids, RLS scope or audit data in the response', async () => {
    const res = await tracker(SEED.accountA, SEED.profileA, TODAY);
    const text = JSON.stringify(res.body);
    for (const account of Object.entries(SEED).filter(([k]) => k.startsWith('account')).map(([, v]) => v)) {
      expect(text).not.toContain(account);
    }
    expect(text).not.toMatch(/account_id|access_scope|audit|provided_by|status_changed_by_account/);
  });
});
