// Layer 5B integration tests — POST /v1/nutrition/calculate against the
// real migration chain and RLS harness (see profiles.api.test.ts header).
// Food data comes from tests/helpers/nutritionFixtures.ts — TEST FIXTURES
// ONLY, not production nutrition data.

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
import { CANONICAL_NUTRIENTS } from '../../src/domain/nutrition/vocabulary';

const VOCABULARY_SIZE = CANONICAL_NUTRIENTS.length;

let pool: Pool;
let app: ReturnType<typeof createApp>;

const auth = (accountId: string = SEED.accountA) => `Bearer ${signTestToken(accountId)}`;

interface NutrientOut {
  nutrient_id: string;
  nutrient_key: string;
  unit: string;
  status: string;
  value: number | null;
  is_zero: boolean;
  source: { food_nutrient_id: string; source: string; basis_quantity: number; basis_unit: string; amount_per_basis: number; quantity_in_basis_unit: number } | null;
  candidates: Array<{ source: string }>;
  excluded: Array<{ source: string; reason: string }>;
  conversion_reason: string | null;
}
interface AggregateOut {
  nutrient_key: string;
  unit: string;
  coverage: string;
  value: number | null;
  is_zero: boolean;
  resolved_item_count: number;
  item_count: number;
  missing: Array<{ index: number; status: string }>;
}

type Item = { food_id: string; quantity: unknown; unit?: string; serving_id?: string };
const calculate = (items: Item[], account?: string) =>
  request(app).post('/v1/nutrition/calculate').set('Authorization', auth(account)).send({ items });

async function calc(items: Item[]) {
  const res = await calculate(items);
  expect(res.status).toBe(200);
  const body = res.body as { calculation_version: string; items: Array<{ nutrients: NutrientOut[]; normalized_quantity: Record<string, unknown> }>; aggregate: { nutrients: AggregateOut[]; coverage_summary: Record<string, number>; item_count: number } };
  const itemNutrient = (i: number, key: string) => {
    const n = body.items[i]?.nutrients.find((x) => x.nutrient_key === key);
    if (!n) throw new Error(`no ${key} on item ${i}`);
    return n;
  };
  const agg = (key: string) => {
    const n = body.aggregate.nutrients.find((x) => x.nutrient_key === key);
    if (!n) throw new Error(`no aggregate ${key}`);
    return n;
  };
  return { body, itemNutrient, agg };
}

async function tableCounts() {
  const { rows } = await pool.query(
    `select (select count(*) from food)::int as food, (select count(*) from food_alias)::int as food_alias,
            (select count(*) from food_serving)::int as food_serving, (select count(*) from nutrient)::int as nutrient,
            (select count(*) from food_nutrient)::int as food_nutrient,
            (select count(*) from meal_log)::int as meal_log, (select count(*) from recipe)::int as recipe`,
  );
  return rows[0];
}

beforeAll(async () => {
  pool = await rebuildTestDatabase('recipebook_api_test_layer5b');
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

describe('authentication', () => {
  it('requires a token', async () => {
    const res = await request(app).post('/v1/nutrition/calculate').send({ items: [{ food_id: F.rice, quantity: 100, unit: 'g' }] });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});

describe('A-D, G-I: single-food scaling', () => {
  it('A/G: 150 g of a per-100 g food scales every macro and fiber', async () => {
    const { body, itemNutrient } = await calc([{ food_id: F.rice, quantity: 150, unit: 'g' }]);
    expect(body.calculation_version).toBe('nutrition-calculation-5b.1');
    expect(body.items[0]?.normalized_quantity).toMatchObject({ status: 'converted', quantity: 150, unit: 'g', authoritative: true });
    expect(itemNutrient(0, 'energy')).toMatchObject({ status: 'resolved', value: 195, unit: 'kcal' });
    expect(itemNutrient(0, 'protein').value).toBe(4.05);
    expect(itemNutrient(0, 'carbohydrate').value).toBe(42.3);
    expect(itemNutrient(0, 'fat').value).toBe(0.45);
    expect(itemNutrient(0, 'fiber').value).toBe(0.6);
  });

  it('B: a non-100 (40 g) label basis is read explicitly', async () => {
    const { itemNutrient } = await calc([{ food_id: F.bar, quantity: 60, unit: 'g' }]);
    expect(itemNutrient(0, 'energy').value).toBe(270);
    expect(itemNutrient(0, 'protein').value).toBe(15);
    expect(itemNutrient(0, 'protein').source).toMatchObject({ source: 'manufacturer_label', basis_quantity: 40, basis_unit: 'g', amount_per_basis: 10, quantity_in_basis_unit: 60 });
  });

  it('C: 2 slices of a 30 g slice = 60 g, scaled from the basis', async () => {
    const { body, itemNutrient } = await calc([{ food_id: F.bread, quantity: 2, serving_id: SRV.breadSlice }]);
    expect(body.items[0]?.normalized_quantity).toMatchObject({ quantity: 60, unit: 'g' });
    expect(itemNutrient(0, 'energy').value).toBe(159);
    expect(itemNutrient(0, 'protein').value).toBe(5.4);
  });

  it('D: volume basis with volume input (ml, cup_us, and a volume serving)', async () => {
    const { itemNutrient } = await calc([
      { food_id: F.milk, quantity: 250, unit: 'ml' },
      { food_id: F.milk, quantity: 1, unit: 'cup_us' },
      { food_id: F.milk, quantity: 1, serving_id: SRV.milkCup },
    ]);
    expect(itemNutrient(0, 'protein').value).toBe(8.5);
    expect(itemNutrient(1, 'protein').value).toBe(8.044);
    expect(itemNutrient(2, 'energy').value).toBe(153.6);
  });

  it('H/I: micronutrients scale and keep their own canonical units', async () => {
    const { itemNutrient, agg } = await calc([
      { food_id: F.spinach, quantity: 50, unit: 'g' },
      { food_id: F.milk, quantity: 500, unit: 'ml' },
    ]);
    expect(itemNutrient(0, 'iron')).toMatchObject({ value: 1.35, unit: 'mg' });
    expect(itemNutrient(1, 'vitamin_d')).toMatchObject({ value: 5.5, unit: 'mcg' });
    expect(agg('vitamin_d')).toMatchObject({ unit: 'mcg', value: 5.5, coverage: 'complete' });
    expect(agg('iron')).toMatchObject({ unit: 'mg', value: 1.35, coverage: 'partial' });
  });
});

describe('E/F: mass and volume', () => {
  it('E: mass input against a volume basis works with trusted density', async () => {
    const { body, itemNutrient } = await calc([{ food_id: F.milk, quantity: 257.5, unit: 'g' }]);
    expect(body.items[0]?.normalized_quantity).toMatchObject({ quantity: 257.5, unit: 'g' });
    expect(itemNutrient(0, 'protein').value).toBe(8.5);
    expect(itemNutrient(0, 'protein').source?.quantity_in_basis_unit).toBe(250);
  });

  it('F: without density it is unresolved — never 1 ml = 1 g', async () => {
    const { itemNutrient, agg } = await calc([{ food_id: F.juice, quantity: 200, unit: 'g' }]);
    expect(itemNutrient(0, 'carbohydrate')).toMatchObject({ status: 'basis_unreconcilable', value: null, conversion_reason: 'density_unavailable' });
    expect(agg('carbohydrate')).toMatchObject({ coverage: 'unavailable', value: null });

    const rice = await calc([{ food_id: F.rice, quantity: 200, unit: 'ml' }]);
    expect(rice.itemNutrient(0, 'energy')).toMatchObject({ status: 'basis_unreconcilable', value: null });
  });
});

describe('K-O, T, U: aggregation and completeness', () => {
  it('K/N/O: aggregates multiple foods with complete / partial / unavailable coverage', async () => {
    const { body, agg } = await calc([
      { food_id: F.rice, quantity: 150, unit: 'g' },
      { food_id: F.bread, quantity: 2, serving_id: SRV.breadSlice },
      { food_id: F.milk, quantity: 250, unit: 'ml' },
    ]);
    expect(body.aggregate.item_count).toBe(3);
    // energy: 195 + 159 + 160
    expect(agg('energy')).toMatchObject({ value: 514, coverage: 'complete', resolved_item_count: 3, item_count: 3 });
    // protein: 4.05 + 5.4 + 8.5
    expect(agg('protein')).toMatchObject({ value: 17.95, coverage: 'complete' });
    // iron only known for rice
    expect(agg('iron')).toMatchObject({ value: 1.8, coverage: 'partial', resolved_item_count: 1 });
    expect(agg('iron').missing).toEqual([
      { index: 1, status: 'no_data' },
      { index: 2, status: 'no_data' },
    ]);
    // fiber: rice + bread, not milk
    expect(agg('fiber')).toMatchObject({ coverage: 'partial', value: 2.22 });
    // complete: energy, protein, fat; partial: carbohydrate, fiber, iron, vitamin_d, sodium
    // every other vocabulary nutrient is known for none of the three foods
    expect(body.aggregate.coverage_summary).toEqual({ complete: 3, partial: 5, unavailable: VOCABULARY_SIZE - 8 });
  });

  it('M: vitamin D known for none of the foods is unavailable, not 0', async () => {
    const { agg } = await calc([
      { food_id: F.bread, quantity: 30, unit: 'g' },
      { food_id: F.juice, quantity: 200, unit: 'ml' },
    ]);
    expect(agg('vitamin_d')).toMatchObject({ coverage: 'unavailable', value: null, is_zero: false });
  });

  it('L: a known zero stays a known zero, distinct from unknown', async () => {
    const { itemNutrient, agg } = await calc([
      { food_id: F.rice, quantity: 100, unit: 'g' },
      { food_id: F.spinach, quantity: 100, unit: 'g' },
    ]);
    expect(itemNutrient(0, 'vitamin_d')).toMatchObject({ status: 'resolved', value: 0, is_zero: true });
    expect(agg('vitamin_d')).toMatchObject({ coverage: 'complete', value: 0, is_zero: true });
    // sodium: known zero for rice, unknown for spinach -> partial, not complete
    expect(agg('sodium')).toMatchObject({ coverage: 'partial', value: 0, is_zero: true });
  });

  it('T: energy is not fabricated from macros', async () => {
    const { itemNutrient, agg } = await calc([{ food_id: F.noEnergy, quantity: 100, unit: 'g' }]);
    expect(itemNutrient(0, 'protein').value).toBe(10);
    expect(itemNutrient(0, 'fat').value).toBe(5);
    expect(itemNutrient(0, 'energy')).toMatchObject({ status: 'no_data', value: null });
    expect(agg('energy')).toMatchObject({ coverage: 'unavailable', value: null });
  });

  it('U: no intermediate-rounding drift across items', async () => {
    const { itemNutrient, agg } = await calc([0, 1, 2].map(() => ({ food_id: F.thirds, quantity: 100, unit: 'g' })));
    expect([0, 1, 2].map((i) => itemNutrient(i, 'protein').value)).toEqual([0.333333, 0.333333, 0.333333]);
    expect(agg('protein')).toMatchObject({ value: 1, coverage: 'complete' });
  });
});

describe('P-S: source resolution, AI authority and provenance', () => {
  it('P/Q: competing trusted and label values are neither summed nor averaged — ambiguous', async () => {
    const { itemNutrient, agg } = await calc([{ food_id: F.competing, quantity: 100, unit: 'g' }]);
    const protein = itemNutrient(0, 'protein');
    expect(protein).toMatchObject({ status: 'ambiguous_nutrient_source', value: null, source: null });
    expect(protein.candidates.map((c) => c.source)).toEqual(['manufacturer_label', 'trusted_database']);
    expect(agg('protein')).toMatchObject({ value: null, coverage: 'unavailable', missing: [{ index: 0, status: 'ambiguous_nutrient_source' }] });
  });

  it('an ai_matched value beside a trusted one is excluded, the trusted value used', async () => {
    const { itemNutrient } = await calc([{ food_id: F.competing, quantity: 50, unit: 'g' }]);
    const energy = itemNutrient(0, 'energy');
    expect(energy).toMatchObject({ status: 'resolved', value: 100, source: { source: 'trusted_database' } });
    expect(energy.excluded).toEqual([expect.objectContaining({ source: 'ai_matched', reason: 'ai_matched_not_authoritative' })]);
  });

  it('R: an AI-matched identity with no trusted nutrition produces no nutrition at all', async () => {
    const search = await request(app).get('/v1/foods').query({ q: 'mystery snack' }).set('Authorization', auth());
    expect(search.body.data[0]).toMatchObject({ id: F.aiIdentity, match: { identity_confirmation_required: true } });

    const { body, itemNutrient, agg } = await calc([{ food_id: F.aiIdentity, quantity: 100, unit: 'g' }]);
    for (const n of body.items[0]?.nutrients ?? []) expect(n.value).toBeNull();
    expect(itemNutrient(0, 'energy')).toMatchObject({ status: 'not_authoritative', excluded: [{ source: 'ai_matched', reason: 'ai_matched_not_authoritative' }] });
    expect(itemNutrient(0, 'protein')).toMatchObject({ status: 'not_authoritative', excluded: [{ source: 'user_entered', reason: 'user_entered_not_permitted' }] });
    expect(body.aggregate.coverage_summary).toEqual({ complete: 0, partial: 0, unavailable: VOCABULARY_SIZE });
    expect(agg('energy').value).toBeNull();
  });

  it('S: the selected FoodNutrient, its source and basis survive into the result', async () => {
    const { rows } = await pool.query("select id from food_nutrient where food_id = $1 and nutrient_id = $2 and source = 'trusted_database'", [F.rice, NUT.protein]);
    const { itemNutrient } = await calc([{ food_id: F.rice, quantity: 150, unit: 'g' }]);
    expect(itemNutrient(0, 'protein').source).toEqual({
      food_nutrient_id: rows[0].id,
      source: 'trusted_database',
      authority: 'global_reference',
      amount_per_basis: 2.7,
      basis_quantity: 100,
      basis_unit: 'g',
      quantity_in_basis_unit: 150,
    });
  });
});

describe('V/W: input validation (invalid input is 400; insufficient reference data is not)', () => {
  const expect400 = async (items: Item[] | unknown) => {
    const res = await request(app).post('/v1/nutrition/calculate').set('Authorization', auth()).send({ items } as object);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    return res;
  };

  it('V: rejects zero, negative, non-numeric, oversized and non-finite quantities', async () => {
    for (const quantity of [0, -5, '100', null, 1_000_001]) await expect400([{ food_id: F.rice, quantity, unit: 'g' }]);
    const infinity = await request(app)
      .post('/v1/nutrition/calculate')
      .set('Authorization', auth())
      .set('Content-Type', 'application/json')
      .send(`{"items":[{"food_id":"${F.rice}","quantity":1e400,"unit":"g"}]}`);
    expect(infinity.status).toBe(400);
  });

  it('V: rejects unsupported, synonym, natural-language and ambiguous units', async () => {
    for (const unit of ['cup', 'tbsp', 'grams', 'handful', 'slice', '']) await expect400([{ food_id: F.rice, quantity: 1, unit }]);
  });

  it('V: rejects a malformed item list', async () => {
    await expect400([]);
    await expect400(Array.from({ length: 51 }, () => ({ food_id: F.rice, quantity: 1, unit: 'g' })));
    await expect400([{ food_id: F.rice, quantity: 1 }]);
    await expect400([{ food_id: F.rice, quantity: 1, unit: 'g', serving_id: SRV.breadSlice }]);
    await expect400([{ food_id: 'not-a-uuid', quantity: 1, unit: 'g' }]);
  });

  it('W: rejects an unknown serving, another food\'s serving and an unknown food', async () => {
    const unknown = await expect400([{ food_id: F.bread, quantity: 1, serving_id: '00000000-0000-4000-8000-00000000beef' }]);
    expect(unknown.body.error.details.issues[0].path).toBe('items.0.serving_id');
    const foreign = await expect400([
      { food_id: F.rice, quantity: 1, unit: 'g' },
      { food_id: F.rice, quantity: 1, serving_id: SRV.breadSlice },
    ]);
    expect(foreign.body.error.details.issues[0].path).toBe('items.1.serving_id');
    const food = await expect400([{ food_id: '00000000-0000-4000-8000-00000000f00d', quantity: 1, unit: 'g' }]);
    expect(food.body.error.details.issues[0].path).toBe('items.0.food_id');
  });
});

describe('X: the calculation API cannot mutate reference data and persists nothing', () => {
  it('leaves every food table, MealLog and Recipe unchanged', async () => {
    const before = await tableCounts();
    await calc([
      { food_id: F.rice, quantity: 150, unit: 'g' },
      { food_id: F.competing, quantity: 100, unit: 'g' },
      { food_id: F.aiIdentity, quantity: 100, unit: 'g' },
    ]);
    await calculate([{ food_id: F.rice, quantity: -1, unit: 'g' }]);
    expect(await tableCounts()).toEqual(before);
    const { rows } = await pool.query('select amount_per_canonical_unit from food_nutrient where food_id = $1 and nutrient_id = $2', [F.rice, NUT.protein]);
    expect(rows).toEqual([{ amount_per_canonical_unit: 2.7 }]);
  });

  it('exposes no other method on the nutrition route', async () => {
    for (const method of ['get', 'put', 'patch', 'delete'] as const) {
      const res = await request(app)[method]('/v1/nutrition/calculate').set('Authorization', auth());
      expect(res.status).toBe(404);
    }
  });

  it('any authenticated Account gets the same result for global reference data', async () => {
    const items = [{ food_id: F.rice, quantity: 150, unit: 'g' }];
    const [a, b] = await Promise.all([calculate(items, SEED.accountA), calculate(items, SEED.accountPediatric)]);
    expect(b.body).toEqual(a.body);
  });
});
