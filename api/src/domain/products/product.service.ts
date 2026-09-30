// Layer 11A — Product & Barcode: exact commercial product identity, barcode
// lookup and manufacturer-label nutrition (00_Master.md §16.1).
//
// Food vs Product: a Food is a generic reference identity (banana, Greek
// yogurt); a Product is one exact commercial item (Brand X Greek Yogurt 170 g,
// in one market). A Product may name a Food as its generic category; the
// Food never supplies the Product's nutrition, servings or density.
//
// Authority is identity-scoped: trusted_database is the authority for a
// generic Food; manufacturer_label is the authority for an exact Product
// (G3 — third_party_product_database values are shown but not
// authoritative). Nutrition comes from the Product's label version: its
// ProductNutrients, each read at its explicit basis, calculated by the
// single Layer 5B engine (no second engine). Missing label values stay
// missing (no Food fallback); a label 0 is a known zero.
//
// Global reference data: every query runs as the caller under RLS (SELECT
// only; no write grant). No write path exists here — products, label
// versions and barcodes are written by trusted ingestion only.

import { AppError } from '../../lib/errors';
import { IN_MEMORY_PAGE_FETCH_CAP, paginateInMemory } from '../../lib/pagination';
import type { ScopedDbClient, ScopedDbFactory } from '../../lib/scopedDb';
import type { AuthContext } from '../../types/express';
import { CONVERSION_VERSION, ROUNDING_MODE, type ServingReference } from '../conversion/conversion.engine';
import { normalizeSearchTerm } from '../foods/locale';
import { calculateNutrition, NUTRITION_CALCULATION_VERSION, NUTRITION_DECIMAL_PLACES, type NutrientDefinition } from '../nutrition/nutrition.engine';
import { loadNutrientVocabulary, toAggregateDto, toItemDto } from '../nutrition/nutrition.service';
import { projectAggregateSummary } from '../nutrition/nutritionSummary';
import type { FoodNutrientRecord } from '../nutrition/sourceResolution';
import { BARCODE_RULES_VERSION, normalizeBarcode, type BarcodeType } from './barcode';
import type { ProductNutritionCalculateRequest, ProductSearchQuery } from './product.schemas';

export const PRODUCT_NUTRITION_VERSION = 'product-nutrition-11a.1';

type NutritionSource = 'manufacturer_label' | 'third_party_product_database';

interface ProductRow {
  id: string;
  brand_name: string;
  product_name: string;
  variant_name: string | null;
  manufacturer_name: string | null;
  market: string | null;
  package_quantity: number | null;
  package_unit: 'g' | 'ml' | 'count' | null;
  food_id: string | null;
  status: 'active' | 'discontinued';
  current_label_version_id: string | null;
  source: string;
  provenance_reference: string | null;
  created_at: string;
  updated_at: string;
}
const PRODUCT_COLUMNS =
  'id, brand_name, product_name, variant_name, manufacturer_name, market, package_quantity, package_unit, food_id, status, current_label_version_id, source, provenance_reference, created_at, updated_at';

interface LabelVersionRow {
  id: string;
  product_id: string;
  version_number: number;
  status: 'current' | 'superseded';
  nutrition_source: NutritionSource;
  provenance_reference: string | null;
  effective_from: string | null;
  superseded_at: string | null;
  superseded_by_label_version_id: string | null;
  created_at: string;
}
const LABEL_COLUMNS = 'id, product_id, version_number, status, nutrition_source, provenance_reference, effective_from, superseded_at, superseded_by_label_version_id, created_at';

interface ProductNutrientRow {
  id: string;
  label_version_id: string;
  nutrient_id: string;
  amount: number;
  basis_quantity: number;
  basis_unit: 'g' | 'ml';
  source: NutritionSource;
  provenance_reference: string | null;
}
const NUTRIENT_COLUMNS = 'id, label_version_id, nutrient_id, amount, basis_quantity, basis_unit, source, provenance_reference';

interface ProductServingRow {
  id: string;
  label_version_id: string;
  serving_description: string;
  canonical_quantity: number;
  canonical_unit: 'g' | 'ml';
  source: NutritionSource;
  provenance_reference: string | null;
}
const SERVING_COLUMNS = 'id, label_version_id, serving_description, canonical_quantity, canonical_unit, source, provenance_reference';

interface BarcodeRow {
  id: string;
  product_id: string;
  gtin: string;
  barcode_type: BarcodeType;
  submitted_code: string | null;
  status: 'active' | 'retired';
  retired_at: string | null;
  source: string;
  provenance_reference: string | null;
  created_at: string;
}
const BARCODE_COLUMNS = 'id, product_id, gtin, barcode_type, submitted_code, status, retired_at, source, provenance_reference, created_at';

/** Identity-scoped authority of Product label data (G3). */
export function productAuthorityOf(source: NutritionSource): 'exact_product' | 'non_authoritative_product_source' {
  return source === 'manufacturer_label' ? 'exact_product' : 'non_authoritative_product_source';
}

const num = (v: number | string | null) => (v === null ? null : Number(v));
const cmp = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1);
const displayName = (p: ProductRow) => [p.brand_name, p.product_name, p.variant_name].filter(Boolean).join(' ');

const MATCH_KINDS = ['exact', 'prefix', 'contains'] as const;
type MatchKind = (typeof MATCH_KINDS)[number];

/** Deterministic text match: exact > prefix > contains over the normalized
 * brand, product and variant names and their combination. No fuzzy or
 * semantic matching. */
export function matchProduct(p: Pick<ProductRow, 'brand_name' | 'product_name' | 'variant_name'>, q: string): MatchKind | null {
  const fields = [p.brand_name, p.product_name, p.variant_name, displayName(p as ProductRow)].filter((f): f is string => !!f).map(normalizeSearchTerm);
  if (fields.some((f) => f === q)) return 'exact';
  if (fields.some((f) => f.startsWith(q))) return 'prefix';
  if (fields.some((f) => f.includes(q))) return 'contains';
  return null;
}

export class ProductService {
  constructor(private readonly dbFactory: ScopedDbFactory) {}

  async search(auth: AuthContext, query: ProductSearchQuery) {
    const db = this.dbFactory.forUser(auth);
    const eq: Record<string, string> = {};
    if (query.market) eq.market = query.market;
    if (query.status) eq.status = query.status;
    const products = await db.select<ProductRow>('product', { columns: PRODUCT_COLUMNS, eq, limit: IN_MEMORY_PAGE_FETCH_CAP });
    const ranked = products
      .map((p) => ({ p, match: query.q ? matchProduct(p, query.q) : null }))
      .filter((r) => !query.q || r.match !== null)
      .sort(
        (a, b) =>
          (a.match ? MATCH_KINDS.indexOf(a.match) : 0) - (b.match ? MATCH_KINDS.indexOf(b.match) : 0) ||
          cmp(a.p.brand_name.toLowerCase(), b.p.brand_name.toLowerCase()) ||
          cmp(a.p.product_name.toLowerCase(), b.p.product_name.toLowerCase()) ||
          cmp(a.p.variant_name?.toLowerCase() ?? null, b.p.variant_name?.toLowerCase() ?? null) ||
          cmp(a.p.market, b.p.market) ||
          cmp(a.p.id, b.p.id),
      );
    const barcodes = ranked.length
      ? await db.select<BarcodeRow>('barcode', { columns: BARCODE_COLUMNS, eq: { status: 'active' }, in: { product_id: ranked.map((r) => r.p.id) }, limit: 10 * IN_MEMORY_PAGE_FETCH_CAP })
      : [];
    const rows = ranked.map(({ p, match }) => ({
      ...summaryDto(p),
      active_barcodes: barcodes.filter((b) => b.product_id === p.id).map((b) => b.gtin).sort(),
      match: match ? { kind: match } : null,
    }));
    return paginateInMemory(rows, query);
  }

  async get(auth: AuthContext, productId: string) {
    const db = this.dbFactory.forUser(auth);
    const product = await loadProduct(db, productId);
    return detailDto(db, product);
  }

  async lookupBarcode(auth: AuthContext, code: string, type?: BarcodeType) {
    const normalized = normalizeBarcode(code, type);
    if (!normalized.ok) {
      throw AppError.validation('Invalid barcode.', { reason: normalized.reason, issues: [{ path: 'code', message: normalized.message }] });
    }
    const db = this.dbFactory.forUser(auth);
    const [barcode] = await db.select<BarcodeRow>('barcode', { columns: BARCODE_COLUMNS, eq: { gtin: normalized.gtin, status: 'active' }, limit: 2 });
    if (!barcode) throw AppError.notFound('No product has this barcode.');
    const product = await loadProduct(db, barcode.product_id);
    return {
      match: {
        rules_version: BARCODE_RULES_VERSION,
        submitted_digits: normalized.digits,
        submitted_type: normalized.barcode_type,
        canonical_gtin: normalized.gtin,
        barcode_id: barcode.id,
        stored_barcode_type: barcode.barcode_type,
        stored_submitted_code: barcode.submitted_code,
        match: 'exact_canonical_gtin' as const,
      },
      product: await detailDto(db, product),
    };
  }

  async calculate(auth: AuthContext, productId: string, input: ProductNutritionCalculateRequest) {
    const db = this.dbFactory.forUser(auth);
    const product = await loadProduct(db, productId);
    const labelId = input.label_version_id ?? product.current_label_version_id;
    const [label] = labelId ? await db.select<LabelVersionRow>('product_label_version', { columns: LABEL_COLUMNS, eq: { id: labelId, product_id: product.id }, limit: 1 }) : [];
    if (input.label_version_id && !label) {
      throw AppError.validation('Unknown label version.', { issues: [{ path: 'label_version_id', message: 'Label version not found for this product.' }] });
    }
    const [nutrients, servings, vocabulary] = await Promise.all([
      label ? db.select<ProductNutrientRow>('product_nutrient', { columns: NUTRIENT_COLUMNS, eq: { label_version_id: label.id }, limit: IN_MEMORY_PAGE_FETCH_CAP }) : Promise.resolve([]),
      label ? db.select<ProductServingRow>('product_serving', { columns: SERVING_COLUMNS, eq: { label_version_id: label.id }, limit: IN_MEMORY_PAGE_FETCH_CAP }) : Promise.resolve([]),
      loadNutrientVocabulary(db),
    ]);
    if (input.product_serving_id && !servings.some((s) => s.id === input.product_serving_id)) {
      throw AppError.validation('Invalid product_serving_id.', { issues: [{ path: 'product_serving_id', message: 'product_serving_id is not a serving of this label version.' }] });
    }
    return calculateProductNutrition({ product, label: label ?? null, nutrients, servings, vocabulary, input });
  }
}

/** Pure: runs one Product quantity through the Layer 5B engine with the
 * label's own nutrients and servings only (no Food data, no density). */
export function calculateProductNutrition(args: {
  product: ProductRow;
  label: LabelVersionRow | null;
  nutrients: readonly ProductNutrientRow[];
  servings: readonly ProductServingRow[];
  vocabulary: readonly NutrientDefinition[];
  input: ProductNutritionCalculateRequest;
}) {
  const { product, label, nutrients, servings, vocabulary, input } = args;
  const authoritative = label?.nutrition_source === 'manufacturer_label';
  // Only the authoritative label's values and servings reach the engine (G3).
  const records: FoodNutrientRecord[] = authoritative
    ? nutrients.map((n) => ({ id: n.id, nutrient_id: n.nutrient_id, amount: Number(n.amount), basis_quantity: Number(n.basis_quantity), basis_unit: n.basis_unit, source: 'manufacturer_label' }))
    : [];
  const servingRefs: ServingReference[] = authoritative
    ? servings.map((s) => ({ id: s.id, serving_description: s.serving_description, region: product.market, canonical_quantity: Number(s.canonical_quantity), canonical_unit: s.canonical_unit, source: 'manufacturer_label' }))
    : [];
  const amount = input.product_serving_id ? { serving_id: input.product_serving_id } : { unit: input.unit ?? '' };
  const result = calculateNutrition([{ food: { food_id: product.id, canonical_name: displayName(product), density: null, servings: servingRefs, nutrients: records }, quantity: input.quantity, amount }], vocabulary);
  const item = toItemDto(result.items[0] as NonNullable<(typeof result.items)[0]>);
  const nonAuthoritative = new Map(authoritative ? [] : nutrients.map((n) => [n.nutrient_id, n]));

  return {
    calculation_version: NUTRITION_CALCULATION_VERSION,
    product_nutrition_version: PRODUCT_NUTRITION_VERSION,
    conversion_version: CONVERSION_VERSION,
    precision: { decimal_places: NUTRITION_DECIMAL_PLACES, rounding: ROUNDING_MODE },
    nutrition_scope: 'exact_product' as const,
    generic_food_fallback: 'none' as const,
    product: { id: product.id, brand_name: product.brand_name, product_name: product.product_name, variant_name: product.variant_name, market: product.market, status: product.status },
    label_version: label ? labelSummaryDto(label) : null,
    label_status: !label ? ('no_label_version' as const) : authoritative ? ('authoritative_label' as const) : ('non_authoritative_label' as const),
    input: { quantity: input.quantity, unit: input.unit ?? null, product_serving_id: input.product_serving_id ?? null },
    normalized_quantity: item.normalized_quantity,
    nutrients: item.nutrients.map((n) => {
      const excludedRow = nonAuthoritative.get(n.nutrient_id);
      if (excludedRow) {
        return {
          ...n,
          status: 'not_authoritative' as const,
          source: null,
          excluded: [{ product_nutrient_id: excludedRow.id, source: excludedRow.source, authority: productAuthorityOf(excludedRow.source), reason: 'not_authoritative_for_product' as const }],
        };
      }
      const { source, candidates, ...rest } = n;
      return {
        ...rest,
        excluded: [] as unknown[],
        source: source && {
          product_nutrient_id: source.food_nutrient_id,
          source: source.source,
          authority: 'exact_product' as const,
          amount_per_basis: source.amount_per_basis,
          basis_quantity: source.basis_quantity,
          basis_unit: source.basis_unit,
          quantity_in_basis_unit: source.quantity_in_basis_unit,
        },
        ...(candidates.length ? { candidates } : {}),
      };
    }),
    coverage_summary: toAggregateDto(result.aggregate, 1).coverage_summary,
    summary: projectAggregateSummary(result.aggregate, 1),
  };
}

async function loadProduct(db: ScopedDbClient, productId: string): Promise<ProductRow> {
  const [product] = await db.select<ProductRow>('product', { columns: PRODUCT_COLUMNS, eq: { id: productId }, limit: 1 });
  if (!product) throw AppError.notFound('Product not found.');
  return product;
}

function summaryDto(p: ProductRow) {
  return {
    id: p.id,
    brand_name: p.brand_name,
    product_name: p.product_name,
    variant_name: p.variant_name,
    manufacturer_name: p.manufacturer_name,
    display_name: displayName(p),
    market: p.market,
    package: p.package_quantity === null ? null : { quantity: num(p.package_quantity), unit: p.package_unit },
    status: p.status,
    generic_food_id: p.food_id,
  };
}

function labelSummaryDto(l: LabelVersionRow) {
  return {
    id: l.id,
    version_number: l.version_number,
    status: l.status,
    nutrition_source: l.nutrition_source,
    authority: productAuthorityOf(l.nutrition_source),
    provenance_reference: l.provenance_reference,
    effective_from: l.effective_from,
    published_at: l.created_at,
    superseded_at: l.superseded_at,
    superseded_by_label_version_id: l.superseded_by_label_version_id,
  };
}

async function detailDto(db: ScopedDbClient, product: ProductRow) {
  const [labels, barcodes, food, vocabulary] = await Promise.all([
    db.select<LabelVersionRow>('product_label_version', { columns: LABEL_COLUMNS, eq: { product_id: product.id }, limit: IN_MEMORY_PAGE_FETCH_CAP }),
    db.select<BarcodeRow>('barcode', { columns: BARCODE_COLUMNS, eq: { product_id: product.id }, limit: IN_MEMORY_PAGE_FETCH_CAP }),
    product.food_id ? db.select<{ id: string; canonical_name: string }>('food', { columns: 'id, canonical_name', eq: { id: product.food_id }, limit: 1 }) : Promise.resolve([]),
    loadNutrientVocabulary(db),
  ]);
  const current = labels.find((l) => l.id === product.current_label_version_id) ?? null;
  const [nutrients, servings] = current
    ? await Promise.all([
        db.select<ProductNutrientRow>('product_nutrient', { columns: NUTRIENT_COLUMNS, eq: { label_version_id: current.id }, limit: IN_MEMORY_PAGE_FETCH_CAP }),
        db.select<ProductServingRow>('product_serving', { columns: SERVING_COLUMNS, eq: { label_version_id: current.id }, limit: IN_MEMORY_PAGE_FETCH_CAP }),
      ])
    : [[], []];
  const byId = new Map(vocabulary.map((v) => [v.id, v]));
  return {
    ...summaryDto(product),
    generic_food: food[0] ? { id: food[0].id, canonical_name: food[0].canonical_name, relationship: 'generic_category_only' as const } : null,
    source: product.source,
    provenance_reference: product.provenance_reference,
    created_at: product.created_at,
    updated_at: product.updated_at,
    barcodes: barcodes
      .sort((a, b) => cmp(a.status, b.status) || cmp(a.gtin, b.gtin) || cmp(a.id, b.id))
      .map((b) => ({ id: b.id, gtin: b.gtin, barcode_type: b.barcode_type, submitted_code: b.submitted_code, status: b.status, retired_at: b.retired_at, source: b.source, provenance_reference: b.provenance_reference })),
    current_label: current
      ? {
          ...labelSummaryDto(current),
          nutrients: nutrients
            .map((n) => ({ row: n, def: byId.get(n.nutrient_id) }))
            .sort((a, b) => cmp(a.def?.canonical_key ?? null, b.def?.canonical_key ?? null))
            .map(({ row, def }) => ({
              product_nutrient_id: row.id,
              nutrient_key: def?.canonical_key ?? null,
              nutrient_role: def?.role ?? 'other',
              unit: def?.unit ?? null,
              amount: Number(row.amount),
              is_zero: Number(row.amount) === 0,
              basis_quantity: Number(row.basis_quantity),
              basis_unit: row.basis_unit,
              source: row.source,
              authority: productAuthorityOf(row.source),
              provenance_reference: row.provenance_reference,
            })),
          servings: servings
            .sort((a, b) => cmp(a.serving_description, b.serving_description) || cmp(a.id, b.id))
            .map((s) => ({ id: s.id, serving_description: s.serving_description, canonical_quantity: Number(s.canonical_quantity), canonical_unit: s.canonical_unit, source: s.source, provenance_reference: s.provenance_reference })),
          completeness: {
            nutrients_on_label: nutrients.length,
            vocabulary_size: vocabulary.length,
            missing_nutrient_keys: vocabulary.filter((v) => !nutrients.some((n) => n.nutrient_id === v.id)).map((v) => v.canonical_key),
          },
        }
      : null,
    label_versions: labels.sort((a, b) => b.version_number - a.version_number).map(labelSummaryDto),
  };
}
