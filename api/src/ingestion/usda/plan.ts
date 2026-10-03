// Layer 12B.1 — turn an official USDA FoodData Central SR Legacy JSON download
// plus a committed selection manifest into a deterministic ingestion plan.
// Pure: no database, no network. Anything unexpected in the source file stops
// the plan with an error instead of being guessed.
//
//   Food          canonical_name `usda-fdc:<fdcId>` (internal key, never shown),
//                 category = USDA food category, source trusted_database,
//                 no density (USDA SR does not state one; none is assumed).
//   FoodAlias     the USDA description, locale `en`, primary, trusted_database.
//                 No generated or AI aliases.
//   FoodNutrient  only nutrients in USDA_NUTRIENT_MAP, amount per 100 g edible
//                 portion (SR's stated basis). A nutrient USDA states as 0 is a
//                 known zero; one USDA does not state is absent (unavailable).
//   FoodServing   only USDA portions with a stated gram weight: description
//                 built from USDA's own amount/unit/modifier text, quantity =
//                 USDA gram weight. No household weight is estimated.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { normalizeUsdaUnit, USDA_NUTRIENT_MAP, USDA_NUTRIENT_MAP_VERSION } from './nutrientMap';

export const SR_BASIS = { quantity: 100, unit: 'g' as const };
export const USDA_LICENCE = 'CC0-1.0';

// ---- the selection manifest (committed) ------------------------------------

export const manifestSchema = z.object({
  manifest_version: z.literal(1),
  name: z.string().min(1),
  source: z.object({ system: z.literal('usda_fdc'), dataset: z.literal('sr_legacy') }),
  foods: z
    .array(z.object({ ndb_number: z.string().regex(/^\d{4,5}$/), description: z.string().min(1) }))
    .min(1)
    .max(500),
});
export type Manifest = z.infer<typeof manifestSchema>;

// ---- the official SR Legacy JSON (only the fields used) --------------------

const srNutrientSchema = z.object({
  nutrient: z.object({ id: z.number().int(), number: z.string(), name: z.string(), unitName: z.string() }),
  amount: z.number().finite().optional(),
});

const srPortionSchema = z.object({
  amount: z.number().finite().optional(),
  modifier: z.string().optional(),
  portionDescription: z.string().optional(),
  gramWeight: z.number().finite().optional(),
  sequenceNumber: z.number().optional(),
  measureUnit: z.object({ name: z.string() }).optional(),
});

export const srFoodSchema = z.object({
  fdcId: z.number().int().positive(),
  description: z.string().min(1),
  dataType: z.literal('SR Legacy'),
  ndbNumber: z.union([z.number().int(), z.string()]),
  publicationDate: z.string().optional(),
  foodCategory: z.object({ description: z.string() }).nullable().optional(),
  foodNutrients: z.array(srNutrientSchema),
  foodPortions: z.array(srPortionSchema).default([]),
});
export type SrFood = z.infer<typeof srFoodSchema>;

export const srFileSchema = z.object({ SRLegacyFoods: z.array(z.unknown()).min(1) });

// ---- plan ------------------------------------------------------------------

export interface PlannedNutrient {
  key: string;
  unit: string;
  amount: number;
}

export interface PlannedServing {
  description: string;
  grams: number;
}

export interface PlannedFood {
  fdcId: string;
  ndbNumber: string;
  canonicalName: string;
  description: string;
  category: string | null;
  publicationDate: string | null;
  nutrients: PlannedNutrient[];
  servings: PlannedServing[];
  /** USDA nutrients present but not mapped (kJ, IU, other measures), by SR number. */
  unmappedNumbers: string[];
  skippedPortions: number;
  contentSha256: string;
}

export interface Plan {
  manifestName: string;
  mapVersion: string;
  foods: PlannedFood[];
}

export class PlanError extends Error {
  constructor(
    message: string,
    readonly problems: string[],
  ) {
    super(`${message}\n  - ${problems.join('\n  - ')}`);
    this.name = 'PlanError';
  }
}

export const normalizeNdb = (value: number | string): string => String(value).trim().padStart(5, '0');
const normalizeText = (value: string): string => value.normalize('NFC').replace(/\s+/g, ' ').trim();

/** "1 large", "1 cup, chopped", "0.5 cup" — only USDA's own words, joined. */
export function servingDescription(p: z.infer<typeof srPortionSchema>): string {
  const unit = p.measureUnit && !/^(undetermined|unknown)$/i.test(p.measureUnit.name.trim()) ? p.measureUnit.name.trim() : '';
  const text = normalizeText(p.modifier?.trim() ? p.modifier : (p.portionDescription ?? ''));
  const amount = p.amount !== undefined && p.amount > 0 ? String(p.amount) : '';
  return normalizeText([amount, unit, text].filter(Boolean).join(' '));
}

function hashContent(food: Omit<PlannedFood, 'contentSha256' | 'unmappedNumbers' | 'skippedPortions'>): string {
  const canonical = JSON.stringify({
    fdcId: food.fdcId,
    ndbNumber: food.ndbNumber,
    description: food.description,
    category: food.category,
    basis: SR_BASIS,
    nutrients: [...food.nutrients].sort((a, b) => (a.key < b.key ? -1 : 1)),
    servings: [...food.servings].sort((a, b) => (a.description < b.description ? -1 : 1)),
    mapVersion: USDA_NUTRIENT_MAP_VERSION,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function planFood(food: SrFood): PlannedFood {
  const problems: string[] = [];
  const nutrients: PlannedNutrient[] = [];
  for (const m of USDA_NUTRIENT_MAP) {
    const rows = food.foodNutrients.filter((n) => n.nutrient.id === m.fdcNutrientId);
    if (rows.length > 1) problems.push(`fdc ${food.fdcId}: nutrient ${m.fdcNutrientId} appears ${rows.length} times`);
    const row = rows[0];
    if (!row || row.amount === undefined) continue; // not stated by USDA -> unavailable
    if (row.nutrient.number !== m.srNumber) problems.push(`fdc ${food.fdcId}: nutrient ${m.fdcNutrientId} has number ${row.nutrient.number}, expected ${m.srNumber}`);
    if (normalizeUsdaUnit(row.nutrient.unitName) !== m.unit) problems.push(`fdc ${food.fdcId}: nutrient ${m.fdcNutrientId} unit ${row.nutrient.unitName}, expected ${m.unit}`);
    if (row.amount < 0) problems.push(`fdc ${food.fdcId}: nutrient ${m.fdcNutrientId} is negative`);
    nutrients.push({ key: m.key, unit: m.unit, amount: row.amount });
  }
  const mappedIds = new Set(USDA_NUTRIENT_MAP.map((m) => m.fdcNutrientId));
  const unmappedNumbers = [...new Set(food.foodNutrients.filter((n) => !mappedIds.has(n.nutrient.id) && n.amount !== undefined).map((n) => n.nutrient.number))].sort();

  const servings: PlannedServing[] = [];
  let skippedPortions = 0;
  const seen = new Set<string>();
  for (const p of [...food.foodPortions].sort((a, b) => (a.sequenceNumber ?? 0) - (b.sequenceNumber ?? 0))) {
    const description = servingDescription(p);
    if (!description || p.gramWeight === undefined || !(p.gramWeight > 0) || seen.has(description)) {
      skippedPortions += 1;
      continue;
    }
    seen.add(description);
    servings.push({ description, grams: p.gramWeight });
  }
  if (problems.length) throw new PlanError('The USDA record does not match the expected format', problems);

  const base = {
    fdcId: String(food.fdcId),
    ndbNumber: normalizeNdb(food.ndbNumber),
    canonicalName: `usda-fdc:${food.fdcId}`,
    description: normalizeText(food.description),
    category: food.foodCategory?.description ? normalizeText(food.foodCategory.description) : null,
    publicationDate: food.publicationDate ?? null,
    nutrients,
    servings,
  };
  return { ...base, unmappedNumbers, skippedPortions, contentSha256: hashContent(base) };
}

/** Selects exactly the manifest's records (by NDB number, description must match) and plans them. */
export function buildPlan(file: unknown, manifestInput: unknown): Plan {
  const manifest = manifestSchema.parse(manifestInput);
  const parsedFile = srFileSchema.safeParse(file);
  if (!parsedFile.success) throw new PlanError('Not an FDC SR Legacy JSON download', ['expected a top-level "SRLegacyFoods" array']);

  const wanted = new Map<string, string>();
  const problems: string[] = [];
  for (const f of manifest.foods) {
    const ndb = normalizeNdb(f.ndb_number);
    if (wanted.has(ndb)) problems.push(`manifest lists NDB ${ndb} twice`);
    wanted.set(ndb, normalizeText(f.description));
  }

  const found = new Map<string, SrFood>();
  for (const raw of parsedFile.data.SRLegacyFoods) {
    const ndbRaw = raw && typeof raw === 'object' ? (raw as { ndbNumber?: unknown }).ndbNumber : undefined;
    if (typeof ndbRaw !== 'number' && typeof ndbRaw !== 'string') continue;
    const ndb = normalizeNdb(ndbRaw);
    if (!wanted.has(ndb)) continue;
    const parsed = srFoodSchema.safeParse(raw);
    if (!parsed.success) {
      problems.push(`NDB ${ndb}: unexpected record format (${parsed.error.issues.map((i) => i.path.join('.')).join(', ')})`);
      continue;
    }
    if (found.has(ndb)) problems.push(`NDB ${ndb} appears more than once in the file`);
    found.set(ndb, parsed.data);
  }
  for (const [ndb, description] of wanted) {
    const food = found.get(ndb);
    if (!food) problems.push(`NDB ${ndb} (${description}) is not in the file`);
    else if (normalizeText(food.description) !== description) problems.push(`NDB ${ndb}: file says "${normalizeText(food.description)}", manifest expects "${description}"`);
  }
  if (problems.length) throw new PlanError('The selection does not match the USDA file', problems);

  const foods = [...wanted.keys()].map((ndb) => planFood(found.get(ndb)!));
  return { manifestName: manifest.name, mapVersion: USDA_NUTRIENT_MAP_VERSION, foods };
}
