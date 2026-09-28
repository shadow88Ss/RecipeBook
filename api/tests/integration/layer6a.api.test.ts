// Layer 6A integration tests — Recipe Book core against the real migration
// chain and RLS harness. Food data: tests/helpers/nutritionFixtures.ts (TEST
// FIXTURES ONLY — not production food or recipe data).

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

let pool: Pool;
let app: ReturnType<typeof createApp>;

const as = (account: string) => ({
  get: (path: string) => request(app).get(path).set('Authorization', `Bearer ${signTestToken(account)}`),
  post: (path: string, body: unknown) => request(app).post(path).set('Authorization', `Bearer ${signTestToken(account)}`).send(body as object),
  patch: (path: string, body: unknown) => request(app).patch(path).set('Authorization', `Bearer ${signTestToken(account)}`).send(body as object),
});
const A = () => as(SEED.accountA);
const recipesOf = (profile: string) => `/v1/profiles/${profile}/recipes`;

type Nutrient = { nutrient_key: string; value: number | null; coverage: string; is_zero: boolean; missing: Array<{ index: number; status: string }> };
const nutrient = (aggregate: { nutrients: Nutrient[] }, key: string): Nutrient => {
  const found = aggregate.nutrients.find((n) => n.nutrient_key === key);
  if (!found) throw new Error(`no ${key}`);
  return found;
};

/** Runs SQL as an authenticated Account under RLS (what PostgREST does). */
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

async function referenceSnapshot() {
  const { rows } = await pool.query(`
    select (select count(*)::int from food) as foods,
           (select count(*)::int from food_serving) as servings,
           (select count(*)::int from food_nutrient) as nutrients,
           (select md5(string_agg(id::text || amount_per_canonical_unit::text || source::text, ',' order by id)) from food_nutrient) as nutrient_hash,
           (select md5(string_agg(id::text || canonical_quantity::text, ',' order by id)) from food_serving) as serving_hash`);
  return rows[0];
}

// Stir-fry-like fixture recipe: rice 200 g, 2 x bread slice (30 g), spinach 100 g.
const bowl = {
  title: 'Fixture Rice Bowl',
  description: 'Test-only recipe.',
  servings: 4,
  ingredients: [
    { text: '200 g cooked rice', food_id: F.rice, quantity: 200, unit: 'g' },
    { text: '2 slices bread', food_id: F.bread, quantity: 2, serving_id: SRV.breadSlice },
    { text: '100 g spinach', food_id: F.spinach, quantity: 100, unit: 'g' },
  ],
  instructions: ['Warm the rice.', 'Toast the bread.', 'Wilt the spinach and serve.'],
};

let bowlId: string;
let v1Id: string;
let v1Nutrition: unknown;
let v1Rows: unknown;

beforeAll(async () => {
  pool = await rebuildTestDatabase('recipebook_api_test_layer6a');
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

describe('A-D, X: create a recipe', () => {
  it('A/B/C: creates a Recipe with version 1, ordered ingredients and instructions', async () => {
    const before = await referenceSnapshot();
    const res = await A().post(recipesOf(SEED.profileA), bowl);
    expect(res.status).toBe(201);
    bowlId = res.body.id;
    v1Id = res.body.current_version.id;
    expect(res.body).toMatchObject({ profile_id: SEED.profileA, visibility: 'private', title: bowl.title, version_count: 1 });
    expect(res.body.current_version).toMatchObject({ version_number: 1, is_current: true, servings: 4, description: 'Test-only recipe.', provenance: { origin: 'manual' } });
    expect(res.body.current_version.ingredients).toEqual([
      expect.objectContaining({ position: 1, text: '200 g cooked rice', food_id: F.rice, serving_id: null, quantity: 200, unit: 'g', match_status: 'matched', match_confidence: null }),
      expect.objectContaining({ position: 2, food_id: F.bread, serving_id: SRV.breadSlice, quantity: 2, unit: null, match_status: 'matched' }),
      expect.objectContaining({ position: 3, food_id: F.spinach, quantity: 100, unit: 'g' }),
    ]);
    expect(res.body.current_version.instructions.map((s: { step_number: number; text: string }) => [s.step_number, s.text])).toEqual([
      [1, 'Warm the rice.'],
      [2, 'Toast the bread.'],
      [3, 'Wilt the spinach and serve.'],
    ]);

    // D/X: recipe input created no global reference data and changed none.
    expect(await referenceSnapshot()).toEqual(before);
    const db = await pool.query('select current_version_id, created_by_account_id, created_by_profile_id from recipe where id = $1', [bowlId]);
    expect(db.rows[0]).toEqual({ current_version_id: v1Id, created_by_account_id: SEED.accountA, created_by_profile_id: SEED.profileA });
  });

  it('D: a recipe-specific gram quantity does not create a FoodServing', async () => {
    const res = await A().post(recipesOf(SEED.profileA), { title: 'Fixture Chicken-ish', servings: 1, ingredients: [{ text: '125 g rice', food_id: F.rice, quantity: 125, unit: 'g' }] });
    expect(res.status).toBe(201);
    const { rows } = await pool.query('select count(*)::int as n from food_serving where canonical_quantity = 125 or food_id = $1', [F.rice]);
    expect(rows[0].n).toBe(0);
  });

  it('keeps an unresolved ingredient as text without inventing a Food match', async () => {
    const res = await A().post(recipesOf(SEED.profileA), {
      title: 'Fixture Salted Rice',
      servings: 2,
      ingredients: [
        { text: '200 g rice', food_id: F.rice, quantity: 200, unit: 'g' },
        { text: 'a pinch of flaky salt' },
        { text: '2 eggs', quantity: 2 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.current_version.ingredients.slice(1)).toEqual([
      expect.objectContaining({ text: 'a pinch of flaky salt', food_id: null, quantity: null, unit: null, match_status: 'unmatched' }),
      expect.objectContaining({ text: '2 eggs', food_id: null, quantity: 2, unit: null, match_status: 'unmatched' }),
    ]);
  });
});

describe('E-J: deterministic recipe nutrition', () => {
  it('E/F/G: whole-recipe and per-serving values come from the engine, summary from Layer 5C', async () => {
    const first = await A().get(`${recipesOf(SEED.profileA)}/${bowlId}/nutrition`);
    const second = await A().get(`${recipesOf(SEED.profileA)}/${bowlId}/nutrition`);
    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);
    v1Nutrition = first.body;
    const body = first.body;
    expect(body).toMatchObject({ recipe_id: bowlId, recipe_version_id: v1Id, version_number: 1, is_current: true, servings: 4, ingredient_count: 3, calculated_ingredient_count: 3, per_serving_status: 'available' });
    expect(body.calculation_version).toBe('nutrition-calculation-5b.1');

    // protein: 5.4 (rice) + 5.4 (60 g bread) + 2.9 (spinach) = 13.7, known for all three
    expect(nutrient(body.whole_recipe, 'protein')).toMatchObject({ value: 13.7, coverage: 'complete' });
    expect(nutrient(body.per_serving, 'protein')).toMatchObject({ value: 3.425, coverage: 'complete' });
    // G: summary is the projection of the same aggregate
    expect(body.whole_recipe.summary.protein_g).toMatchObject({ value: 13.7, coverage: 'complete', status: null });
    expect(body.per_serving.summary.protein_g).toMatchObject({ value: 3.425, coverage: 'complete' });
    // energy: rice 260 + bread 159; spinach has no energy value -> partial lower bound
    expect(body.whole_recipe.summary.energy_kcal).toMatchObject({ value: 419, coverage: 'partial', status: 'partial', resolved_item_count: 2, item_count: 3 });
    expect(body.per_serving.summary.energy_kcal).toMatchObject({ value: 104.75, coverage: 'partial' });
    for (const field of ['energy_kcal', 'protein_g', 'carbohydrate_g', 'fat_g', 'fiber_g']) {
      expect(body.whole_recipe.summary).toHaveProperty(field);
      expect(body.per_serving.summary).toHaveProperty(field);
    }
    // The serving-based ingredient was normalized through Layer 5A: 2 x 30 g
    expect(body.ingredients[1].calculation.normalized_quantity).toMatchObject({ quantity: 60, unit: 'g' });
  });

  it('H: micronutrients aggregate through the same generic result (complete / partial / unavailable)', async () => {
    const body = v1Nutrition as { whole_recipe: { nutrients: Nutrient[] }; per_serving: { nutrients: Nutrient[] } };
    // iron: rice 2.4 + spinach 2.7, bread unknown -> partial 5.1
    expect(nutrient(body.whole_recipe, 'iron')).toMatchObject({ value: 5.1, coverage: 'partial', missing: [{ index: 1, status: 'no_data' }] });
    expect(nutrient(body.per_serving, 'iron')).toMatchObject({ value: 1.275, coverage: 'partial' });
    expect(nutrient(body.whole_recipe, 'calcium')).toMatchObject({ value: null, coverage: 'unavailable' });
    expect(nutrient(body.whole_recipe, 'iron')).toHaveProperty('nutrient_role', 'micronutrient');
  });

  it('I: an unresolved ingredient makes totals partial — it never disappears', async () => {
    const list = await A().get(recipesOf(SEED.profileA)).query({ q: 'salted' });
    const id = list.body.data[0].id;
    const res = await A().get(`${recipesOf(SEED.profileA)}/${id}/nutrition`);
    expect(res.body).toMatchObject({ ingredient_count: 3, calculated_ingredient_count: 1 });
    expect(res.body.ingredients.map((i: { nutrition_status: string }) => i.nutrition_status)).toEqual(['calculated', 'food_unmatched', 'food_unmatched']);
    expect(nutrient(res.body.whole_recipe, 'protein')).toMatchObject({
      value: 5.4,
      coverage: 'partial',
      missing: [
        { index: 1, status: 'item_unresolved' },
        { index: 2, status: 'item_unresolved' },
      ],
    });
    expect(res.body.whole_recipe.summary.protein_g).toMatchObject({ coverage: 'partial' });
  });

  it('F: only unresolved ingredients -> unavailable (null), never 0', async () => {
    const created = await A().post(recipesOf(SEED.profileA), { title: 'Fixture Mystery', servings: 1, ingredients: [{ text: 'something' }] });
    const res = await A().get(`${recipesOf(SEED.profileA)}/${created.body.id}/nutrition`);
    expect(res.body.whole_recipe.coverage_summary.complete).toBe(0);
    expect(res.body.whole_recipe.summary.energy_kcal).toMatchObject({ value: null, coverage: 'unavailable' });
    expect(res.body.per_serving.summary.protein_g).toMatchObject({ value: null, coverage: 'unavailable' });
  });

  it('J: a known zero stays zero, whole and per serving', async () => {
    const created = await A().post(recipesOf(SEED.profileA), { title: 'Fixture Plain Rice', servings: 2, ingredients: [{ text: '300 g rice', food_id: F.rice, quantity: 300, unit: 'g' }] });
    expect(created.body.nutrition.whole_recipe.summary.energy_kcal).toMatchObject({ value: 390, coverage: 'complete' });
    const res = await A().get(`${recipesOf(SEED.profileA)}/${created.body.id}/nutrition`);
    expect(nutrient(res.body.whole_recipe, 'vitamin_d')).toMatchObject({ value: 0, is_zero: true, coverage: 'complete' });
    expect(nutrient(res.body.per_serving, 'vitamin_d')).toMatchObject({ value: 0, is_zero: true, coverage: 'complete' });
  });

  it('the detail DTO carries summary, generic nutrients and completeness', async () => {
    const res = await A().get(`${recipesOf(SEED.profileA)}/${bowlId}`);
    expect(res.status).toBe(200);
    expect(res.body.nutrition).toMatchObject({ servings: 4, per_serving_status: 'available', ingredient_count: 3 });
    expect(res.body.nutrition.whole_recipe.coverage_summary).toEqual(expect.objectContaining({ complete: expect.any(Number), partial: expect.any(Number), unavailable: expect.any(Number) }));
    expect(res.body.nutrition).not.toHaveProperty('ingredients');
    expect(res.body).not.toHaveProperty('created_by_account_id');
  });
});

describe('K-N: versioning and historical reproducibility', () => {
  it('K/N: PATCH creates version 2 and moves current_version_id', async () => {
    v1Rows = (
      await pool.query(
        `select to_jsonb(rv) as version,
                (select jsonb_agg(to_jsonb(ri) order by ri.sort_order) from recipe_ingredient ri where ri.recipe_version_id = rv.id) as ingredients,
                (select jsonb_agg(to_jsonb(s) order by s.step_number) from recipe_instruction s where s.recipe_version_id = rv.id) as instructions
           from recipe_version rv where rv.id = $1`,
        [v1Id],
      )
    ).rows[0];

    const res = await A().patch(`${recipesOf(SEED.profileA)}/${bowlId}`, {
      title: 'Fixture Rice Bowl (big)',
      servings: 2,
      ingredients: [...bowl.ingredients, { text: '100 g spinach more', food_id: F.spinach, quantity: 100, unit: 'g' }],
      expected_current_version_id: v1Id,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: bowlId, title: 'Fixture Rice Bowl (big)', version_count: 2 });
    expect(res.body.current_version).toMatchObject({ version_number: 2, is_current: true, servings: 2 });
    expect(res.body.current_version.id).not.toBe(v1Id);
    // instructions were not in the patch: carried over into the new version
    expect(res.body.current_version.instructions).toHaveLength(3);
    expect(res.body.current_version.instructions[0].id).not.toBe((v1Rows as { instructions: Array<{ id: string }> }).instructions[0]?.id);

    const db = await pool.query('select current_version_id, canonical_title from recipe where id = $1', [bowlId]);
    expect(db.rows[0]).toEqual({ current_version_id: res.body.current_version.id, canonical_title: 'Fixture Rice Bowl (big)' });
    expect(res.body.nutrition.whole_recipe.summary.protein_g).toMatchObject({ value: 16.6, coverage: 'complete' });
    expect(res.body.nutrition.per_serving.summary.protein_g).toMatchObject({ value: 8.3 });
  });

  it('L: version 1 and its rows are byte-for-byte unchanged', async () => {
    const after = (
      await pool.query(
        `select to_jsonb(rv) as version,
                (select jsonb_agg(to_jsonb(ri) order by ri.sort_order) from recipe_ingredient ri where ri.recipe_version_id = rv.id) as ingredients,
                (select jsonb_agg(to_jsonb(s) order by s.step_number) from recipe_instruction s where s.recipe_version_id = rv.id) as instructions
           from recipe_version rv where rv.id = $1`,
        [v1Id],
      )
    ).rows[0];
    expect(after).toEqual(v1Rows);
    const res = await A().get(`${recipesOf(SEED.profileA)}/${bowlId}/versions/${v1Id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version_number: 1, is_current: false, title: 'Fixture Rice Bowl', servings: 4 });
    expect(res.body.ingredients).toHaveLength(3);
  });

  it('M: historical nutrition is calculated from that version, unchanged by the edit', async () => {
    const res = await A().get(`${recipesOf(SEED.profileA)}/${bowlId}/versions/${v1Id}/nutrition`);
    expect(res.status).toBe(200);
    const { is_current, ...rest } = res.body;
    const { is_current: wasCurrent, ...before } = v1Nutrition as { is_current: boolean };
    expect(wasCurrent).toBe(true);
    expect(is_current).toBe(false);
    expect(rest).toEqual(before);
  });

  it('lists versions newest first, with the current one flagged', async () => {
    const res = await A().get(`${recipesOf(SEED.profileA)}/${bowlId}/versions`);
    expect(res.body.data.map((v: { version_number: number; is_current: boolean }) => [v.version_number, v.is_current])).toEqual([
      [2, true],
      [1, false],
    ]);
  });

  it('a PATCH based on a stale version is refused (409), creating nothing', async () => {
    const res = await A().patch(`${recipesOf(SEED.profileA)}/${bowlId}`, { servings: 3, expected_current_version_id: v1Id });
    expect(res.status).toBe(409);
    const { rows } = await pool.query('select count(*)::int as n from recipe_version where recipe_id = $1', [bowlId]);
    expect(rows[0].n).toBe(2);
  });

  it('a partial PATCH carries every other field over from the current version', async () => {
    const res = await A().patch(`${recipesOf(SEED.profileA)}/${bowlId}`, { servings: 8 });
    expect(res.status).toBe(200);
    expect(res.body.current_version).toMatchObject({ version_number: 3, servings: 8, title: 'Fixture Rice Bowl (big)' });
    expect(res.body.current_version.ingredients.map((i: { food_id: string; serving_id: string | null }) => [i.food_id, i.serving_id])).toEqual([
      [F.rice, null],
      [F.bread, SRV.breadSlice],
      [F.spinach, null],
      [F.spinach, null],
    ]);
  });
});

describe('O-Q: immutable history at the database layer', () => {
  it('O: RecipeVersion cannot be updated or deleted by a client, nor updated by anyone', async () => {
    await expect(asAccountSql(SEED.accountA, "update recipe_version set title = 'x' where id = $1", [v1Id])).rejects.toThrow(/permission denied/);
    await expect(asAccountSql(SEED.accountA, 'delete from recipe_version where id = $1', [v1Id])).rejects.toThrow(/permission denied/);
    await expect(pool.query("update recipe_version set title = 'x' where id = $1", [v1Id])).rejects.toThrow();
  });

  it('P: RecipeIngredient cannot be updated or deleted by a client, nor updated by anyone', async () => {
    await expect(asAccountSql(SEED.accountA, 'update recipe_ingredient set quantity = 1 where recipe_version_id = $1', [v1Id])).rejects.toThrow(/permission denied/);
    await expect(asAccountSql(SEED.accountA, 'delete from recipe_ingredient where recipe_version_id = $1', [v1Id])).rejects.toThrow(/permission denied/);
    await expect(pool.query('update recipe_ingredient set quantity = 1 where recipe_version_id = $1', [v1Id])).rejects.toThrow();
  });

  it('Q: RecipeInstruction cannot be updated or deleted by a client, nor updated by anyone', async () => {
    await expect(asAccountSql(SEED.accountA, "update recipe_instruction set instruction_text = 'x' where recipe_version_id = $1", [v1Id])).rejects.toThrow(/permission denied/);
    await expect(asAccountSql(SEED.accountA, 'delete from recipe_instruction where recipe_version_id = $1', [v1Id])).rejects.toThrow(/permission denied/);
    await expect(pool.query("update recipe_instruction set instruction_text = 'x' where recipe_version_id = $1", [v1Id])).rejects.toThrow();
  });

  it('current_version_id cannot point at another recipe\'s version', async () => {
    const other = await pool.query('select id from recipe where id <> $1 and created_by_profile_id = $2 limit 1', [bowlId, SEED.profileA]);
    await expect(
      asAccountSql(SEED.accountA, 'update recipe set current_version_id = $1 where id = $2', [v1Id, other.rows[0].id]),
    ).rejects.toThrow(/current_version_id must reference a version of this recipe/);
  });

  it('the database rejects a serving that belongs to another food, and unit + serving together', async () => {
    await expect(
      pool.query(
        "insert into recipe_ingredient (recipe_version_id, food_id, food_serving_id, raw_ingredient_text, quantity, match_status, sort_order) values ($1, $2, $3, 'x', 1, 'matched', 99)",
        [v1Id, F.rice, SRV.breadSlice],
      ),
    ).rejects.toThrow(/fk_recipe_ingredient_food_serving/);
    await expect(
      pool.query(
        "insert into recipe_ingredient (recipe_version_id, food_id, food_serving_id, raw_ingredient_text, quantity, unit, match_status, sort_order) values ($1, $2, $3, 'x', 1, 'g', 'matched', 99)",
        [v1Id, F.bread, SRV.breadSlice],
      ),
    ).rejects.toThrow(/recipe_ingredient_unit_xor_serving/);
  });
});

describe('R, S, U: validation', () => {
  const path = () => recipesOf(SEED.profileA);

  it('R: a serving belonging to another food is rejected with the offending path', async () => {
    const res = await A().post(path(), { ...bowl, ingredients: [{ text: 'rice', food_id: F.rice, quantity: 1, serving_id: SRV.breadSlice }] });
    expect(res.status).toBe(400);
    expect(res.body.error.details.issues).toEqual([expect.objectContaining({ path: 'ingredients.0.serving_id' })]);
  });

  it('an unknown food is rejected', async () => {
    const res = await A().post(path(), { ...bowl, ingredients: [{ text: 'x', food_id: '00000000-0000-4000-8000-00000000f00d', quantity: 1, unit: 'g' }] });
    expect(res.status).toBe(400);
    expect(res.body.error.details.issues[0].path).toBe('ingredients.0.food_id');
  });

  it('S: zero/negative/non-numeric yields are rejected on create and edit', async () => {
    for (const servings of [0, -2, 'four', null]) {
      expect((await A().post(path(), { ...bowl, servings })).status).toBe(400);
    }
    expect((await A().patch(`${path()}/${bowlId}`, { servings: 0 })).status).toBe(400);
  });

  it('rejects Infinity (1e400 in JSON) and non-registry units', async () => {
    const infinite = await request(app)
      .post(path())
      .set('Authorization', `Bearer ${signTestToken(SEED.accountA)}`)
      .set('Content-Type', 'application/json')
      .send('{"title":"x","servings":1,"ingredients":[{"text":"x","food_id":"' + F.rice + '","quantity":1e400,"unit":"g"}]}');
    expect(infinite.status).toBe(400);
    expect((await A().post(path(), { ...bowl, ingredients: [{ text: 'x', food_id: F.rice, quantity: 1, unit: 'cup' }] })).status).toBe(400);
  });

  it('rejects malformed ids and search input', async () => {
    expect((await A().get(`${path()}/not-a-uuid`)).status).toBe(400);
    expect((await A().get(`/v1/profiles/not-a-uuid/recipes`)).status).toBe(400);
    expect((await A().get(path()).query({ q: '   ' })).status).toBe(400);
    expect((await A().get(path()).query({ limit: 0 })).status).toBe(400);
    expect((await A().get(`${path()}/${bowlId}/versions/not-a-uuid`)).status).toBe(400);
  });

  it('a version of a different recipe is not reachable under this recipe', async () => {
    const other = await A().post(path(), { ...bowl, title: 'Fixture Other' });
    const res = await A().get(`${path()}/${bowlId}/versions/${other.body.current_version.id}`);
    expect(res.status).toBe(404);
  });
});

describe('T-W: authorization follows the existing Recipe RLS', () => {
  let childRecipeId: string;

  it('T: an unrelated Account cannot see or edit a private recipe (404)', async () => {
    const u = as(SEED.accountUnrelated);
    expect((await u.get(`${recipesOf(SEED.profileA)}/${bowlId}`)).status).toBe(404);
    expect((await u.get(recipesOf(SEED.profileA))).status).toBe(404);
    expect((await u.patch(`${recipesOf(SEED.profileA)}/${bowlId}`, { servings: 1 })).status).toBe(404);
    // Account B, through its OWN profile path, still cannot reach A's recipe
    const b = as(SEED.accountB);
    expect((await b.get(`${recipesOf(SEED.profileB)}/${bowlId}`)).status).toBe(404);
    expect((await b.get(`${recipesOf(SEED.profileB)}/${bowlId}/nutrition`)).status).toBe(404);
    expect((await b.get(recipesOf(SEED.profileB))).body.data).toEqual([]);
    // and RLS alone hides it too
    const direct = await asAccountSql(SEED.accountB, 'select id from recipe where id = $1', [bowlId]);
    expect(direct.rows).toEqual([]);
  });

  it('full_management guardian can create and edit recipes for the child profile', async () => {
    const g = as(SEED.accountFullManagement);
    const created = await g.post(recipesOf(SEED.profileChild), { ...bowl, title: 'Fixture Child Lunch' });
    expect(created.status).toBe(201);
    childRecipeId = created.body.id;
    const edited = await g.patch(`${recipesOf(SEED.profileChild)}/${childRecipeId}`, { servings: 2 });
    expect(edited.status).toBe(200);
    expect(edited.body.current_version.version_number).toBe(2);
  });

  it('V: view_only can read but not create or edit (403)', async () => {
    const v = as(SEED.accountViewOnly);
    expect((await v.get(`${recipesOf(SEED.profileChild)}/${childRecipeId}`)).status).toBe(200);
    expect((await v.get(`${recipesOf(SEED.profileChild)}/${childRecipeId}/nutrition`)).status).toBe(200);
    expect((await v.post(recipesOf(SEED.profileChild), bowl)).status).toBe(403);
    expect((await v.patch(`${recipesOf(SEED.profileChild)}/${childRecipeId}`, { servings: 9 })).status).toBe(403);
    // RLS refuses the write even if the API check were bypassed
    await expect(
      asAccountSql(SEED.accountViewOnly, 'select create_recipe_version($1, $2, null, $3)', [SEED.profileChild, childRecipeId, { title: 'x', servings: 1, ingredients: [], instructions: [] }]),
    ).rejects.toThrow(/recipe not found/);
  });

  it('W: pediatric_weight_management reads recipes of the child (approved matrix) but cannot manage them', async () => {
    const p = as(SEED.accountPediatric);
    expect((await p.get(recipesOf(SEED.profileChild))).body.data.map((r: { id: string }) => r.id)).toContain(childRecipeId);
    expect((await p.get(`${recipesOf(SEED.profileChild)}/${childRecipeId}/nutrition`)).status).toBe(200);
    expect((await p.post(recipesOf(SEED.profileChild), bowl)).status).toBe(403);
    expect((await p.patch(`${recipesOf(SEED.profileChild)}/${childRecipeId}`, { servings: 9 })).status).toBe(403);
    await expect(
      asAccountSql(SEED.accountPediatric, 'select create_recipe_version($1, null, null, $2)', [SEED.profileChild, { title: 'x', servings: 1, ingredients: [], instructions: [] }]),
    ).rejects.toThrow(/row-level security/);
  });

  it('U: a revoked guardian has no access at all (404)', async () => {
    const r = as(SEED.accountRevoked);
    expect((await r.get(recipesOf(SEED.profileChild))).status).toBe(404);
    expect((await r.get(`${recipesOf(SEED.profileChild)}/${childRecipeId}`)).status).toBe(404);
    expect((await r.patch(`${recipesOf(SEED.profileChild)}/${childRecipeId}`, { servings: 1 })).status).toBe(404);
  });

  it('there is no DELETE route', async () => {
    const res = await request(app).delete(`${recipesOf(SEED.profileA)}/${bowlId}`).set('Authorization', `Bearer ${signTestToken(SEED.accountA)}`);
    expect(res.status).toBe(404);
    const { rows } = await pool.query('select count(*)::int as n from recipe where id = $1', [bowlId]);
    expect(rows[0].n).toBe(1);
  });
});

describe('Y: list, search and pagination', () => {
  it('paginates the profile\'s private recipes with a stable cursor', async () => {
    const b = as(SEED.accountB);
    for (const title of ['Fixture Lentil Soup', 'Fixture Tomato SOUP', 'Fixture Pancakes']) {
      expect((await b.post(recipesOf(SEED.profileB), { title, servings: 2, ingredients: [{ text: 'rice', food_id: F.rice, quantity: 100, unit: 'g' }] })).status).toBe(201);
    }
    const first = await b.get(recipesOf(SEED.profileB)).query({ limit: 2 });
    expect(first.body.data).toHaveLength(2);
    expect(first.body.pagination.nextCursor).toEqual(expect.any(String));
    const second = await b.get(recipesOf(SEED.profileB)).query({ limit: 2, cursor: first.body.pagination.nextCursor });
    expect(second.body.data).toHaveLength(1);
    expect(second.body.pagination.nextCursor).toBeNull();
    const all = [...first.body.data, ...second.body.data].map((r: { id: string }) => r.id);
    expect(new Set(all).size).toBe(3);
    expect(first.body.data[0]).toMatchObject({ profile_id: SEED.profileB, visibility: 'private', current_version_number: 1, servings: 2 });
  });

  it('title search is case-insensitive and normalized', async () => {
    const b = as(SEED.accountB);
    const res = await b.get(recipesOf(SEED.profileB)).query({ q: '  soup ' });
    expect(res.body.data.map((r: { title: string }) => r.title).sort()).toEqual(['Fixture Lentil Soup', 'Fixture Tomato SOUP']);
    expect((await b.get(recipesOf(SEED.profileB)).query({ q: 'nothing-matches' })).body.data).toEqual([]);
  });
});

describe('Personalized variants (read only)', () => {
  let variantId: string;

  beforeAll(async () => {
    const { rows } = await pool.query(
      "insert into recipe_personalized_variant (base_recipe_id, base_recipe_version_id, profile_id, adjustments_payload) values ($1, $2, $3, '{\"note\":\"fixture\"}') returning id",
      [bowlId, v1Id, SEED.profileA],
    );
    variantId = rows[0].id;
  });

  it('returns the variant with its base recipe and base version, without touching the base', async () => {
    const list = await A().get(`/v1/profiles/${SEED.profileA}/recipe-variants`).query({ base_recipe_id: bowlId });
    expect(list.status).toBe(200);
    expect(list.body.data).toEqual([expect.objectContaining({ id: variantId, base_recipe_id: bowlId, base_recipe_version_id: v1Id, profile_id: SEED.profileA, ai_generated: false })]);
    const one = await A().get(`/v1/profiles/${SEED.profileA}/recipe-variants/${variantId}`);
    expect(one.body.adjustments_payload).toEqual({ note: 'fixture' });
  });

  it('is profile-scoped and has no write route', async () => {
    expect((await as(SEED.accountB).get(`/v1/profiles/${SEED.profileB}/recipe-variants/${variantId}`)).status).toBe(404);
    expect((await as(SEED.accountUnrelated).get(`/v1/profiles/${SEED.profileA}/recipe-variants`)).status).toBe(404);
    expect((await A().post(`/v1/profiles/${SEED.profileA}/recipe-variants`, { adjustments_payload: {} })).status).toBe(404);
  });
});
