// Layer 13B integration tests — ingredient-based nutrition for imported and
// manual recipes, end to end: USDA-shaped reference data loaded through the
// real ingestion code, a website import (in-memory fetcher, no network),
// food matching and amounts, saving, per-ingredient / whole-recipe /
// per-serving nutrition, the live preview, and edits.
//
// The catalog below is in the SR Legacy JSON shape with values transcribed
// from USDA FoodData Central SR Legacy for these foods (per 100 g, and
// USDA's own portion weights). It is test data, loaded only into the test
// database.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app';
import { logger } from '../../src/lib/logger';
import { applyPlan } from '../../src/ingestion/usda/apply';
import { buildPlan } from '../../src/ingestion/usda/plan';
import { PageFetchError, type PageFetcher } from '../../src/domain/recipeImports/pageFetcher';
import { PgHarnessProfileRepository } from '../helpers/pgHarnessProfileRepository';
import { PgHarnessScopedDbFactory } from '../helpers/pgHarnessScopedDb';
import { rebuildTestDatabase } from '../helpers/testDb';
import { seedScenario, SEED } from '../helpers/seed';
import { signTestToken, TEST_JWT_SECRET } from '../helpers/jwt';

const NUTRIENT_IDS: Record<string, [number, string, string, string]> = {
  energy: [1008, '208', 'Energy', 'kcal'],
  protein: [1003, '203', 'Protein', 'g'],
  carbohydrate: [1005, '205', 'Carbohydrate, by difference', 'g'],
  fat: [1004, '204', 'Total lipid (fat)', 'g'],
  fiber: [1079, '291', 'Fiber, total dietary', 'g'],
  sugars: [2000, '269', 'Sugars, total including NLEA', 'g'],
  satfat: [1258, '606', 'Fatty acids, total saturated', 'g'],
  sodium: [1093, '307', 'Sodium, Na', 'mg'],
  potassium: [1092, '306', 'Potassium, K', 'mg'],
  calcium: [1087, '301', 'Calcium, Ca', 'mg'],
  iron: [1089, '303', 'Iron, Fe', 'mg'],
  magnesium: [1090, '304', 'Magnesium, Mg', 'mg'],
  zinc: [1095, '309', 'Zinc, Zn', 'mg'],
  vitamin_a: [1106, '320', 'Vitamin A, RAE', 'µg'],
  vitamin_c: [1162, '401', 'Vitamin C, total ascorbic acid', 'mg'],
  vitamin_d: [1114, '328', 'Vitamin D (D2 + D3)', 'µg'],
  vitamin_b12: [1178, '418', 'Vitamin B-12', 'µg'],
};

type Values = Partial<Record<keyof typeof NUTRIENT_IDS, number>>;
const srFood = (fdcId: number, ndb: string, description: string, values: Values, portions: Array<[number, string, number]>) => ({
  fdcId,
  description,
  dataType: 'SR Legacy',
  ndbNumber: ndb,
  foodCategory: { description: 'Test catalog' },
  foodNutrients: Object.entries(values).map(([key, amount]) => {
    const [id, number, name, unitName] = NUTRIENT_IDS[key]!;
    return { nutrient: { id, number, name, unitName }, amount };
  }),
  foodPortions: portions.map(([amount, modifier, gramWeight], i) => ({ amount, modifier, gramWeight, sequenceNumber: i + 1, measureUnit: { name: 'undetermined' } })),
});

const CATALOG = [
  srFood(168462, '11457', 'Spinach, raw', { energy: 23, protein: 2.86, carbohydrate: 3.63, fat: 0.39, fiber: 2.2, sugars: 0.42, satfat: 0.063, sodium: 79, potassium: 558, calcium: 99, iron: 2.71, magnesium: 79, zinc: 0.53, vitamin_a: 469, vitamin_c: 28.1, vitamin_d: 0 }, [[1, 'cup', 30], [1, 'bunch', 340], [1, 'leaf', 10]]),
  srFood(168463, '11458', 'Spinach, cooked, boiled, drained, without salt', { energy: 23, protein: 2.97, carbohydrate: 3.75, fat: 0.26, fiber: 2.4 }, [[1, 'cup', 180]]),
  srFood(171287, '01123', 'Egg, whole, raw, fresh', { energy: 143, protein: 12.56, carbohydrate: 0.72, fat: 9.51, fiber: 0, sugars: 0.37, satfat: 3.126, sodium: 142, potassium: 138, calcium: 56, iron: 1.75, magnesium: 12, zinc: 1.29, vitamin_a: 160, vitamin_d: 2, vitamin_b12: 0.89 }, [[1, 'large', 50], [1, 'extra large', 56], [1, 'medium', 44], [1, 'small', 38]]),
  srFood(172183, '01124', 'Egg, white, raw, fresh', { energy: 52, protein: 10.9, carbohydrate: 0.73, fat: 0.17 }, [[1, 'large', 33]]),
  srFood(171413, '04053', 'Oil, olive, salad or cooking', { energy: 884, protein: 0, carbohydrate: 0, fat: 100, fiber: 0, sugars: 0, satfat: 13.808, sodium: 2, potassium: 1, calcium: 1, iron: 0.56 }, [[1, 'tbsp', 13.5], [1, 'cup', 216], [1, 'tsp', 4.5]]),
  srFood(169761, '20081', 'Wheat flour, white, all-purpose, enriched, bleached', { energy: 364, protein: 10.33, carbohydrate: 76.31, fat: 0.98, fiber: 2.7, sugars: 0.27, satfat: 0.155, sodium: 2, potassium: 107, calcium: 15, iron: 4.64, magnesium: 22, zinc: 0.7 }, [[1, 'cup', 125]]),
  srFood(173468, '02047', 'Salt, table', { energy: 0, protein: 0, carbohydrate: 0, fat: 0, fiber: 0, sugars: 0, sodium: 38758, potassium: 8, calcium: 24, iron: 0.33, magnesium: 1, zinc: 0.1 }, [[1, 'tsp', 6], [1, 'tbsp', 18], [1, 'cup', 292], [1, 'dash', 0.4]]),
  srFood(169230, '11215', 'Garlic, raw', { energy: 149, protein: 6.36, carbohydrate: 33.06, fat: 0.5, fiber: 2.1, sugars: 1, sodium: 17, potassium: 401, calcium: 181, iron: 1.7, magnesium: 25, zinc: 1.16, vitamin_c: 31.2 }, [[1, 'cup', 136], [1, 'tsp', 2.8], [1, 'clove', 3]]),
  srFood(169756, '20444', 'Rice, white, long-grain, regular, raw, enriched', { energy: 365, protein: 7.13, carbohydrate: 79.95, fat: 0.66, fiber: 1.3 }, [[1, 'cup', 185]]),
  srFood(168878, '20045', 'Rice, white, long-grain, regular, cooked, enriched, with salt', { energy: 130, protein: 2.69, carbohydrate: 28.17, fat: 0.28, fiber: 0.4, sodium: 382, iron: 1.2 }, [[1, 'cup', 158]]),
];
const MANIFEST = { manifest_version: 1, name: 'layer13b-test', source: { system: 'usda_fdc', dataset: 'sr_legacy' }, foods: CATALOG.map((f) => ({ ndb_number: f.ndbNumber, description: f.description })) };

const INGREDIENTS = [
  '2 cups fresh spinach, washed',
  '3 large eggs',
  '2 tbsp extra-virgin olive oil',
  '1 cup all-purpose flour',
  '1 tsp salt',
  '3 cloves garlic, minced',
  '1 cup cooked rice',
  '1 bunch fresh dill',
  'black pepper, to taste',
];
const page = `<html><head><script type="application/ld+json">${JSON.stringify({
  '@type': 'Recipe',
  name: 'Spinach Garlic Bake',
  recipeYield: '4 servings',
  recipeIngredient: INGREDIENTS,
  recipeInstructions: ['Mix.', 'Bake.'],
})}</script></head></html>`;
const fakeFetcher: PageFetcher = {
  async fetchPage(url) {
    if (url !== 'https://kitchen.example-recipes.com/spinach-bake') throw new PageFetchError('http_error', false, 404);
    return { finalUrl: url, status: 200, contentType: 'text/html', html: page };
  },
};

// Expected grams and energy, from the USDA portion weights and kcal/100 g above.
const EXPECTED = [
  { grams: 60, kcal: 13.8 }, // 2 cups spinach (1 cup = 30 g)
  { grams: 150, kcal: 214.5 }, // 3 large eggs (50 g)
  { grams: 27, kcal: 238.68 }, // 2 tbsp olive oil (13.5 g)
  { grams: 125, kcal: 455 }, // 1 cup flour
  { grams: 6, kcal: 0 }, // 1 tsp salt — a known zero
  { grams: 9, kcal: 13.41 }, // 3 cloves garlic (3 g)
  { grams: 158, kcal: 205.4 }, // 1 cup cooked rice
];
const TOTAL_KCAL = EXPECTED.reduce((sum, e) => sum + e.kcal, 0);

let pool: Pool;
let app: ReturnType<typeof createApp>;
const auth = () => `Bearer ${signTestToken(SEED.accountA)}`;
const get = (p: string) => request(app).get(p).set('Authorization', auth());
const post = (p: string, body: unknown) => request(app).post(p).set('Authorization', auth()).send(body as object);
const patch = (p: string, body: unknown) => request(app).patch(p).set('Authorization', auth()).send(body as object);
const recipes = `/v1/profiles/${SEED.profileA}/recipes`;

interface Suggestion {
  food_id: string;
  name: string;
  auto: boolean;
  reasons: string[];
  state: { line: string | null; food: string | null };
  amount: { quantity: number; unit?: string; serving_id?: string; serving_description?: string; grams: number | null; assumptions: string[] } | null;
  alternatives: Array<{ food_id: string; name: string; state: string | null }>;
}
interface DraftLine {
  text: string;
  suggestion?: Suggestion;
}
interface NutrientRow {
  nutrient_key: string;
  value: number | null;
  status: string;
  unit: string;
  source: { source: string; basis_quantity: number; basis_unit: string } | null;
}
interface AggregateRow {
  nutrient_key: string;
  value: number | null;
  coverage: string;
}

/** What the review form sends: a confident match as a confirmed food with its amount; the rest as text. */
function reviewedIngredient(line: DraftLine): Record<string, unknown> {
  const s = line.suggestion;
  if (!s?.auto || !s.amount) return s ? { text: line.text, suggested_food_id: s.food_id } : { text: line.text };
  const amount = s.amount.serving_id ? { serving_id: s.amount.serving_id } : { unit: s.amount.unit };
  return { text: line.text, food_id: s.food_id, quantity: s.amount.quantity, ...amount };
}

let draft: DraftLine[];
let importId: string;
let recipeId: string;

beforeAll(async () => {
  pool = await rebuildTestDatabase('recipebook_api_test_layer13b');
  await seedScenario(pool);
  const client = await pool.connect();
  try {
    await applyPlan(client, buildPlan({ SRLegacyFoods: CATALOG }, MANIFEST), { release: 'LAYER13B-TEST', dryRun: false });
  } finally {
    client.release();
  }
  app = createApp({ profileRepository: new PgHarnessProfileRepository(pool), scopedDbFactory: new PgHarnessScopedDbFactory(pool), jwtSecret: TEST_JWT_SECRET, logger, pageFetcher: fakeFetcher });
}, 120_000);

afterAll(async () => {
  await pool.end();
});

describe('importing: every line matched to a food with an amount, or flagged', () => {
  it('matches foods by name and state and gives food-specific amounts', async () => {
    const res = await post(`/v1/profiles/${SEED.profileA}/recipe-imports`, { url: 'https://kitchen.example-recipes.com/spinach-bake' });
    expect(res.status).toBe(201);
    importId = res.body.id;
    draft = res.body.draft.ingredients;
    expect(draft).toHaveLength(9);
    const names = draft.map((l) => l.suggestion?.name ?? null);
    expect(names).toEqual([
      'Spinach, raw',
      'Egg, whole, raw, fresh',
      'Oil, olive, salad or cooking',
      'Wheat flour, white, all-purpose, enriched, bleached',
      'Salt, table',
      'Garlic, raw',
      'Rice, white, long-grain, regular, cooked, enriched, with salt',
      null,
      null,
    ]);
    // Seven confident matches, each with an amount from the food's USDA portion.
    draft.slice(0, 7).forEach((line, i) => {
      expect(line.suggestion?.auto, line.text).toBe(true);
      expect(line.suggestion?.amount?.grams, line.text).toBeCloseTo(EXPECTED[i]!.grams, 6);
    });
    expect(draft[0]!.suggestion?.amount).toMatchObject({ quantity: 2, serving_description: '1 cup', assumptions: ['us_measure'] });
    expect(draft[1]!.suggestion?.amount).toMatchObject({ quantity: 3, serving_description: '1 large', assumptions: [] });
    expect(draft[5]!.suggestion?.amount).toMatchObject({ quantity: 3, serving_description: '1 clove' });
    // Preparation state: "cooked rice" is the cooked food, "fresh spinach" the raw one (the cooked form is offered).
    expect(draft[6]!.suggestion?.state).toEqual({ line: 'cooked', food: 'cooked' });
    expect(draft[0]!.suggestion).toMatchObject({ state: { line: 'raw', food: 'raw' }, reasons: [] });
    // Eggs name no state: the as-bought (raw) food is used.
    expect(draft[1]!.suggestion).toMatchObject({ state: { line: null, food: 'raw' } });
    // Plain rice would be ambiguous between raw and cooked: held for review.
    expect(draft[0]!.suggestion?.alternatives.map((a) => a.name)).toContain('Spinach, cooked, boiled, drained, without salt');
  });
});

describe('nutrition of the saved recipe', () => {
  let body: {
    ingredient_count: number;
    calculated_ingredient_count: number;
    ingredients: Array<{ nutrition_status: string; calculation: { summary: Record<string, { value: number | null }>; nutrients: NutrientRow[]; normalized_quantity: { quantity: number; unit: string } } | null }>;
    whole_recipe: { nutrients: AggregateRow[]; summary: Record<string, { value: number | null; coverage: string }> };
    per_serving: { servings: number; nutrients: AggregateRow[]; summary: Record<string, { value: number | null; coverage: string }> };
  };

  it('saves the reviewed import and calculates every matched ingredient', async () => {
    const save = await post(`/v1/profiles/${SEED.profileA}/recipe-imports/${importId}/save`, {
      title: 'Spinach Garlic Bake',
      servings: 4,
      ingredients: draft.map(reviewedIngredient),
      instructions: ['Mix.', 'Bake.'],
    });
    expect(save.status).toBe(201);
    recipeId = save.body.id;
    const res = await get(`${recipes}/${recipeId}/nutrition`);
    expect(res.status).toBe(200);
    body = res.body;
    expect(body).toMatchObject({ ingredient_count: 9, calculated_ingredient_count: 7 });
  });

  it('gives each ingredient its calories, macronutrients and grams', () => {
    body.ingredients.slice(0, 7).forEach((ingredient, i) => {
      expect(ingredient.nutrition_status).toBe('calculated');
      const calc = ingredient.calculation!;
      expect(calc.normalized_quantity).toMatchObject({ unit: 'g' });
      expect(calc.normalized_quantity.quantity).toBeCloseTo(EXPECTED[i]!.grams, 6);
      expect(calc.summary.energy_kcal!.value).toBeCloseTo(EXPECTED[i]!.kcal, 6);
      for (const field of ['protein_g', 'carbohydrate_g', 'fat_g']) expect(calc.summary[field]!.value, `${i} ${field}`).not.toBeNull();
    });
    // Eggs, by hand: 150 g x 12.56 g/100 g protein, 9.51 fat, 0.72 carbohydrate.
    const eggs = body.ingredients[1]!.calculation!.summary;
    expect(eggs.protein_g!.value).toBeCloseTo(18.84, 6);
    expect(eggs.fat_g!.value).toBeCloseTo(14.265, 6);
    expect(eggs.carbohydrate_g!.value).toBeCloseTo(1.08, 6);
  });

  it('includes fiber, sugars, saturated fat, sodium and micronutrients with their USDA source', () => {
    const spinach = body.ingredients[0]!.calculation!.nutrients;
    const by = (key: string) => spinach.find((n) => n.nutrient_key === key)!;
    expect(by('fiber').value).toBeCloseTo(1.32, 6);
    expect(by('total_sugars').value).toBeCloseTo(0.252, 6);
    expect(by('saturated_fat').value).toBeCloseTo(0.0378, 6);
    expect(by('sodium').value).toBeCloseTo(47.4, 6);
    expect(by('iron').value).toBeCloseTo(1.626, 6);
    expect(by('calcium').value).toBeCloseTo(59.4, 6);
    expect(by('potassium').value).toBeCloseTo(334.8, 6);
    expect(by('magnesium').value).toBeCloseTo(47.4, 6);
    expect(by('zinc').value).toBeCloseTo(0.318, 6);
    expect(by('vitamin_c').value).toBeCloseTo(16.86, 6);
    expect(by('vitamin_a').value).toBeCloseTo(281.4, 6);
    expect(by('iron').source).toMatchObject({ source: 'trusted_database', basis_quantity: 100, basis_unit: 'g' });
    // Salt's energy is a known zero; its sodium is real.
    const salt = body.ingredients[4]!.calculation!.nutrients;
    expect(salt.find((n) => n.nutrient_key === 'energy')).toMatchObject({ value: 0, status: 'resolved' });
    expect(salt.find((n) => n.nutrient_key === 'sodium')!.value).toBeCloseTo(2325.48, 6);
  });

  it('never fills missing data with zero', () => {
    // USDA states no vitamin C for egg: unavailable, not 0.
    const eggVitC = body.ingredients[1]!.calculation!.nutrients.find((n) => n.nutrient_key === 'vitamin_c')!;
    expect(eggVitC).toMatchObject({ value: null, status: 'no_data' });
    // Unmatched lines are flagged and keep the totals partial.
    expect(body.ingredients[7]!.nutrition_status).toBe('food_unmatched');
    expect(body.ingredients[8]!.nutrition_status).toBe('food_unmatched');
    expect(body.whole_recipe.summary.energy_kcal!.coverage).toBe('partial');
  });

  it('whole-recipe totals equal the sum of the ingredients, nutrient by nutrient', () => {
    expect(body.whole_recipe.summary.energy_kcal!.value).toBeCloseTo(TOTAL_KCAL, 6);
    for (const total of body.whole_recipe.nutrients) {
      const parts = body.ingredients.map((i) => i.calculation?.nutrients.find((n) => n.nutrient_key === total.nutrient_key)?.value ?? null).filter((v): v is number => v !== null);
      if (total.value === null) {
        expect(parts, total.nutrient_key).toEqual([]);
        continue;
      }
      // Each part and the total are rounded once to 6 places: allow that rounding.
      expect(Math.abs(total.value - parts.reduce((a, b) => a + b, 0)), total.nutrient_key).toBeLessThanOrEqual(1e-6 * (parts.length + 1));
    }
  });

  it('per serving is the whole recipe divided by the servings', () => {
    expect(body.per_serving.servings).toBe(4);
    for (const total of body.whole_recipe.nutrients) {
      const serving = body.per_serving.nutrients.find((n) => n.nutrient_key === total.nutrient_key)!;
      if (total.value === null) expect(serving.value).toBeNull();
      else expect(serving.value!).toBeCloseTo(total.value / 4, 5);
    }
    expect(body.per_serving.summary.energy_kcal!.value).toBeCloseTo(TOTAL_KCAL / 4, 5);
  });
});

describe('recalculating on every change', () => {
  const base = () => draft.map(reviewedIngredient);

  it('the preview recalculates an edited quantity, food state and servings without saving anything', async () => {
    const before = await pool.query('select count(*)::int as n from recipe_version');
    const original = await post(`${recipes}/nutrition-preview`, { servings: 4, ingredients: base() });
    expect(original.status).toBe(200);
    expect(original.body.whole_recipe.summary.energy_kcal.value).toBeCloseTo(TOTAL_KCAL, 6);

    // 3 eggs -> 2 eggs: energy, protein, fat and every egg micronutrient drop by a third of the egg line.
    const twoEggs = base();
    twoEggs[1] = { ...twoEggs[1]!, text: '2 large eggs', quantity: 2 };
    const edited = await post(`${recipes}/nutrition-preview`, { servings: 4, ingredients: twoEggs });
    expect(edited.body.whole_recipe.summary.energy_kcal.value).toBeCloseTo(TOTAL_KCAL - 71.5, 6);
    expect(edited.body.ingredients[1].calculation.summary.protein_g.value).toBeCloseTo(12.56, 6);
    const b12 = (r: { body: { whole_recipe: { nutrients: AggregateRow[] } } }) => r.body.whole_recipe.nutrients.find((n) => n.nutrient_key === 'vitamin_b12')!.value!;
    expect(b12(edited)).toBeCloseTo((b12(original) * 2) / 3, 6);

    // Raw -> cooked spinach (preparation state): 1 cup cooked = 180 g.
    const cookedId = draft[0]!.suggestion!.alternatives.find((a) => a.state === 'cooked')!.food_id;
    const servings = await pool.query<{ id: string }>("select id from food_serving where food_id = $1 and serving_description = '1 cup'", [cookedId]);
    const cooked = base();
    cooked[0] = { text: '2 cups cooked spinach', food_id: cookedId, quantity: 2, serving_id: servings.rows[0]!.id };
    const stateChanged = await post(`${recipes}/nutrition-preview`, { servings: 4, ingredients: cooked });
    expect(stateChanged.body.ingredients[0].calculation.summary.energy_kcal.value).toBeCloseTo(82.8, 6);

    // Servings 4 -> 6.
    const six = await post(`${recipes}/nutrition-preview`, { servings: 6, ingredients: base() });
    expect(six.body.per_serving.summary.energy_kcal.value).toBeCloseTo(TOTAL_KCAL / 6, 5);
    expect((await pool.query('select count(*)::int as n from recipe_version')).rows[0]).toEqual(before.rows[0]);
  });

  it('saving an edited quantity updates every affected value', async () => {
    const twoEggs = base();
    twoEggs[1] = { ...twoEggs[1]!, text: '2 large eggs', quantity: 2 };
    const res = await patch(`${recipes}/${recipeId}`, { ingredients: twoEggs, servings: 2 });
    expect(res.status).toBe(200);
    const n = await get(`${recipes}/${recipeId}/nutrition`);
    expect(n.body.ingredients[1].calculation.summary.energy_kcal.value).toBeCloseTo(143, 6);
    expect(n.body.whole_recipe.summary.energy_kcal.value).toBeCloseTo(TOTAL_KCAL - 71.5, 6);
    expect(n.body.per_serving.summary.energy_kcal.value).toBeCloseTo((TOTAL_KCAL - 71.5) / 2, 5);
  });

  it('works the same for a recipe created by hand', async () => {
    const manual = await post(recipes, { title: 'Hand-made', servings: 2, ingredients: base().slice(0, 5), instructions: [] });
    expect(manual.status).toBe(201);
    const n = await get(`${recipes}/${manual.body.id}/nutrition`);
    expect(n.body.calculated_ingredient_count).toBe(5);
    const expected = EXPECTED.slice(0, 5).reduce((s, e) => s + e.kcal, 0);
    expect(n.body.whole_recipe.summary.energy_kcal).toMatchObject({ coverage: 'complete' });
    expect(n.body.whole_recipe.summary.energy_kcal.value).toBeCloseTo(expected, 6);
    expect(n.body.per_serving.summary.energy_kcal.value).toBeCloseTo(expected / 2, 5);
  });

  it('the preview refuses a serving that belongs to another food', async () => {
    const wrong = base();
    wrong[0] = { ...wrong[0]!, food_id: draft[1]!.suggestion!.food_id };
    const res = await post(`${recipes}/nutrition-preview`, { servings: 4, ingredients: wrong });
    expect(res.status).toBe(400);
  });
});
