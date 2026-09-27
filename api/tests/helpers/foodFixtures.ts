// TEST FIXTURES ONLY — NOT PRODUCTION FOOD DATA.
//
// Every value below is illustrative, chosen to exercise search ranking,
// locale fallback, region-aware servings, provenance and conversion paths.
// None of it is sourced from, or may be used as, an authoritative food or
// nutrient database (Master §16). canonical_name values are prefixed
// `fixture_` so they can never be mistaken for real reference rows.
//
// Inserted directly as the `postgres` superuser (bypassing RLS), the same
// way tests/helpers/seed.ts seeds Layer 4 data: food reference data has no
// client write path, by design.

import type { Pool } from 'pg';

export const FOOD = {
  chickpeas: 'f5a00000-0000-4000-8000-000000000001',
  flour: 'f5a00000-0000-4000-8000-000000000002',
  chickenBreast: 'f5a00000-0000-4000-8000-000000000003',
  chickpeaFlour: 'f5a00000-0000-4000-8000-000000000004',
  aiOnly: 'f5a00000-0000-4000-8000-000000000005',
  percentFood: 'f5a00000-0000-4000-8000-000000000006',
  /** No FoodAlias at all — reachable only through canonical_name search. */
  lentils: 'f5a00000-0000-4000-8000-000000000007',
  lentilSoup: 'f5a00000-0000-4000-8000-000000000008',
} as const;

export const SERVING = {
  flourCupUs: 'f5a10000-0000-4000-8000-000000000001',
  flourCupAu: 'f5a10000-0000-4000-8000-000000000002',
  flourTbsp: 'f5a10000-0000-4000-8000-000000000003',
  chickpeasCan: 'f5a10000-0000-4000-8000-000000000004',
  chickenPiece: 'f5a10000-0000-4000-8000-000000000005',
  aiScoop: 'f5a10000-0000-4000-8000-000000000006',
} as const;

/** Ids of the canonical vocabulary rows seeded by
 * 20260929120000_nutrient_vocabulary_and_authority.sql — filled in by
 * seedFoodFixtures(), since seeded ids differ per database. */
export const NUTRIENT = { energy: '', protein: '', fiber: '' };

export async function seedFoodFixtures(pool: Pool): Promise<void> {
  const foods: Array<[string, string, string | null, string, number | null, string | null]> = [
    [FOOD.chickpeas, 'fixture_chickpeas_cooked', 'legumes', 'trusted_database', null, null],
    [FOOD.flour, 'fixture_wheat_flour', 'grains', 'trusted_database', 0.593, 'trusted_database'],
    [FOOD.chickenBreast, 'fixture_chicken_breast_cooked', 'poultry', 'trusted_database', null, null],
    [FOOD.chickpeaFlour, 'fixture_chickpea_flour', 'legumes', 'trusted_database', 0.41, 'ai_matched'],
    [FOOD.aiOnly, 'fixture_ai_only_food', null, 'ai_matched', null, null],
    [FOOD.percentFood, 'fixture_percent_food', null, 'trusted_database', null, null],
    [FOOD.lentils, 'fixture_lentils', 'legumes', 'trusted_database', null, null],
    [FOOD.lentilSoup, 'fixture_soup_base', 'soups', 'trusted_database', null, null],
  ];
  for (const row of foods) {
    await pool.query(
      'insert into food (id, canonical_name, category, source, density_g_per_ml, density_source) values ($1, $2, $3, $4, $5, $6)',
      row,
    );
  }

  const aliases: Array<[string, string, string, boolean, string]> = [
    [FOOD.chickpeas, 'en', 'Chickpeas', true, 'trusted_database'],
    [FOOD.chickpeas, 'en', 'Garbanzo beans', false, 'trusted_database'],
    [FOOD.chickpeas, 'ar', 'حمص', true, 'trusted_database'],
    [FOOD.chickpeas, 'ar-AE', 'حمص حب', true, 'trusted_database'],
    [FOOD.flour, 'en', 'Wheat flour', true, 'trusted_database'],
    [FOOD.flour, 'ar', 'طحين القمح', true, 'trusted_database'],
    [FOOD.chickenBreast, 'en', 'Chicken breast', true, 'trusted_database'],
    [FOOD.chickpeaFlour, 'en', 'Chickpea flour', true, 'trusted_database'],
    [FOOD.chickpeaFlour, 'en-IN', 'Besan', true, 'trusted_database'],
    [FOOD.aiOnly, 'en', 'Chickpea snack', false, 'ai_matched'],
    [FOOD.percentFood, 'en', '100% juice', true, 'trusted_database'],
    [FOOD.lentilSoup, 'en', 'Fixture lentils soup', true, 'trusted_database'],
  ];
  for (const row of aliases) {
    await pool.query('insert into food_alias (food_id, locale, alias_text, is_primary, source) values ($1, $2, $3, $4, $5)', row);
  }

  const servings: Array<[string, string, string, string | null, number, string, string]> = [
    [SERVING.flourCupUs, FOOD.flour, '1 cup', 'US', 236.5882365, 'ml', 'trusted_database'],
    [SERVING.flourCupAu, FOOD.flour, '1 cup', 'AU', 250, 'ml', 'trusted_database'],
    [SERVING.flourTbsp, FOOD.flour, '1 tablespoon', null, 7.8, 'g', 'trusted_database'],
    [SERVING.chickpeasCan, FOOD.chickpeas, '1 can, drained', null, 240, 'g', 'trusted_database'],
    [SERVING.chickenPiece, FOOD.chickenBreast, '1 piece', null, 120, 'g', 'trusted_database'],
    [SERVING.aiScoop, FOOD.chickpeaFlour, '1 scoop', null, 30, 'g', 'ai_matched'],
  ];
  for (const row of servings) {
    await pool.query(
      'insert into food_serving (id, food_id, serving_description, region, canonical_quantity, canonical_unit, source) values ($1, $2, $3, $4, $5, $6, $7)',
      row,
    );
  }

  const { rows } = await pool.query<{ id: string; canonical_key: keyof typeof NUTRIENT }>(
    "select id, canonical_key from nutrient where canonical_key in ('energy', 'protein', 'fiber')",
  );
  for (const row of rows) NUTRIENT[row.canonical_key] = row.id;

  // Two sources for chickpeas/protein deliberately coexist (Data Dictionary
  // §18: multiple sourced values per pair are intentional).
  await pool.query(
    `insert into food_nutrient (food_id, nutrient_id, amount_per_canonical_unit, source) values
       ($1, $2, 164, 'trusted_database'),
       ($1, $3, 8.9, 'trusted_database'),
       ($1, $3, 9.1, 'manufacturer_label'),
       ($1, $4, 7.6, 'trusted_database')`,
    [FOOD.chickpeas, NUTRIENT.energy, NUTRIENT.protein, NUTRIENT.fiber],
  );
}
