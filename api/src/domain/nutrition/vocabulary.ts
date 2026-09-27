// Layer 5C — the canonical platform nutrient vocabulary.
//
// Keys are stable, language-independent identities (translated labels live
// in a (nutrient_id, locale) lookup, never as new keys). Each has exactly one
// role and one reporting unit. Seeded into the `nutrient` table by
// 20260929120000_nutrient_vocabulary_and_authority.sql; a test keeps the two
// identical.
//
// The nutrition engine does not branch on any of these keys — its arithmetic
// is identical for every nutrient. The vocabulary exists so projections
// (nutritionSummary.ts) and later features can find a nutrient's role
// reliably, and so external datasets have one explicit mapping target.
//
// `definition` is the meaning a source value must have to be mapped to the
// key. Ingestion maps external nutrient identifiers to these keys explicitly
// (never by display-name matching); a source concept that does not match a
// definition is left unmapped rather than approximated.

export const NUTRIENT_ROLES = ['energy', 'macronutrient', 'fiber', 'micronutrient', 'other'] as const;
export type NutrientRole = (typeof NUTRIENT_ROLES)[number];

export interface CanonicalNutrient {
  key: string;
  role: NutrientRole;
  unit: 'kcal' | 'g' | 'mg' | 'mcg';
  definition: string;
  /** True where several scientifically distinct measures share a name
   * (e.g. folate vs dietary folate equivalents); the source measure must be
   * confirmed during ingestion mapping, never assumed. */
  measure_requires_mapping_review: boolean;
}

const nutrient = (key: string, role: NutrientRole, unit: CanonicalNutrient['unit'], definition: string, review = false): CanonicalNutrient => ({
  key,
  role,
  unit,
  definition,
  measure_requires_mapping_review: review,
});

export const CANONICAL_NUTRIENTS: readonly CanonicalNutrient[] = [
  nutrient('energy', 'energy', 'kcal', 'Food energy in kilocalories as stated by the approved source. Never derived from macronutrients. kJ-only source values are not mapped until an approved kJ<->kcal policy exists.'),
  nutrient('protein', 'macronutrient', 'g', 'Total protein as stated by the approved source.'),
  nutrient(
    'carbohydrate',
    'macronutrient',
    'g',
    'Total carbohydrate, INCLUDING dietary fiber and sugars (US "Total Carbohydrate"; USDA "carbohydrate, by difference"). Not "available"/"net" carbohydrate: a source reporting available carbohydrate (fiber excluded, e.g. EU labeling) must not be mapped here without an approved conversion.',
    true,
  ),
  nutrient('fat', 'macronutrient', 'g', 'Total fat (total lipid).'),
  nutrient('fiber', 'fiber', 'g', 'Total dietary fiber.'),

  nutrient('sodium', 'micronutrient', 'mg', 'Sodium (Na). Not salt: salt values must not be mapped here.'),
  nutrient('potassium', 'micronutrient', 'mg', 'Potassium (K).'),
  nutrient('calcium', 'micronutrient', 'mg', 'Calcium (Ca).'),
  nutrient('iron', 'micronutrient', 'mg', 'Total iron (Fe).'),
  nutrient('magnesium', 'micronutrient', 'mg', 'Magnesium (Mg).'),
  nutrient('zinc', 'micronutrient', 'mg', 'Zinc (Zn).'),

  nutrient('vitamin_a', 'micronutrient', 'mcg', 'Vitamin A as retinol activity equivalents (mcg RAE). IU and retinol-equivalent (RE) values are not mapped.', true),
  nutrient('vitamin_c', 'micronutrient', 'mg', 'Vitamin C (ascorbic acid).'),
  nutrient('vitamin_d', 'micronutrient', 'mcg', 'Vitamin D (D2 + D3) by mass. IU values are not mapped (no approved IU conversion).', true),
  nutrient('vitamin_e', 'micronutrient', 'mg', 'Vitamin E as alpha-tocopherol. IU and total-tocopherol values are not mapped.', true),
  nutrient('vitamin_k', 'micronutrient', 'mcg', 'Vitamin K by mass as stated by the approved source.'),
  nutrient('thiamin', 'micronutrient', 'mg', 'Thiamin (vitamin B1).'),
  nutrient('riboflavin', 'micronutrient', 'mg', 'Riboflavin (vitamin B2).'),
  nutrient('niacin', 'micronutrient', 'mg', 'Niacin as stated by the approved source; whether preformed niacin or niacin equivalents (NE) is a mapping decision recorded per source.', true),
  nutrient('vitamin_b6', 'micronutrient', 'mg', 'Vitamin B6.'),
  nutrient('folate', 'micronutrient', 'mcg', 'Folate as dietary folate equivalents (mcg DFE). Food folate / total folate values are not mapped without an approved conversion.', true),
  nutrient('vitamin_b12', 'micronutrient', 'mcg', 'Vitamin B12 (cobalamin).'),
];

export const CANONICAL_NUTRIENT_BY_KEY: ReadonlyMap<string, CanonicalNutrient> = new Map(CANONICAL_NUTRIENTS.map((n) => [n.key, n]));

/** Stable keys other code may reference, instead of string literals. */
export const NUTRIENT_KEYS = {
  energy: 'energy',
  protein: 'protein',
  carbohydrate: 'carbohydrate',
  fat: 'fat',
  fiber: 'fiber',
  sodium: 'sodium',
  potassium: 'potassium',
  calcium: 'calcium',
  iron: 'iron',
  magnesium: 'magnesium',
  zinc: 'zinc',
  vitamin_a: 'vitamin_a',
  vitamin_c: 'vitamin_c',
  vitamin_d: 'vitamin_d',
  vitamin_e: 'vitamin_e',
  vitamin_k: 'vitamin_k',
  thiamin: 'thiamin',
  riboflavin: 'riboflavin',
  niacin: 'niacin',
  vitamin_b6: 'vitamin_b6',
  folate: 'folate',
  vitamin_b12: 'vitamin_b12',
} as const;
