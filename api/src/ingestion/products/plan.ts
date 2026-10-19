// Layer 12B.2a — trusted branded Product label entry: validate one
// operator-transcribed manufacturer label file into a publication plan.
// Pure (no database). Operator-only code: the API server never imports it.
//
// Authority: the input is the physical manufacturer label (or the operator's
// verified transcription of it), published as nutrition_source
// `manufacturer_label`. Nothing here reads provider candidates, generic Food
// values, estimates or AI output, and nothing is derived:
//   - only Layer 5C canonical keys in their reporting unit are stored;
//   - a stated 0 is a known zero; a nutrient not on the label is absent;
//   - kJ is never converted to kcal and energy is never computed (4/4/9);
//   - the label's carbohydrate line is stored under the identity its
//     declared definition names: TOTAL carbohydrate (incl. fibre, US style)
//     as `carbohydrate`, AVAILABLE carbohydrate (excl. fibre, EU/UK/Codex
//     style) as `available_carbohydrate` (Layer 12B.3). One is never mapped
//     to or computed from the other, and the definition is never inferred
//     from the market;
//   - total sugars, added sugars and saturated fat are stored as stated;
//     added sugars are never inferred from total sugars, saturated fat never
//     from total fat; salt is not stored and never converted to sodium;
//   - nutrients whose measure needs a mapping review (vitamin A/D/E, niacin,
//     folate) are not mapped in this operator workflow;
//   - a per-serving label is usable only when the serving states its mass or
//     volume; nothing assumes a serving's weight.
// Publication policy: energy (kcal), protein, fat and a carbohydrate (total
// or available, Layer 12B.3) must be stated (0 allowed), or the label is not
// published.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { normalizeBarcode, BARCODE_TYPES, type BarcodeType } from '../../domain/products/barcode';
import { CANONICAL_NUTRIENT_BY_KEY } from '../../domain/nutrition/vocabulary';

export const LABEL_FILE_SCHEMA = 'myrecipebook-product-label-1';
export const REQUIRED_NUTRIENTS = ['energy', 'protein', 'carbohydrate', 'fat'] as const;
/** Keys whose measure must be confirmed per source; not mapped here. */
const REVIEW_REQUIRED = new Set(['vitamin_a', 'vitamin_d', 'vitamin_e', 'niacin', 'folate']);

const text = (max: number) => z.string().trim().min(1).max(max);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), 'not a calendar date');
const amount = z.number().finite().nonnegative();
const positive = z.number().finite().positive();

export const labelFileSchema = z.strictObject({
  schema: z.literal(LABEL_FILE_SCHEMA),
  /** Documentation examples only: a synthetic file can be dry-run, never applied. */
  synthetic: z.boolean().default(false),
  product: z.strictObject({
    brand_name: text(200),
    product_name: text(300),
    variant_name: text(200).nullable().default(null),
    manufacturer_name: text(200).nullable().default(null),
    market: z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2, e.g. AE'),
    package: z.strictObject({ quantity: positive, unit: z.enum(['g', 'ml', 'count']) }).nullable(),
  }),
  barcode: z.strictObject({
    /** Digits as printed under the bars (spaces/hyphens allowed). */
    code: z.string().trim().min(8).max(20),
    format: z.enum(BARCODE_TYPES),
  }),
  label: z.strictObject({
    source: z.literal('physical_manufacturer_label'),
    /** When the operator read/photographed the label (not an effective date). */
    observed_on: isoDate,
    /** Where the pack was seen, e.g. a retailer name. Optional; never personal data. */
    observed_at: text(100).nullable().default(null),
    /** Only when the manufacturer actually states one; never invented. */
    manufacturer_effective_date: isoDate.nullable().default(null),
    basis: z.enum(['per_100g', 'per_100ml', 'per_serving']),
    serving: z
      .strictObject({
        description: text(200),
        /** The serving's mass or volume as stated on the label; null when not stated. */
        quantity: positive.nullable(),
        unit: z.enum(['g', 'ml']).nullable(),
      })
      .nullable()
      .default(null),
    servings_per_package: positive.nullable().default(null),
    /** How the label defines "carbohydrate". */
    carbohydrate_definition: z.enum(['total', 'available', 'not_stated']),
    nutrients: z
      .array(
        z.strictObject({
          /** A Layer 5C canonical key, or the label's own name for anything else. */
          key: text(60),
          amount,
          unit: text(10),
        }),
      )
      .min(1)
      .max(60),
    notes: text(300).nullable().default(null),
  }),
});
export type LabelFile = z.infer<typeof labelFileSchema>;

export interface PlannedNutrient {
  key: string;
  amount: number;
  basis_quantity: number;
  basis_unit: 'g' | 'ml';
}
export interface PlannedServing {
  description: string;
  quantity: number;
  unit: 'g' | 'ml';
}
export interface LabelPlan {
  synthetic: boolean;
  fileSha256: string;
  product: {
    brand_name: string;
    product_name: string;
    variant_name: string | null;
    manufacturer_name: string | null;
    market: string;
    package_quantity: number | null;
    package_unit: 'g' | 'ml' | 'count' | null;
  };
  barcode: { gtin: string; barcode_type: BarcodeType; submitted_code: string };
  label: {
    effective_from: string | null;
    provenance_reference: string;
    nutrients: PlannedNutrient[];
    servings: PlannedServing[];
  };
  /** Declarations read from the label but not stored, with the reason. */
  notMapped: string[];
  warnings: string[];
}

export class LabelPlanError extends Error {
  constructor(readonly problems: string[]) {
    super(`Label not publishable:\n  - ${problems.join('\n  - ')}`);
    this.name = 'LabelPlanError';
  }
}

const UNIT_ALIASES: Record<string, string> = { kcal: 'kcal', g: 'g', mg: 'mg', mcg: 'mcg', 'µg': 'mcg', ug: 'mcg', kj: 'kJ' };
const normalizeUnit = (u: string) => UNIT_ALIASES[u.trim().toLowerCase()] ?? u.trim();

function provenance(file: LabelFile, sha: string): string {
  const parts = [
    'manufacturer_label (operator transcription of the physical label)',
    `observed ${file.label.observed_on}`,
    file.label.observed_at ? `at ${file.label.observed_at}` : null,
    `basis ${file.label.basis}`,
    file.label.servings_per_package !== null ? `servings per package ${file.label.servings_per_package}` : null,
    `input sha256 ${sha.slice(0, 16)}`,
    file.label.notes ? `notes: ${file.label.notes}` : null,
  ].filter(Boolean);
  return parts.join('; ').slice(0, 500);
}

/** Validates the file and builds the plan, or throws LabelPlanError listing every problem. */
export function buildLabelPlan(raw: unknown, rawText?: string): LabelPlan {
  const parsed = labelFileSchema.safeParse(raw);
  if (!parsed.success) throw new LabelPlanError(parsed.error.issues.map((i) => `${i.path.join('.') || '(file)'}: ${i.message}`));
  const file = parsed.data;
  const problems: string[] = [];
  const notMapped: string[] = [];
  const warnings: string[] = [];
  const sha = createHash('sha256').update(rawText ?? JSON.stringify(raw)).digest('hex');

  const barcode = normalizeBarcode(file.barcode.code, file.barcode.format);
  if (!barcode.ok) problems.push(`barcode: ${barcode.message} (${barcode.reason})`);

  // Nutrition basis
  const { basis, serving } = file.label;
  let basisQuantity = 100;
  let basisUnit: 'g' | 'ml' = basis === 'per_100ml' ? 'ml' : 'g';
  if (basis === 'per_serving') {
    if (!serving || serving.quantity === null || serving.unit === null) {
      problems.push('label.basis: a per-serving label needs the serving mass or volume stated on the label (unresolved: the serving weight is never assumed)');
    } else {
      basisQuantity = serving.quantity;
      basisUnit = serving.unit;
    }
  }

  const servings: PlannedServing[] = [];
  if (serving) {
    if (serving.quantity === null || serving.unit === null) {
      if (basis !== 'per_serving') warnings.push(`serving "${serving.description}" states no mass or volume, so it is not stored; log this Product by ${basisUnit}`);
    } else if (serving.unit !== basisUnit) {
      // Only reachable for a per-100 basis (a per-serving basis takes the serving's own unit).
      notMapped.push(`serving "${serving.description}" = ${serving.quantity} ${serving.unit}: nutrition is per ${basisUnit} and a Product has no density, so this serving is not stored`);
      warnings.push(`log this Product by ${basisUnit}; its ${serving.unit} serving cannot be used`);
    } else {
      servings.push({ description: serving.description, quantity: serving.quantity, unit: serving.unit });
    }
  }
  if (file.product.package && file.product.package.unit !== 'count' && file.product.package.unit !== basisUnit) {
    warnings.push(`package is in ${file.product.package.unit} but nutrition is per ${basisUnit}`);
  }

  // Nutrients
  const nutrients: PlannedNutrient[] = [];
  const seen = new Set<string>();
  for (const [i, n] of file.label.nutrients.entries()) {
    const key = n.key.trim();
    const unit = normalizeUnit(n.unit);
    const canonical = CANONICAL_NUTRIENT_BY_KEY.get(key);
    if (!canonical) {
      notMapped.push(`${key} ${n.amount} ${unit}: not a canonical nutrient`);
      continue;
    }
    if (key === 'energy' && unit === 'kJ') {
      notMapped.push(`energy ${n.amount} kJ: no approved kJ to kcal conversion`);
      continue;
    }
    if (REVIEW_REQUIRED.has(key)) {
      notMapped.push(`${key} ${n.amount} ${unit}: the measure needs a mapping review; not mapped by operator entry`);
      continue;
    }
    if (key === 'available_carbohydrate') {
      problems.push(`label.nutrients.${i}: write the label's carbohydrate line as "carbohydrate" and declare its meaning with label.carbohydrate_definition`);
      continue;
    }
    if (key === 'carbohydrate' && file.label.carbohydrate_definition === 'not_stated') {
      notMapped.push(`carbohydrate ${n.amount} ${unit}: the label does not say whether this is total or available carbohydrate`);
      continue;
    }
    if (unit !== canonical.unit) {
      problems.push(`label.nutrients.${i}: ${key} must be in ${canonical.unit} (got ${n.unit}); convert on paper only if the label states it that way, never by estimate`);
      continue;
    }
    if (seen.has(key)) {
      problems.push(`label.nutrients.${i}: ${key} is listed twice`);
      continue;
    }
    // The declared definition decides the identity; nothing is converted.
    const storedKey = key === 'carbohydrate' && file.label.carbohydrate_definition === 'available' ? 'available_carbohydrate' : key;
    seen.add(key);
    nutrients.push({ key: storedKey, amount: n.amount, basis_quantity: basisQuantity, basis_unit: basisUnit });
  }

  for (const key of REQUIRED_NUTRIENTS) {
    if (seen.has(key)) continue;
    if (key === 'energy' && file.label.nutrients.some((n) => n.key.trim() === 'energy' && normalizeUnit(n.unit) === 'kJ')) {
      problems.push('energy: the label states energy in kJ only; kcal is required and kJ is never converted (needs an approved policy)');
    } else if (key === 'carbohydrate' && file.label.carbohydrate_definition === 'not_stated') {
      problems.push('carbohydrate: required, and the label must say whether it is total or available carbohydrate (it is never inferred, e.g. from the market)');
    } else {
      problems.push(`${key}: required by the initial publication policy but not stated (a stated 0 is accepted; a missing value is never invented)`);
    }
  }

  if (file.label.servings_per_package !== null && servings[0] && file.product.package && file.product.package.unit === servings[0].unit) {
    const implied = file.product.package.quantity / servings[0].quantity;
    if (Math.abs(implied - file.label.servings_per_package) / file.label.servings_per_package > 0.15) {
      warnings.push(`servings per package ${file.label.servings_per_package} differs from package/serving = ${implied.toFixed(1)}; check the transcription`);
    }
  }

  if (problems.length || !barcode.ok) throw new LabelPlanError(problems);
  return {
    synthetic: file.synthetic,
    fileSha256: sha,
    product: {
      brand_name: file.product.brand_name,
      product_name: file.product.product_name,
      variant_name: file.product.variant_name,
      manufacturer_name: file.product.manufacturer_name,
      market: file.product.market,
      package_quantity: file.product.package?.quantity ?? null,
      package_unit: file.product.package?.unit ?? null,
    },
    barcode: { gtin: barcode.gtin, barcode_type: barcode.barcode_type, submitted_code: barcode.digits },
    label: {
      effective_from: file.label.manufacturer_effective_date,
      provenance_reference: provenance(file, sha),
      nutrients: nutrients.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
      servings,
    },
    notMapped,
    warnings,
  };
}
