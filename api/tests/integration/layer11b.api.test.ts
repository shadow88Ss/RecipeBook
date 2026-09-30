// Layer 11B integration tests — Product & Barcode meal logging against the
// real migration chain and RLS harness. Products are trusted TEST FIXTURES
// (tests/helpers/productFixtures.ts); extra label versions are published
// here through publish_product_label_version() as trusted ingestion would.
// TEST FIXTURES ONLY — not production product, label or consumption data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app';
import { logger } from '../../src/lib/logger';
import { PgHarnessProfileRepository } from '../helpers/pgHarnessProfileRepository';
import { PgHarnessScopedDbFactory } from '../helpers/pgHarnessScopedDb';
import { rebuildTestDatabase } from '../helpers/testDb';
import { seedScenario, SEED } from '../helpers/seed';
import { F, NUT, seedNutritionFixtures } from '../helpers/nutritionFixtures';
import { addBarcode, BARCODE, LABEL, P, publishLabel, SERVING, seedProductFixtures } from '../helpers/productFixtures';
import { signTestToken, TEST_JWT_SECRET } from '../helpers/jwt';

let pool: Pool;
let app: ReturnType<typeof createApp>;

const as = (account: string) => ({
  get: (path: string, query: Record<string, string> = {}) => request(app).get(path).query(query).set('Authorization', `Bearer ${signTestToken(account)}`),
  post: (path: string, body: unknown) => request(app).post(path).set('Authorization', `Bearer ${signTestToken(account)}`).send(body as object),
});
const A = () => as(SEED.accountA);
const mealsOf = (profile: string) => `/v1/profiles/${profile}/meals`;
const PROFILE_A2 = 'b0b0b0b0-0000-4000-8000-0000000000a2'; // label-change history
const PROFILE_A3 = 'b0b0b0b0-0000-4000-8000-0000000000a3'; // mixed-source aggregation

// Products created by this file (trusted fixtures).
const LC = 'a11b0000-0000-4000-8000-000000000001'; // label change: v1 -> v2 (published in a test)
const EF = 'a11b0000-0000-4000-8000-000000000002'; // v2 published now, effective_from tomorrow
const RT = 'a11b0000-0000-4000-8000-000000000003'; // barcode retired after logging
const RT_CODE = '5901234123457'; // EAN-13, check digit valid

const UTC = 'UTC';
const dateOffset = (offset: number) => {
  const d = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const TODAY = () => dateOffset(0);
const YESTERDAY = () => dateOffset(-1);
/** Now: after every label published so far (the meal is logged live). */
const now = () => new Date().toISOString();
const YESTERDAY_NOON = () => `${YESTERDAY()}T12:00:00.000Z`;

type Summary = Record<string, { value: number | null; coverage: string; is_zero?: boolean }>;
type Snapshot = {
  snapshot_version: string;
  source: Record<string, unknown> & { type: string; label_version: { id: string; version_number: number }; label_version_selection: string };
  nutrients: Array<{ nutrient_key: string; coverage: string; status: string; value_exact: string | null }>;
  provenance: Record<string, unknown>;
};
const snapNutrient = (s: Snapshot, key: string) => s.nutrients.find((n) => n.nutrient_key === key) as Snapshot['nutrients'][number];

const product = (body: Record<string, unknown>) => ({ type: 'product', ...body });

async function logMeal(profile: string, items: unknown[], opts: { date?: string; consumed_at?: string; account?: string } = {}) {
  return as(opts.account ?? SEED.accountA).post(mealsOf(profile), {
    meal_type: 'snack',
    logged_date: opts.date ?? TODAY(),
    local_timezone: UTC,
    consumed_at: opts.consumed_at ?? now(),
    items,
  });
}

async function storedItem(id: string) {
  const { rows } = await pool.query(
    'select product_id, product_label_version_id, product_serving_id, logged_via_barcode_id, food_id, recipe_version_id, unit, quantity, nutrition_snapshot, nutrition_snapshot::text as snapshot_text from meal_item where id = $1',
    [id],
  );
  return rows[0] as Record<string, unknown> & { nutrition_snapshot: Snapshot; snapshot_text: string };
}

async function asAccountSql(account: string, sql: string, params: unknown[] = []) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("select set_config('request.jwt.claim.sub', $1, true)", [account]);
    await client.query('set local role authenticated');
    return await client.query(sql, params);
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
  }
}

const referenceState = async () =>
  (
    await pool.query(`select
      (select md5(coalesce(string_agg(to_jsonb(f)::text, ',' order by id), '')) from food f) as foods,
      (select md5(coalesce(string_agg(to_jsonb(n)::text, ',' order by id), '')) from food_nutrient n) as food_nutrients,
      (select md5(coalesce(string_agg(to_jsonb(s)::text, ',' order by id), '')) from food_serving s) as food_servings,
      (select md5(coalesce(string_agg(to_jsonb(p)::text, ',' order by id), '')) from product p) as products,
      (select md5(coalesce(string_agg(to_jsonb(l)::text, ',' order by id), '')) from product_label_version l) as labels,
      (select md5(coalesce(string_agg(to_jsonb(n)::text, ',' order by id), '')) from product_nutrient n) as product_nutrients,
      (select md5(coalesce(string_agg(to_jsonb(s)::text, ',' order by id), '')) from product_serving s) as product_servings,
      (select md5(coalesce(string_agg(to_jsonb(b)::text, ',' order by id), '')) from barcode b) as barcodes,
      (select md5(coalesce(string_agg(to_jsonb(g)::text, ',' order by id), '')) from grocery_list g) as grocery_lists,
      (select md5(coalesce(string_agg(to_jsonb(g)::text, ',' order by id), '')) from grocery_list_item g) as grocery_items,
      (select count(*)::int from meal_plan) as plans`)
  ).rows[0];

const LC_LABEL: { v1?: string; v2?: string; v1Serving?: string; v2Serving?: string } = {};
const EF_LABEL: { v1?: string; v2?: string } = {};

beforeAll(async () => {
  pool = await rebuildTestDatabase('recipebook_api_test_layer11b');
  await seedScenario(pool);
  await seedNutritionFixtures(pool);
  await seedProductFixtures(pool);
  for (const [pid, name] of [
    [PROFILE_A2, 'Profile A2'],
    [PROFILE_A3, 'Profile A3'],
  ]) {
    await pool.query("insert into profile (id, account_id, display_name, is_child) values ($1, $2, $3, false)", [pid, SEED.accountA, name]);
  }
  for (const [pid, name] of [
    [LC, 'Label Change Bar'],
    [EF, 'Effective Date Bar'],
    [RT, 'Retired Code Bar'],
  ]) {
    await pool.query(
      "insert into product (id, brand_name, product_name, package_quantity, package_unit, source, provenance_reference) values ($1, 'Fixture Brand L', $2, 50, 'g', 'manufacturer_data', 'fixture')",
      [pid, name],
    );
  }
  const n = (nutrient_id: string, amount: number) => ({ nutrient_id, amount, basis_quantity: 50, basis_unit: 'g' as const });
  LC_LABEL.v1 = await publishLabel(pool, LC, 'manufacturer_label', [n(NUT.energy, 200), n(NUT.protein, 10)], [{ serving_description: '1 bar', canonical_quantity: 50, canonical_unit: 'g' }]);
  LC_LABEL.v1Serving = (await pool.query('select id from product_serving where label_version_id = $1', [LC_LABEL.v1])).rows[0].id;
  EF_LABEL.v1 = await publishLabel(pool, EF, 'manufacturer_label', [n(NUT.energy, 180)], []);
  EF_LABEL.v2 = (
    await pool.query("select publish_product_label_version($1, 'manufacturer_label', 'fixture-v2', $2::date, $3, '[]') as id", [EF, dateOffset(1), JSON.stringify([n(NUT.energy, 150)])])
  ).rows[0].id;
  await publishLabel(pool, RT, 'manufacturer_label', [n(NUT.energy, 100)], []);
  await addBarcode(pool, RT, RT_CODE);
  app = createApp({ profileRepository: new PgHarnessProfileRepository(pool), scopedDbFactory: new PgHarnessScopedDbFactory(pool), jwtSecret: TEST_JWT_SECRET, logger });
}, 120_000);

afterAll(async () => {
  await pool.end();
});

let referenceBefore: unknown;
beforeAll(async () => {
  referenceBefore = await referenceState();
});

describe('A-E: logging an exact Product by id, barcode, quantity and ProductServing', () => {
  it('A/H/N: product_id + grams stores Product + exact label version and a server-generated snapshot', async () => {
    const res = await logMeal(SEED.profileA, [product({ product_id: P.bar, quantity: 90, unit: 'g' })]);
    expect(res.status).toBe(201);
    const item = res.body.items[0];
    expect(item).toMatchObject({
      source_type: 'product',
      food: null,
      recipe: null,
      product: {
        product_id: P.bar,
        brand_name: 'Fixture Brand Y',
        product_name: 'Protein Bar',
        variant_name: 'Chocolate',
        product_label_version_id: LABEL.bar,
        label_version_number: 1,
        label_authority: 'exact_product',
        label_version_selection: 'current_label',
        logged_via_barcode: null,
      },
      amount: { quantity: 90, unit: 'g', product_serving_id: null, serving_description: null },
      status: 'consumed',
      is_active: true,
    });
    expect(item.nutrition.summary.energy_kcal).toMatchObject({ value: 330, coverage: 'complete' }); // 220 kcal / 60 g x 90 g
    expect(item.nutrition.summary.protein_g).toMatchObject({ value: 30, coverage: 'complete' });

    const row = await storedItem(item.id);
    expect(row).toMatchObject({ product_id: P.bar, product_label_version_id: LABEL.bar, product_serving_id: null, food_id: null, recipe_version_id: null, unit: 'g' });
    const snap = row.nutrition_snapshot;
    expect(snap.snapshot_version).toBe('meal-item-snapshot-11b.1');
    expect(snap.source).toMatchObject({
      type: 'product',
      product_id: P.bar,
      label_version: { id: LABEL.bar, version_number: 1, nutrition_source: 'manufacturer_label', authority: 'exact_product' },
      label_version_selection: 'current_label',
      quantity: 90,
      unit: 'g',
      serving: null,
      barcode: null,
      product_nutrition_version: 'product-nutrition-11a.1',
      generic_food_fallback: 'none',
    });
    expect(snap.provenance).toMatchObject({ nutrition_scope: 'exact_product', generic_food_fallback: 'none', normalized_quantity: { status: 'converted', quantity: 90, unit: 'g' } });

    // identical to the Layer 11A calculator for the same input and label
    const calc = await A().post(`/v1/products/${P.bar}/nutrition/calculate`, { quantity: 90, unit: 'g' });
    expect(item.nutrition.summary).toEqual(calc.body.summary);
  });

  it('B: barcode + grams resolves Product and its current label server-side, keeping the barcode as provenance', async () => {
    const res = await logMeal(SEED.profileA, [product({ barcode: BARCODE.yogurtAE, quantity: 200, unit: 'g' })]);
    expect(res.status).toBe(201);
    const item = res.body.items[0];
    expect(item.product).toMatchObject({ product_id: P.yogurtAE, product_label_version_id: LABEL.yogurtAE, logged_via_barcode: { canonical_gtin: '04006381333931' } });
    expect(item.nutrition.summary.energy_kcal.value).toBe(194);
    const row = await storedItem(item.id);
    const barcodeId = (await pool.query("select id from barcode where gtin = '04006381333931'")).rows[0].id;
    expect(row.logged_via_barcode_id).toBe(barcodeId);
    expect(row.nutrition_snapshot.source.barcode).toEqual({
      barcode_id: barcodeId,
      canonical_gtin: '04006381333931',
      submitted_digits: BARCODE.yogurtAE,
      submitted_type: 'ean_13',
      rules_version: 'barcode-normalization-11a.1',
    });
  });

  it('C: UPC-A, its EAN-13 form and a UPC-E/UPC-A pair resolve the same Product', async () => {
    const res = await logMeal(SEED.profileA, [
      product({ barcode: BARCODE.yogurtUS, quantity: 100, unit: 'g' }),
      product({ barcode: `0${BARCODE.yogurtUS}`, quantity: 100, unit: 'g' }),
      product({ barcode: BARCODE.drinkUpcE, barcode_type: 'upc_e', quantity: 250, unit: 'ml' }),
      product({ barcode: '012345000065', quantity: 250, unit: 'ml' }),
    ]);
    expect(res.status).toBe(201);
    const [a, b, c, d] = res.body.items;
    expect(a.product.product_id).toBe(P.yogurtUS);
    expect(b.product.product_id).toBe(P.yogurtUS);
    expect(a.product.logged_via_barcode).toEqual(b.product.logged_via_barcode);
    expect(c.product.product_id).toBe(P.drink);
    expect(d.product.product_id).toBe(P.drink);
    expect(a.nutrition.summary).toEqual(b.nutrition.summary);
    expect(c.nutrition.summary.energy_kcal.value).toBe(120);
  });

  it('D/E/L: ProductServing x fractional count; a serving is the label serving, never the package', async () => {
    const res = await logMeal(SEED.profileA, [
      product({ product_id: P.bar, quantity: 1.5, product_serving_id: SERVING.bar }),
      product({ product_id: P.yogurtAE, quantity: 1, product_serving_id: SERVING.yogurtAE }),
    ]);
    expect(res.status).toBe(201);
    const [bar, yogurt] = res.body.items;
    expect(bar.amount).toMatchObject({ quantity: 1.5, unit: null, product_serving_id: SERVING.bar, serving_description: '1 bar' });
    expect(bar.nutrition.summary.energy_kcal.value).toBe(330); // 1.5 x 60 g
    // package 500 g, serving 150 g: one serving is 150 g (97 kcal/100 g -> 145.5), not 485
    expect(yogurt.nutrition.summary.energy_kcal.value).toBe(145.5);
    const snap = (await storedItem(yogurt.id)).nutrition_snapshot;
    expect(snap.source).toMatchObject({ package: { quantity: 500, unit: 'g' }, serving: { product_serving_id: SERVING.yogurtAE, canonical_quantity: 150, canonical_unit: 'g' } });
    expect(snap.provenance).toMatchObject({ normalized_quantity: { status: 'converted', quantity: 150, unit: 'g' } });
  });
});

describe('F/G, I-K: references, completeness and no Food fallback', () => {
  it('F: a ProductServing of another Product is rejected', async () => {
    const res = await logMeal(SEED.profileA, [product({ product_id: P.bar, quantity: 1, product_serving_id: SERVING.yogurtAE })]);
    expect(res.status).toBe(400);
    expect(res.body.error.details.issues).toEqual([expect.objectContaining({ path: 'items.0.product_serving_id' })]);
  });

  it('I/K/J: generic Food data never fills a label gap; a label 0 is a known zero; incomplete labels stay partial', async () => {
    const res = await logMeal(SEED.profileA, [
      product({ product_id: P.yogurtAE, quantity: 100, unit: 'g' }), // generic Food milk has vitamin D and fiber? label has neither
      product({ product_id: P.yogurtUS, quantity: 100, unit: 'g' }), // label: energy + protein only
    ]);
    expect(res.status).toBe(201);
    const [ae, us] = res.body.items;
    const aeSnap = (await storedItem(ae.id)).nutrition_snapshot;
    expect(snapNutrient(aeSnap, 'vitamin_d')).toMatchObject({ coverage: 'unavailable', status: 'no_data', value_exact: null }); // milk has 1.1 µg/100 ml: never used
    expect(snapNutrient(aeSnap, 'fiber')).toMatchObject({ coverage: 'unavailable', value_exact: null });
    expect(snapNutrient(aeSnap, 'fat')).toMatchObject({ coverage: 'complete', status: 'resolved', value_exact: '0/1' });
    expect(ae.nutrition.summary.fat_g).toMatchObject({ value: 0, is_zero: true, coverage: 'complete' });
    expect(us.nutrition.summary.fat_g).toMatchObject({ value: null, coverage: 'unavailable' });
    const meal = await A().get(`${mealsOf(SEED.profileA)}/${res.body.id}/nutrition`);
    expect(meal.body.summary.fat_g).toMatchObject({ value: 0, coverage: 'partial' }); // known 0 + unknown = partial, never 0-complete
    expect(meal.body.summary.energy_kcal).toMatchObject({ value: 197, coverage: 'complete' });
  });

  it('I/§12: a volume-labelled product logged by mass is unresolved — generic Food density is never borrowed', async () => {
    const res = await logMeal(SEED.profileA, [product({ product_id: P.drink, quantity: 250, unit: 'g' })]);
    expect(res.status).toBe(201);
    const snap = (await storedItem(res.body.items[0].id)).nutrition_snapshot;
    expect(snapNutrient(snap, 'energy')).toMatchObject({ coverage: 'unavailable', status: 'basis_unreconcilable', value_exact: null });
    expect(res.body.items[0].nutrition.summary.energy_kcal).toMatchObject({ value: null, coverage: 'unavailable' });
  });

  it('a non-authoritative (third-party) label is recorded as not_authoritative, never as values', async () => {
    const res = await logMeal(SEED.profileA, [product({ product_id: P.granola, quantity: 45, unit: 'g' })]);
    expect(res.status).toBe(201);
    const snap = (await storedItem(res.body.items[0].id)).nutrition_snapshot;
    expect(snapNutrient(snap, 'energy')).toMatchObject({ coverage: 'unavailable', status: 'not_authoritative', value_exact: null });
    expect(res.body.items[0].product.label_authority).toBe('non_authoritative_product_source');
  });

  it('a Product with no label version cannot be logged (409); nothing is written', async () => {
    const before = (await pool.query('select count(*)::int as n from meal_item')).rows[0].n;
    const res = await logMeal(SEED.profileA, [product({ product_id: P.crackers, quantity: 30, unit: 'g' })]);
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe('product_has_no_label_version');
    expect((await pool.query('select count(*)::int as n from meal_item')).rows[0].n).toBe(before);
  });

  it('request shape: exactly one of product_id | barcode and of unit | product_serving_id', async () => {
    for (const body of [
      { product_id: P.bar, barcode: BARCODE.yogurtAE, quantity: 1, unit: 'g' },
      { quantity: 1, unit: 'g' },
      { product_id: P.bar, quantity: 1 },
      { product_id: P.bar, quantity: 1, unit: 'g', product_serving_id: SERVING.bar },
      { product_id: P.bar, quantity: 0, unit: 'g' },
      { product_id: P.bar, barcode_type: 'ean_8', quantity: 1, unit: 'g' },
    ]) {
      expect((await logMeal(SEED.profileA, [product(body)])).status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('AE-AG: barcode input rules (Layer 11A lookup)', () => {
  it('AE: an invalid barcode is rejected with its reason', async () => {
    const res = await logMeal(SEED.profileA, [product({ barcode: '4006381333932', quantity: 1, unit: 'g' })]);
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe('invalid_check_digit');
    expect(res.body.error.details.issues[0].path).toBe('items.0.barcode');
    const ambiguous = await logMeal(SEED.profileA, [product({ barcode: BARCODE.bar, quantity: 1, unit: 'g' })]);
    expect(ambiguous.status).toBe(400);
    expect(ambiguous.body.error.details.reason).toBe('ambiguous_format');
  });

  it('AF: a valid but unknown barcode is a safe 404 and writes nothing', async () => {
    const res = await logMeal(SEED.profileA, [product({ barcode: '4006381333948', quantity: 1, unit: 'g' })]);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/select|meal_item|product_id/i);
  });

  it('AG: a retired barcode cannot start new logging; items logged through it keep Product, label and nutrition', async () => {
    const logged = await logMeal(SEED.profileA, [product({ barcode: RT_CODE, quantity: 50, unit: 'g' })]);
    expect(logged.status).toBe(201);
    const itemId = logged.body.items[0].id;
    const before = await storedItem(itemId);
    await pool.query("update barcode set status = 'retired', retired_at = now(), retired_reason = 'fixture retirement' where gtin = $1", [`0${RT_CODE}`]);

    const res = await logMeal(SEED.profileA, [product({ barcode: RT_CODE, quantity: 50, unit: 'g' })]);
    expect(res.status).toBe(404);
    const after = await storedItem(itemId);
    expect(after.snapshot_text).toBe(before.snapshot_text);
    expect(after.logged_via_barcode_id).toBe(before.logged_via_barcode_id);
    const read = await A().get(`${mealsOf(SEED.profileA)}/${logged.body.id}/items/${itemId}`);
    expect(read.body.product).toMatchObject({ product_id: RT, logged_via_barcode: { canonical_gtin: `0${RT_CODE}` } });
    expect(read.body.nutrition.summary.energy_kcal.value).toBe(100);
    // the Product itself can still be logged by id
    expect((await logMeal(SEED.profileA, [product({ product_id: RT, quantity: 50, unit: 'g' })])).status).toBe(201);
    // and the database refuses a retired barcode as provenance
    const retiredId = (await pool.query('select id from barcode where gtin = $1', [`0${RT_CODE}`])).rows[0].id;
    const labelId = (await pool.query('select current_label_version_id as id from product where id = $1', [RT])).rows[0].id;
    await expect(
      pool.query(
        "insert into meal_item (meal_log_id, profile_id, product_id, product_label_version_id, logged_via_barcode_id, unit, quantity, status, consumed_at, status_changed_by_account_id, nutrition_snapshot, nutrition_calculation_version, nutrition_calculated_at) values ($1, $2, $3, $4, $5, 'g', 1, 'consumed', now(), $6, '{}', 'v', now())",
        [logged.body.id, SEED.profileA, RT, labelId, retiredId, SEED.accountA],
      ),
    ).rejects.toThrow(/retired barcode cannot be used to log/);
  });
});

describe('R/S/T + G + G1/G2: label version history', () => {
  let mealId: string;
  let itemId: string;
  let snapshotText: string;
  let trackerBefore: unknown;
  let progressBefore: unknown;
  const tracker = () => A().get(`/v1/profiles/${PROFILE_A2}/daily-tracker`, { date: TODAY(), timezone: UTC });
  const progress = () => A().get(`/v1/profiles/${PROFILE_A2}/progress`, { from: YESTERDAY(), to: TODAY(), timezone: UTC });

  it('1-3: logs the Product at label v1 and captures the snapshot, tracker and progress', async () => {
    await A().post(`/v1/profiles/${PROFILE_A2}/nutrition-targets`, { field_name: 'energy', value: 2000, unit: 'kcal' });
    const res = await logMeal(PROFILE_A2, [product({ product_id: LC, quantity: 1, product_serving_id: LC_LABEL.v1Serving })]);
    expect(res.status).toBe(201);
    mealId = res.body.id;
    itemId = res.body.items[0].id;
    expect(res.body.items[0].product).toMatchObject({ product_label_version_id: LC_LABEL.v1, label_version_number: 1 });
    expect(res.body.items[0].nutrition.summary.energy_kcal.value).toBe(200);
    snapshotText = (await storedItem(itemId)).snapshot_text;
    const t = await tracker();
    expect(t.status).toBe(200);
    expect(t.body.actual.summary.energy_kcal.value).toBe(200);
    trackerBefore = t.body.actual;
    const p = await progress();
    expect(p.status).toBe(200);
    progressBefore = p.body.nutrition_adherence;
  });

  it('4-10 (R/S/T): publishing label v2 changes the current label, never the historical item, tracker or progress', async () => {
    LC_LABEL.v2 = await publishLabel(pool, LC, 'manufacturer_label', [{ nutrient_id: NUT.energy, amount: 250, basis_quantity: 50, basis_unit: 'g' }], [
      { serving_description: '1 bar', canonical_quantity: 50, canonical_unit: 'g' },
    ]);
    LC_LABEL.v2Serving = (await pool.query('select id from product_serving where label_version_id = $1', [LC_LABEL.v2])).rows[0].id;
    const current = await A().get(`/v1/products/${LC}`);
    expect(current.body.current_label).toMatchObject({ id: LC_LABEL.v2, version_number: 2 });

    const read = await A().get(`${mealsOf(PROFILE_A2)}/${mealId}/items/${itemId}`);
    expect(read.body.product).toMatchObject({ product_label_version_id: LC_LABEL.v1, label_version_number: 1 });
    expect(read.body.nutrition.summary.energy_kcal.value).toBe(200);
    const row = await storedItem(itemId);
    expect(row.product_label_version_id).toBe(LC_LABEL.v1);
    expect(row.snapshot_text).toBe(snapshotText); // byte-for-byte
    expect((await tracker()).body.actual).toEqual(trackerBefore);
    expect((await progress()).body.nutrition_adherence).toEqual(progressBefore);

    // a new live log uses v2
    const fresh = await logMeal(SEED.profileA, [product({ product_id: LC, quantity: 1, product_serving_id: LC_LABEL.v2Serving })]);
    expect(fresh.status).toBe(201);
    expect(fresh.body.items[0].product).toMatchObject({ product_label_version_id: LC_LABEL.v2, label_version_selection: 'current_label' });
    expect(fresh.body.items[0].nutrition.summary.energy_kcal.value).toBe(250);
  });

  it('23: a Product display edit changes no historical nutrition', async () => {
    await pool.query("update product set product_name = 'Label Change Bar (renamed)' where id = $1", [LC]);
    const row = await storedItem(itemId);
    expect(row.snapshot_text).toBe(snapshotText);
    const read = await A().get(`${mealsOf(PROFILE_A2)}/${mealId}/items/${itemId}`);
    expect(read.body.product.product_name).toBe('Label Change Bar'); // as recorded
    await pool.query("update product set product_name = 'Label Change Bar' where id = $1", [LC]);
  });

  it('G: a ProductServing of another label version of the same Product is rejected', async () => {
    const res = await logMeal(SEED.profileA, [product({ product_id: LC, quantity: 1, product_serving_id: LC_LABEL.v1Serving })]);
    expect(res.status).toBe(400);
    expect(res.body.error.details.issues[0]).toMatchObject({ path: 'items.0.product_serving_id', message: expect.stringMatching(/label version 2/) });
  });

  it('G1: label_version_id is refused when the current label applies; the database refuses a replaced label', async () => {
    const res = await logMeal(SEED.profileA, [product({ product_id: LC, quantity: 50, unit: 'g', label_version_id: LC_LABEL.v1 })]);
    expect(res.status).toBe(400);
    expect(res.body.error.details.issues[0].path).toBe('items.0.label_version_id');
    // the current label named explicitly is accepted
    expect((await logMeal(SEED.profileA, [product({ product_id: LC, quantity: 50, unit: 'g', label_version_id: LC_LABEL.v2 })])).status).toBe(201);
    // direct RPC with an old label, bypassing the API, is refused by the database
    const payload = {
      meal: { meal_type: 'snack', logged_date: TODAY(), local_timezone: UTC },
      items: [{ product_id: LC, product_label_version_id: LC_LABEL.v1, unit: 'g', quantity: 50, consumed_at: now(), nutrition_snapshot: {}, nutrition_calculation_version: 'v' }],
    };
    await expect(asAccountSql(SEED.accountA, 'select log_meal_items($1, null, $2)', [SEED.profileA, payload])).rejects.toThrow(/replaced before consumed_at/);
  });

  it('G1: a backdated log with an ambiguous label asks for confirmation, then stores the confirmed exact label', async () => {
    const item = product({ product_id: LC, quantity: 1, product_serving_id: LC_LABEL.v1Serving });
    const ask = await logMeal(SEED.profileA, [item], { date: YESTERDAY(), consumed_at: YESTERDAY_NOON() });
    expect(ask.status).toBe(409);
    expect(ask.body.error.details.reason).toBe('label_version_confirmation_required');
    const [detail] = ask.body.error.details.items;
    expect(detail).toMatchObject({ path: 'items.0', product_id: LC, current_label_version_id: LC_LABEL.v2, suggested_label_version_id: null });
    expect(detail.candidates.map((c: { id: string }) => c.id)).toEqual([LC_LABEL.v1, LC_LABEL.v2]);
    expect(detail.candidates[0]).toMatchObject({ version_number: 1, servings: [expect.objectContaining({ id: LC_LABEL.v1Serving })], nutrition_for_input: expect.objectContaining({ energy_kcal: expect.objectContaining({ value: 200 }) }) });
    expect(detail.candidates[1].nutrition_for_input).toBeNull(); // the v1 serving does not exist on v2

    const confirmed = await logMeal(SEED.profileA, [{ ...item, label_version_id: LC_LABEL.v1 }], { date: YESTERDAY(), consumed_at: YESTERDAY_NOON() });
    expect(confirmed.status).toBe(201);
    expect(confirmed.body.items[0].product).toMatchObject({ product_label_version_id: LC_LABEL.v1, label_version_selection: 'user_confirmed_backdated' });
    expect((await storedItem(confirmed.body.items[0].id)).nutrition_snapshot.source.label_version_selection).toBe('user_confirmed_backdated');

    // a label of another Product is not a candidate
    const wrong = await logMeal(SEED.profileA, [product({ product_id: LC, quantity: 50, unit: 'g', label_version_id: LABEL.bar })], { date: YESTERDAY(), consumed_at: YESTERDAY_NOON() });
    expect(wrong.status).toBe(400);
  });

  it('G1: a Product that has only ever had one label is deterministic when backdated', async () => {
    const res = await logMeal(SEED.profileA, [product({ product_id: P.bar, quantity: 60, unit: 'g' })], { date: YESTERDAY(), consumed_at: YESTERDAY_NOON() });
    expect(res.status).toBe(201);
    expect(res.body.items[0].product).toMatchObject({ product_label_version_id: LABEL.bar, label_version_selection: 'current_label' });
  });

  it('G1: a current label not yet in effect (effective_from tomorrow) is not assumed, even for a live log', async () => {
    const ask = await logMeal(SEED.profileA, [product({ product_id: EF, quantity: 50, unit: 'g' })]);
    expect(ask.status).toBe(409);
    const [detail] = ask.body.error.details.items;
    expect(detail.candidates.map((c: { id: string }) => c.id)).toEqual([EF_LABEL.v1, EF_LABEL.v2]);
    expect(detail.suggested_label_version_id).toBe(EF_LABEL.v1);
    const ok = await logMeal(SEED.profileA, [product({ product_id: EF, quantity: 50, unit: 'g', label_version_id: EF_LABEL.v1 })]);
    expect(ok.status).toBe(201);
    expect(ok.body.items[0].nutrition.summary.energy_kcal.value).toBe(180);
  });

  it('P/Q/G2: a quantity correction after label v2 keeps the original v1 label; the original is preserved', async () => {
    const res = await A().post(`${mealsOf(PROFILE_A2)}/${mealId}/items/${itemId}/correct`, {
      correction_reason: 'ate one and a half',
      item: product({ product_id: LC, quantity: 1.5, product_serving_id: LC_LABEL.v1Serving }),
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      source_type: 'product',
      product: { product_label_version_id: LC_LABEL.v1, label_version_selection: 'correction_original_label' },
      amount: { quantity: 1.5, product_serving_id: LC_LABEL.v1Serving },
      correction: { corrects_meal_item_id: itemId, superseded_by_meal_item_id: null, correction_reason: 'ate one and a half' },
    });
    expect(res.body.nutrition.summary.energy_kcal.value).toBe(300); // 1.5 x v1's 200, not v2's 250
    const original = await storedItem(itemId);
    expect(original.snapshot_text).toBe(snapshotText);
    const originalDto = await A().get(`${mealsOf(PROFILE_A2)}/${mealId}/items/${itemId}`);
    expect(originalDto.body).toMatchObject({ is_active: false, correction: { superseded_by_meal_item_id: res.body.id } });
    const audit = await pool.query("select event_payload from audit_event where event_type = 'meal_item_corrected' and subject_id = $1", [itemId]);
    expect(audit.rows).toHaveLength(1);
    // the tracker counts the correction once
    expect((await tracker()).body.actual.summary.energy_kcal.value).toBe(300);
  });

  it('G2: correcting to another Product selects that Product\'s label by the G1 rules; Product -> Food works too', async () => {
    const meal = await logMeal(SEED.profileA, [product({ product_id: P.bar, quantity: 60, unit: 'g' })]);
    const toOther = await A().post(`${mealsOf(SEED.profileA)}/${meal.body.id}/items/${meal.body.items[0].id}/correct`, {
      correction_reason: 'it was the yogurt',
      item: product({ product_id: P.yogurtAE, quantity: 150, unit: 'g' }),
    });
    expect(toOther.status).toBe(201);
    expect(toOther.body.product).toMatchObject({ product_id: P.yogurtAE, product_label_version_id: LABEL.yogurtAE, label_version_selection: 'current_label' });
    const toFood = await A().post(`${mealsOf(SEED.profileA)}/${meal.body.id}/items/${toOther.body.id}/correct`, {
      correction_reason: 'it was plain milk',
      item: { type: 'food', food_id: F.milk, quantity: 150, unit: 'ml' },
    });
    expect(toFood.status).toBe(201);
    expect(toFood.body).toMatchObject({ source_type: 'food', product: null, food: { food_id: F.milk } });
    const toProduct = await A().post(`${mealsOf(SEED.profileA)}/${meal.body.id}/items/${toFood.body.id}/correct`, {
      correction_reason: 'no, the bar after all',
      item: product({ barcode: BARCODE.barCase, quantity: 1, product_serving_id: SERVING.bar }),
    });
    expect(toProduct.status).toBe(201);
    expect(toProduct.body).toMatchObject({ source_type: 'product', product: { product_id: P.bar, logged_via_barcode: { canonical_gtin: BARCODE.barCase } } });
  });
});

describe('M-O: snapshot authority and immutability', () => {
  const forged = { snapshot_version: 'forged', nutrients: [{ nutrient_key: 'energy', value_exact: '1/1' }], source: { type: 'product' } };

  it('M/N: client nutrition fields are stripped; the snapshot is computed by the server', async () => {
    const res = await as(SEED.accountA).post(mealsOf(SEED.profileA), {
      meal_type: 'snack',
      logged_date: TODAY(),
      local_timezone: UTC,
      consumed_at: now(),
      nutrition_snapshot: forged,
      items: [product({ product_id: P.bar, quantity: 60, unit: 'g', nutrition_snapshot: forged, nutrition_calculation_version: 'forged', energy_kcal: 1, product_label_version_id: LABEL.yogurtAE })],
    });
    expect(res.status).toBe(201);
    const row = await storedItem(res.body.items[0].id);
    expect(row.product_label_version_id).toBe(LABEL.bar);
    expect(row.nutrition_snapshot.snapshot_version).toBe('meal-item-snapshot-11b.1');
    expect(res.body.items[0].nutrition.summary.energy_kcal.value).toBe(220);
    expect(res.body.items[0].nutrition.calculation_version).toBe('nutrition-calculation-5b.1');
  });

  it('O: a consumed Product item cannot be edited — not its label, quantity or snapshot', async () => {
    const res = await logMeal(SEED.profileA, [product({ product_id: P.bar, quantity: 60, unit: 'g' })]);
    const id = res.body.items[0].id;
    for (const set of ["quantity = 2", "nutrition_snapshot = '{}'", `product_label_version_id = '${LABEL.bar}'`, 'logged_via_barcode_id = null', "product_id = null"]) {
      await expect(pool.query(`update meal_item set ${set} where id = $1`, [id])).rejects.toThrow(/immutable|violates/);
    }
  });
});

describe('Database invariants for Product items (B, 26)', () => {
  let mealId: string;
  let recipeVersionId: string;
  beforeAll(async () => {
    mealId = (await logMeal(SEED.profileA, [])).body.id;
    const recipe = await A().post(`/v1/profiles/${SEED.profileA}/recipes`, { title: 'Fixture Plain Rice', servings: 1, ingredients: [{ text: '100 g rice', food_id: F.rice, quantity: 100, unit: 'g' }] });
    recipeVersionId = recipe.body.current_version.id;
  });
  const insert = (cols: string, vals: string, params: unknown[]) =>
    pool.query(
      `insert into meal_item (meal_log_id, profile_id, quantity, status, consumed_at, status_changed_by_account_id, nutrition_snapshot, nutrition_calculation_version, nutrition_calculated_at, ${cols}) values ($1, $2, 1, 'consumed', now(), $3, '{}', 'v', now(), ${vals})`,
      [mealId, SEED.profileA, SEED.accountA, ...params],
    );

  it('exactly one source; a Product always carries its exact label version and one amount form', async () => {
    await expect(insert('product_id, unit', "$4, 'g'", [P.bar])).rejects.toThrow(/meal_item_product_label_version/);
    await expect(insert('product_id, product_label_version_id, food_id, unit', "$4, $5, $6, 'g'", [P.bar, LABEL.bar, F.rice])).rejects.toThrow(/meal_item_single_source|meal_item_consumed_has_source/);
    await expect(insert('product_id, product_label_version_id, recipe_version_id', '$4, $5, $6', [P.bar, LABEL.bar, recipeVersionId])).rejects.toThrow(/meal_item_single_source|meal_item_consumed_has_source/);
    await expect(insert('product_id, product_label_version_id', '$4, $5', [P.bar, LABEL.bar])).rejects.toThrow(/meal_item_consumed_product_amount/);
    await expect(insert('product_id, product_label_version_id, unit, product_serving_id', "$4, $5, 'g', $6", [P.bar, LABEL.bar, SERVING.bar])).rejects.toThrow(/meal_item_product_unit_xor_serving|meal_item_consumed_product_amount/);
    await expect(insert('food_id, product_serving_id, unit', "$4, $5, 'g'", [F.rice, SERVING.bar])).rejects.toThrow(/meal_item_product_serving_requires_product/);
  });

  it('26: a label version of another Product, and a serving of another label version, are refused', async () => {
    await expect(insert('product_id, product_label_version_id, unit', "$4, $5, 'g'", [P.bar, LABEL.yogurtAE])).rejects.toThrow(/fk_meal_item_product_label_version/);
    await expect(insert('product_id, product_label_version_id, product_serving_id', '$4, $5, $6', [LC, LC_LABEL.v2, LC_LABEL.v1Serving])).rejects.toThrow(/fk_meal_item_product_serving_label/);
    const barcodeOfYogurt = (await pool.query("select id from barcode where gtin = '04006381333931'")).rows[0].id;
    await expect(insert('product_id, product_label_version_id, unit, logged_via_barcode_id', "$4, $5, 'g', $6", [P.bar, LABEL.bar, barcodeOfYogurt])).rejects.toThrow(/fk_meal_item_logged_via_barcode/);
  });

  it('26: clients still have no write access to Product reference tables', async () => {
    await expect(asAccountSql(SEED.accountA, "update product set product_name = 'x' where id = $1", [P.bar])).rejects.toThrow(/permission denied/);
    await expect(asAccountSql(SEED.accountA, 'delete from product_label_version where id = $1', [LABEL.bar])).rejects.toThrow(/permission denied/);
    await expect(asAccountSql(SEED.accountA, "insert into product_serving (label_version_id, product_id, serving_description, canonical_quantity, canonical_unit, source) values ($1, $2, 'x', 1, 'g', 'manufacturer_label')", [LABEL.bar, P.bar])).rejects.toThrow(/permission denied/);
  });
});

describe('U + N/O(17/18): Food + Recipe + Product aggregate from snapshots', () => {
  it('U: a meal and a day mixing all three sources sum exactly; progress uses the same snapshots', async () => {
    const recipe = await A().post(`/v1/profiles/${PROFILE_A3}/recipes`, {
      title: 'Fixture Rice Bowl',
      servings: 2,
      ingredients: [{ text: '200 g rice', food_id: F.rice, quantity: 200, unit: 'g' }],
    });
    expect(recipe.status).toBe(201);
    const res = await logMeal(PROFILE_A3, [
      { type: 'food', food_id: F.rice, quantity: 150, unit: 'g' },
      { type: 'recipe', recipe_id: recipe.body.id, recipe_version_id: recipe.body.current_version.id, servings: 1 },
      product({ product_id: P.bar, quantity: 60, unit: 'g' }),
    ]);
    expect(res.status).toBe(201);
    expect(res.body.items.map((i: { source_type: string }) => i.source_type)).toEqual(['food', 'recipe', 'product']);
    const protein = res.body.items.map((i: { nutrition: { summary: Summary } }) => i.nutrition.summary.protein_g?.value as number);
    const expected = Math.round(protein.reduce((a: number, b: number) => a + b, 0) * 1e6) / 1e6;
    expect(res.body.nutrition.summary.protein_g.value).toBeCloseTo(expected, 6);
    expect(protein[2]).toBe(20);

    const tracker = await A().get(`/v1/profiles/${PROFILE_A3}/daily-tracker`, { date: TODAY(), timezone: UTC });
    expect(tracker.status).toBe(200);
    expect(tracker.body.actual.summary.protein_g.value).toBeCloseTo(expected, 6);
    const groups = JSON.stringify(tracker.body.meal_groups ?? tracker.body);
    expect(groups).toContain('"source_type":"product"');

    await A().post(`/v1/profiles/${PROFILE_A3}/nutrition-targets`, { field_name: 'protein', value: 100, unit: 'g' });
    const progress = await A().get(`/v1/profiles/${PROFILE_A3}/progress`, { from: TODAY(), to: TODAY(), timezone: UTC });
    expect(progress.status).toBe(200);
    expect(JSON.stringify(progress.body)).not.toMatch(/product_nutrient|label_version/); // no Product-specific progress path
  });
});

describe('V-X: no reference, FoodNutrient or grocery writes', () => {
  it('V/W/X: all Product logging above created no FoodNutrient/FoodServing, no Product reference rows, no grocery state', async () => {
    const after = await referenceState();
    const before = referenceBefore as Record<string, unknown>;
    expect(after.food_nutrients).toBe(before.food_nutrients);
    expect(after.food_servings).toBe(before.food_servings);
    expect(after.foods).toBe(before.foods);
    expect(after.grocery_lists).toBe(before.grocery_lists);
    expect(after.grocery_items).toBe(before.grocery_items);
    expect(after.plans).toBe(before.plans);
    // Product tables changed only through the trusted fixture steps in this file
    // (label v2 publication, a barcode retirement, a display rename + revert).
    const { rows } = await pool.query(
      "select (select count(*)::int from product_nutrient) as nutrients, (select count(*)::int from product_serving) as servings, (select count(*)::int from product) as products, (select count(*)::int from barcode) as barcodes",
    );
    expect(rows[0]).toEqual({ nutrients: 15 + 6, servings: 6, products: 9, barcodes: 6 });
  });
});

describe('Y-AD: authorization follows the existing meal RLS', () => {
  const childItem = () => product({ product_id: P.bar, quantity: 1, product_serving_id: SERVING.bar });

  it('AB: full_management logs and corrects a Product for the child', async () => {
    const res = await logMeal(SEED.profileChild, [childItem()], { account: SEED.accountFullManagement });
    expect(res.status).toBe(201);
    const fixed = await as(SEED.accountFullManagement).post(`${mealsOf(SEED.profileChild)}/${res.body.id}/items/${res.body.items[0].id}/correct`, {
      correction_reason: 'half',
      item: product({ product_id: P.bar, quantity: 0.5, product_serving_id: SERVING.bar }),
    });
    expect(fixed.status).toBe(201);
    expect(fixed.body.nutrition.summary.energy_kcal.value).toBe(110);
  });

  it('AC/27: pediatric_weight_management logs a Product factually — no advice, targets or interpretation', async () => {
    const res = await logMeal(SEED.profileChild, [childItem()], { account: SEED.accountPediatric });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toMatch(/advice|recommend|deficit|restrict|weight_loss/i);
  });

  it('AA: view_only reads Product items but cannot log (403)', async () => {
    const v = as(SEED.accountViewOnly);
    expect((await v.get(mealsOf(SEED.profileChild))).status).toBe(200);
    expect((await logMeal(SEED.profileChild, [childItem()], { account: SEED.accountViewOnly })).status).toBe(403);
  });

  it('Z/Y: a revoked guardian and an unrelated Account get 404', async () => {
    expect((await logMeal(SEED.profileChild, [childItem()], { account: SEED.accountRevoked })).status).toBe(404);
    expect((await logMeal(SEED.profileA, [childItem()], { account: SEED.accountUnrelated })).status).toBe(404);
    expect((await logMeal(SEED.profileA, [childItem()], { account: SEED.accountB })).status).toBe(404);
  });

  it('AD: a Product item cannot be injected into another Profile\'s MealLog', async () => {
    const a2Meal = (await logMeal(PROFILE_A2, [])).body.id;
    // via another profile's URL
    expect((await A().post(`${mealsOf(SEED.profileA)}/${a2Meal}/items`, { consumed_at: now(), items: [childItem()] })).status).toBe(404);
    // by account B through the RPC
    await expect(
      asAccountSql(SEED.accountB, 'select log_meal_items($1, $2, $3)', [SEED.profileA, a2Meal, { items: [] }]),
    ).rejects.toThrow(/meal log not found|row-level security/);
    // database: profile_id must match the MealLog's
    await expect(
      pool.query(
        "insert into meal_item (meal_log_id, profile_id, product_id, product_label_version_id, unit, quantity, status, consumed_at, status_changed_by_account_id, nutrition_snapshot, nutrition_calculation_version, nutrition_calculated_at) values ($1, $2, $3, $4, 'g', 1, 'consumed', now(), $5, '{}', 'v', now())",
        [a2Meal, SEED.profileB, P.bar, LABEL.bar, SEED.accountB],
      ),
    ).rejects.toThrow(/fk_meal_item_meal_log_profile/);
  });
});
