// TEST FIXTURES ONLY — NOT PRODUCTION PRODUCT, LABEL OR BARCODE DATA.
//
// Layer 11A Products are global reference data written only by trusted
// ingestion. These fixtures play that role: inserted as the postgres
// superuser, labels published through publish_product_label_version().
// Brand names are prefixed `Fixture` so they cannot be mistaken for real
// products; barcodes are check-digit-valid illustrative codes.

import type { Pool } from 'pg';
import { normalizeBarcode, type BarcodeType } from '../../src/domain/products/barcode';
import { F, NUT } from './nutritionFixtures';

const id = (n: number) => `a11a0000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const P = {
  yogurtAE: id(1), // per 100 g label, known-zero fat, no fiber; 500 g tub vs 150 g serving; generic Food: milk
  yogurtUS: id(2), // same brand/name, another market and formulation
  bar: id(3), // per-serving basis (1 bar = 60 g)
  drink: id(4), // per 250 ml basis; generic Food with a density (never borrowed)
  crackers: id(5), // no label version at all; generic Food with full nutrition (never used)
  granola: id(6), // third-party product database label only (not authoritative)
} as const;

export const BARCODE = {
  yogurtAE: '4006381333931', // EAN-13
  yogurtUS: '036000291452', // UPC-A
  bar: '96385074', // EAN-8 (declared)
  drinkUpcE: '01234565', // UPC-E (declared) -> UPC-A 012345000065
  barCase: '10036000291459', // GTIN-14
} as const;

export const LABEL: Record<string, string> = {};
export const SERVING: Record<string, string> = {};

type Nutrient = { nutrient_id: string; amount: number; basis_quantity: number; basis_unit: 'g' | 'ml' };
const n = (nutrient_id: string, amount: number, basis_quantity: number, basis_unit: 'g' | 'ml' = 'g'): Nutrient => ({ nutrient_id, amount, basis_quantity, basis_unit });

export async function publishLabel(
  pool: Pool,
  product: string,
  source: 'manufacturer_label' | 'third_party_product_database',
  nutrients: Nutrient[],
  servings: Array<{ serving_description: string; canonical_quantity: number; canonical_unit: 'g' | 'ml' }>,
  provenance = 'fixture-label',
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('select publish_product_label_version($1, $2, $3, null, $4, $5) as id', [
    product,
    source,
    provenance,
    JSON.stringify(nutrients),
    JSON.stringify(servings),
  ]);
  return (rows[0] as { id: string }).id;
}

export async function addBarcode(pool: Pool, product: string, code: string, type?: BarcodeType): Promise<string> {
  const normalized = normalizeBarcode(code, type);
  if (!normalized.ok) throw new Error(`fixture barcode ${code} is invalid: ${normalized.reason}`);
  const { rows } = await pool.query<{ id: string }>(
    "insert into barcode (product_id, gtin, barcode_type, submitted_code, source, provenance_reference) values ($1, $2, $3, $4, 'manufacturer_data', 'fixture') returning id",
    [product, normalized.gtin, normalized.barcode_type, normalized.digits],
  );
  return (rows[0] as { id: string }).id;
}

/** Requires seedNutritionFixtures() first (Food and Nutrient ids). */
export async function seedProductFixtures(pool: Pool): Promise<void> {
  const products: Array<[string, string, string, string | null, string | null, number | null, string | null, string | null, string]> = [
    [P.yogurtAE, 'Fixture Brand X', 'Greek Yogurt', 'Plain', 'AE', 500, 'g', F.milk, 'manufacturer_data'],
    [P.yogurtUS, 'Fixture Brand X', 'Greek Yogurt', 'Plain', 'US', 500, 'g', F.milk, 'manufacturer_data'],
    [P.bar, 'Fixture Brand Y', 'Protein Bar', 'Chocolate', null, 60, 'g', null, 'manufacturer_data'],
    [P.drink, 'Fixture Brand Z', 'Oat Drink', null, 'AE', 1000, 'ml', F.milk, 'trusted_ingestion'],
    [P.crackers, 'Fixture Brand W', 'Crackers', null, null, 200, 'g', F.bread, 'trusted_ingestion'],
    [P.granola, 'Fixture Brand V', 'Granola', null, null, 400, 'g', null, 'approved_product_database'],
  ];
  for (const [pid, brand, name, variant, market, qty, unit, food, source] of products) {
    await pool.query(
      'insert into product (id, brand_name, product_name, variant_name, market, package_quantity, package_unit, food_id, source, provenance_reference) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
      [pid, brand, name, variant, market, qty, unit, food, source, 'fixture'],
    );
  }

  LABEL.yogurtAE = await publishLabel(
    pool,
    P.yogurtAE,
    'manufacturer_label',
    [n(NUT.energy, 97, 100), n(NUT.protein, 9, 100), n(NUT.carbohydrate, 3.6, 100), n(NUT.fat, 0, 100), n(NUT.sodium, 36, 100)],
    [{ serving_description: '1 portion', canonical_quantity: 150, canonical_unit: 'g' }],
  );
  LABEL.yogurtUS = await publishLabel(pool, P.yogurtUS, 'manufacturer_label', [n(NUT.energy, 100, 100), n(NUT.protein, 10, 100)], []);
  LABEL.bar = await publishLabel(
    pool,
    P.bar,
    'manufacturer_label',
    [n(NUT.energy, 220, 60), n(NUT.protein, 20, 60), n(NUT.carbohydrate, 22, 60), n(NUT.fat, 8, 60)],
    [{ serving_description: '1 bar', canonical_quantity: 60, canonical_unit: 'g' }],
  );
  LABEL.drink = await publishLabel(pool, P.drink, 'manufacturer_label', [n(NUT.energy, 120, 250, 'ml'), n(NUT.protein, 2.5, 250, 'ml')], [
    { serving_description: '1 glass', canonical_quantity: 250, canonical_unit: 'ml' },
  ]);
  LABEL.granola = await publishLabel(pool, P.granola, 'third_party_product_database', [n(NUT.energy, 450, 100), n(NUT.protein, 11, 100)], [
    { serving_description: '1 bowl', canonical_quantity: 45, canonical_unit: 'g' },
  ]);
  const servings = await pool.query<{ id: string; product_id: string }>('select id, product_id from product_serving');
  for (const s of servings.rows) {
    const key = Object.entries(P).find(([, v]) => v === s.product_id)?.[0];
    if (key) SERVING[key] = s.id;
  }

  await addBarcode(pool, P.yogurtAE, BARCODE.yogurtAE);
  await addBarcode(pool, P.yogurtUS, BARCODE.yogurtUS);
  await addBarcode(pool, P.bar, BARCODE.bar, 'ean_8');
  await addBarcode(pool, P.bar, BARCODE.barCase);
  await addBarcode(pool, P.drink, BARCODE.drinkUpcE, 'upc_e');
}
