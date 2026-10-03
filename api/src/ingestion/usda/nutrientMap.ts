// Layer 12B.1 — the explicit USDA FoodData Central -> canonical nutrient map.
//
// Each entry pins BOTH the FDC nutrient id and the legacy SR nutrient number,
// plus the unit USDA reports it in; a source row matches only if all three
// agree, so a renumbered or re-united USDA nutrient is refused, never guessed.
// Every mapping corresponds to a `definition` in
// src/domain/nutrition/vocabulary.ts (a test enforces key/unit agreement).
// Nothing is matched by name.
//
// Deliberately NOT mapped (left unavailable rather than approximated):
//   1062 / 268  Energy (kJ)                 — no approved kJ<->kcal policy
//   1104 / 318  Vitamin A, IU               — IU is not a permitted unit
//   1110 / 324  Vitamin D (D2 + D3), IU     — idem
//   1185 / 430  Vitamin K (phylloquinone)   — K1 only, not total vitamin K
//   1177 / 417  Folate, total               — the vocabulary requires DFE
//   any other vitamin E form, carbohydrate measure or nutrient not listed below
//
// Recorded per-source decisions (vocabulary `measure_requires_mapping_review`):
//   carbohydrate  USDA "Carbohydrate, by difference" (fiber and sugars
//                 included) — named explicitly in the vocabulary definition.
//   vitamin_a     USDA "Vitamin A, RAE" (mcg retinol activity equivalents).
//   vitamin_d     USDA "Vitamin D (D2 + D3)" by mass (mcg).
//   vitamin_e     USDA "Vitamin E (alpha-tocopherol)".
//   folate        USDA "Folate, DFE" (mcg dietary folate equivalents).
//   niacin        USDA "Niacin" = PREFORMED niacin (not niacin equivalents).
//   energy        USDA "Energy" in kcal as stated by USDA (never derived here).

export type CanonicalUnit = 'kcal' | 'g' | 'mg' | 'mcg';

export interface UsdaNutrientMapping {
  fdcNutrientId: number;
  srNumber: string;
  usdaName: string;
  key: string;
  unit: CanonicalUnit;
}

export const USDA_NUTRIENT_MAP_VERSION = 'usda-fdc-sr-legacy-map-1';

export const USDA_NUTRIENT_MAP: readonly UsdaNutrientMapping[] = [
  { fdcNutrientId: 1008, srNumber: '208', usdaName: 'Energy', key: 'energy', unit: 'kcal' },
  { fdcNutrientId: 1003, srNumber: '203', usdaName: 'Protein', key: 'protein', unit: 'g' },
  { fdcNutrientId: 1005, srNumber: '205', usdaName: 'Carbohydrate, by difference', key: 'carbohydrate', unit: 'g' },
  { fdcNutrientId: 1004, srNumber: '204', usdaName: 'Total lipid (fat)', key: 'fat', unit: 'g' },
  { fdcNutrientId: 1079, srNumber: '291', usdaName: 'Fiber, total dietary', key: 'fiber', unit: 'g' },
  { fdcNutrientId: 1093, srNumber: '307', usdaName: 'Sodium, Na', key: 'sodium', unit: 'mg' },
  { fdcNutrientId: 1092, srNumber: '306', usdaName: 'Potassium, K', key: 'potassium', unit: 'mg' },
  { fdcNutrientId: 1087, srNumber: '301', usdaName: 'Calcium, Ca', key: 'calcium', unit: 'mg' },
  { fdcNutrientId: 1089, srNumber: '303', usdaName: 'Iron, Fe', key: 'iron', unit: 'mg' },
  { fdcNutrientId: 1090, srNumber: '304', usdaName: 'Magnesium, Mg', key: 'magnesium', unit: 'mg' },
  { fdcNutrientId: 1095, srNumber: '309', usdaName: 'Zinc, Zn', key: 'zinc', unit: 'mg' },
  { fdcNutrientId: 1106, srNumber: '320', usdaName: 'Vitamin A, RAE', key: 'vitamin_a', unit: 'mcg' },
  { fdcNutrientId: 1162, srNumber: '401', usdaName: 'Vitamin C, total ascorbic acid', key: 'vitamin_c', unit: 'mg' },
  { fdcNutrientId: 1114, srNumber: '328', usdaName: 'Vitamin D (D2 + D3)', key: 'vitamin_d', unit: 'mcg' },
  { fdcNutrientId: 1109, srNumber: '323', usdaName: 'Vitamin E (alpha-tocopherol)', key: 'vitamin_e', unit: 'mg' },
  { fdcNutrientId: 1165, srNumber: '404', usdaName: 'Thiamin', key: 'thiamin', unit: 'mg' },
  { fdcNutrientId: 1166, srNumber: '405', usdaName: 'Riboflavin', key: 'riboflavin', unit: 'mg' },
  { fdcNutrientId: 1167, srNumber: '406', usdaName: 'Niacin', key: 'niacin', unit: 'mg' },
  { fdcNutrientId: 1175, srNumber: '415', usdaName: 'Vitamin B-6', key: 'vitamin_b6', unit: 'mg' },
  { fdcNutrientId: 1190, srNumber: '435', usdaName: 'Folate, DFE', key: 'folate', unit: 'mcg' },
  { fdcNutrientId: 1178, srNumber: '418', usdaName: 'Vitamin B-12', key: 'vitamin_b12', unit: 'mcg' },
];

/** USDA writes micrograms as "µg" (or "UG"); everything else is compared case-insensitively. */
export function normalizeUsdaUnit(unitName: string): string {
  const u = unitName.trim().toLowerCase();
  if (u === 'µg' || u === 'μg' || u === 'ug' || u === 'mcg') return 'mcg';
  return u;
}
