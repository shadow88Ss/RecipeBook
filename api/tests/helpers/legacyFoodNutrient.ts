// LEGACY FIXTURE ONLY — never a production write path.
//
// Since Layer 11A (G2) new food_nutrient rows must be `trusted_database`
// (food_nutrient_generic_reference_source, added NOT VALID so rows that
// predate it are kept). Layers 5A-5C test the engine's behaviour for such
// pre-existing `manufacturer_label` rows on a generic Food. To reproduce
// that historical state, this helper inserts them the way they came to
// exist: with the constraint absent, then re-adds it NOT VALID exactly as
// the migration does — in one transaction, on the test's own throwaway
// database. Production rules are not weakened.

import type { Pool } from 'pg';

export async function insertLegacyFoodNutrients(pool: Pool, sql: string, params: unknown[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('alter table food_nutrient drop constraint food_nutrient_generic_reference_source');
    await client.query(sql, params);
    await client.query("alter table food_nutrient add constraint food_nutrient_generic_reference_source check (source = 'trusted_database') not valid");
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
