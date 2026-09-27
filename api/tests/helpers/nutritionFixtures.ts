// TEST FIXTURES ONLY — NOT PRODUCTION FOOD OR NUTRITION DATA.
//
// Illustrative values chosen to exercise the Layer 5B engine: complete and
// partial nutrient data, a known zero, competing sources, a non-100 basis,
// a volume basis, density / no density, micronutrients in different units,
// and an AI-matched identity with no trusted nutrition. canonical_name
// values are prefixed `fixture5b_` so they cannot be mistaken for real
// reference rows. Inserted as the postgres superuser (food reference data
// has no client write path).

import type { Pool } from 'pg';

const id = (group: number, n: number) => `f5b${group}0000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Ids of canonical vocabulary rows seeded by
 * 20260929120000_nutrient_vocabulary_and_authority.sql, looked up by key in
 * seedNutritionFixtures() (seeded ids differ per database). */
export const NUT = { energy: '', protein: '', carbohydrate: '', fat: '', fiber: '', iron: '', vitaminD: '', sodium: '' };
const NUT_KEYS: Record<keyof typeof NUT, string> = {
  energy: 'energy',
  protein: 'protein',
  carbohydrate: 'carbohydrate',
  fat: 'fat',
  fiber: 'fiber',
  iron: 'iron',
  vitaminD: 'vitamin_d',
  sodium: 'sodium',
};

export const F = {
  rice: id(1, 1), // complete, per 100 g, known-zero vitamin D and sodium
  bread: id(1, 2), // partial (no micronutrients), 30 g slice serving
  milk: id(1, 3), // per 100 ml, trusted density
  juice: id(1, 4), // per 100 ml, NO density
  bar: id(1, 5), // manufacturer label, per 40 g basis
  competing: id(1, 6), // trusted + manufacturer protein; trusted + ai energy
  aiIdentity: id(1, 7), // ai_matched identity, only ai_matched / user_entered nutrients
  noEnergy: id(1, 8), // macros but no energy value
  spinach: id(1, 9), // iron (mg) and vitamin D (mcg)
  thirds: id(1, 10), // 1 g protein per 300 g — each 100 g is exactly 1/3 g
} as const;

export const SRV = {
  breadSlice: id(2, 1),
  milkCup: id(2, 2),
  juiceGlass: id(2, 3),
} as const;

export async function seedNutritionFixtures(pool: Pool): Promise<void> {
  for (const [name, key] of Object.entries(NUT_KEYS) as Array<[keyof typeof NUT, string]>) {
    const { rows } = await pool.query<{ id: string }>('select id from nutrient where canonical_key = $1', [key]);
    const row = rows[0];
    if (!row) throw new Error(`Canonical nutrient ${key} is not seeded.`);
    NUT[name] = row.id;
  }

  const foods: Array<[string, string, string, number | null, string | null]> = [
    [F.rice, 'fixture5b_rice_cooked', 'trusted_database', null, null],
    [F.bread, 'fixture5b_bread', 'trusted_database', null, null],
    [F.milk, 'fixture5b_milk', 'trusted_database', 1.03, 'trusted_database'],
    [F.juice, 'fixture5b_juice', 'trusted_database', null, null],
    [F.bar, 'fixture5b_protein_bar', 'manufacturer_label', null, null],
    [F.competing, 'fixture5b_competing', 'trusted_database', null, null],
    [F.aiIdentity, 'fixture5b_ai_identity', 'ai_matched', null, null],
    [F.noEnergy, 'fixture5b_no_energy', 'trusted_database', null, null],
    [F.spinach, 'fixture5b_spinach', 'trusted_database', null, null],
    [F.thirds, 'fixture5b_thirds', 'trusted_database', null, null],
  ];
  for (const row of foods) {
    await pool.query('insert into food (id, canonical_name, source, density_g_per_ml, density_source) values ($1, $2, $3, $4, $5)', row);
  }
  await pool.query("insert into food_alias (food_id, locale, alias_text, is_primary, source) values ($1, 'en', 'Mystery snack', false, 'ai_matched')", [F.aiIdentity]);

  const servings: Array<[string, string, string, number, string]> = [
    [SRV.breadSlice, F.bread, '1 slice', 30, 'g'],
    [SRV.milkCup, F.milk, '1 cup', 240, 'ml'],
    [SRV.juiceGlass, F.juice, '1 glass', 200, 'ml'],
  ];
  for (const [sid, fid, desc, qty, unit] of servings) {
    await pool.query(
      "insert into food_serving (id, food_id, serving_description, canonical_quantity, canonical_unit, source) values ($1, $2, $3, $4, $5, 'trusted_database')",
      [sid, fid, desc, qty, unit],
    );
  }

  // [food, nutrient, amount, source, basis_quantity, basis_unit]
  const values: Array<[string, string, number, string, number, string]> = [
    [F.rice, NUT.energy, 130, 'trusted_database', 100, 'g'],
    [F.rice, NUT.protein, 2.7, 'trusted_database', 100, 'g'],
    [F.rice, NUT.carbohydrate, 28.2, 'trusted_database', 100, 'g'],
    [F.rice, NUT.fat, 0.3, 'trusted_database', 100, 'g'],
    [F.rice, NUT.fiber, 0.4, 'trusted_database', 100, 'g'],
    [F.rice, NUT.iron, 1.2, 'trusted_database', 100, 'g'],
    [F.rice, NUT.vitaminD, 0, 'trusted_database', 100, 'g'],
    [F.rice, NUT.sodium, 0, 'trusted_database', 100, 'g'],

    [F.bread, NUT.energy, 265, 'trusted_database', 100, 'g'],
    [F.bread, NUT.protein, 9, 'trusted_database', 100, 'g'],
    [F.bread, NUT.carbohydrate, 49, 'trusted_database', 100, 'g'],
    [F.bread, NUT.fat, 3.2, 'trusted_database', 100, 'g'],
    [F.bread, NUT.fiber, 2.7, 'trusted_database', 100, 'g'],

    [F.milk, NUT.energy, 64, 'trusted_database', 100, 'ml'],
    [F.milk, NUT.protein, 3.4, 'trusted_database', 100, 'ml'],
    [F.milk, NUT.fat, 3.6, 'trusted_database', 100, 'ml'],
    [F.milk, NUT.vitaminD, 1.1, 'trusted_database', 100, 'ml'],

    [F.juice, NUT.energy, 45, 'trusted_database', 100, 'ml'],
    [F.juice, NUT.carbohydrate, 10.4, 'trusted_database', 100, 'ml'],

    [F.bar, NUT.energy, 180, 'manufacturer_label', 40, 'g'],
    [F.bar, NUT.protein, 10, 'manufacturer_label', 40, 'g'],
    [F.bar, NUT.sodium, 150, 'manufacturer_label', 40, 'g'],

    [F.competing, NUT.protein, 9, 'trusted_database', 100, 'g'],
    [F.competing, NUT.protein, 11, 'manufacturer_label', 100, 'g'],
    [F.competing, NUT.energy, 200, 'trusted_database', 100, 'g'],
    [F.competing, NUT.energy, 999, 'ai_matched', 100, 'g'],

    [F.aiIdentity, NUT.energy, 450, 'ai_matched', 100, 'g'],
    [F.aiIdentity, NUT.protein, 7, 'user_entered', 100, 'g'],

    [F.noEnergy, NUT.protein, 10, 'trusted_database', 100, 'g'],
    [F.noEnergy, NUT.carbohydrate, 20, 'trusted_database', 100, 'g'],
    [F.noEnergy, NUT.fat, 5, 'trusted_database', 100, 'g'],

    [F.spinach, NUT.iron, 2.7, 'trusted_database', 100, 'g'],
    [F.spinach, NUT.vitaminD, 0, 'trusted_database', 100, 'g'],
    [F.spinach, NUT.protein, 2.9, 'trusted_database', 100, 'g'],

    [F.thirds, NUT.protein, 1, 'trusted_database', 300, 'g'],
  ];
  for (const row of values) {
    await pool.query(
      'insert into food_nutrient (food_id, nutrient_id, amount_per_canonical_unit, source, basis_quantity, basis_unit) values ($1, $2, $3, $4, $5, $6)',
      row,
    );
  }
}
