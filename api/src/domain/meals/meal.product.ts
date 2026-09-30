// Layer 11B — Product consumption for Layer 7A MealItems.
//
// Chain: barcode (input only) -> canonical GTIN -> active Barcode -> Product
// -> exact ProductLabelVersion -> quantity | ProductServing of THAT label
// -> Layer 11A product calculation (Layer 5B engine; the label's own
// nutrients and servings; no Food data, no density) -> immutable snapshot.
// The MealItem stores product_id + the exact product_label_version_id; a
// later label, a Product display edit or a barcode retirement never
// changes it.
//
// Label-version selection (approved 11B G1/G2) is deterministic:
//  - A label is IN EFFECT at consumption C when it was published by C and
//    its effective_from (if set) is on or before C's local date.
//  - The current label is used automatically when it was in effect at C, or
//    when the Product has only ever had one label.
//  - Otherwise (a newer label appeared after C) the applicable label is
//    ambiguous: the server never guesses and never silently uses today's
//    label. It answers 409 with the candidates — every label not already
//    replaced before C (a newer label in effect by C) — and the client
//    confirms one with `label_version_id`. The database re-checks this
//    (meal_item_product_label_applicable).
//  - `label_version_id` is refused when nothing is ambiguous, so ordinary
//    logging cannot pick an old label to change nutrition.
//  - A correction that keeps the same Product reuses the original's exact
//    label version (G2); a correction to another Product selects its label
//    by the rules above.
// A retired or unknown barcode is not found (Layer 11A lookup rule); the
// barcode used is kept as provenance and never re-resolved.

import type { ScopedDbClient } from '../../lib/scopedDb';
import type { NutrientDefinition } from '../nutrition/nutrition.engine';
import { NUTRITION_CALCULATION_VERSION } from '../nutrition/nutrition.engine';
import { BARCODE_RULES_VERSION, normalizeBarcode } from '../products/barcode';
import {
  BARCODE_COLUMNS,
  computeProductNutrition,
  LABEL_COLUMNS,
  labelSummaryDto,
  NUTRIENT_COLUMNS,
  PRODUCT_COLUMNS,
  PRODUCT_NUTRITION_VERSION,
  productAuthorityOf,
  SERVING_COLUMNS,
  type BarcodeRow,
  type LabelVersionRow,
  type ProductNutrientRow,
  type ProductRow,
  type ProductServingRow,
} from '../products/product.service';
import { IN_MEMORY_PAGE_FETCH_CAP } from '../../lib/pagination';
import type { ProductItemInput } from './meal.schemas';
import { buildProductSnapshot, type MealItemSnapshot, type ProductSnapshotSource } from './meal.snapshot';

export type LabelSelectionBasis = ProductSnapshotSource['label_version_selection'];

export type LabelSelection =
  | { kind: 'selected'; label: LabelVersionRow; basis: LabelSelectionBasis }
  | { kind: 'confirmation_required'; candidates: LabelVersionRow[]; suggested: LabelVersionRow | null }
  | { kind: 'no_label' }
  | { kind: 'invalid'; message: string };

export interface LabelSelectionInput {
  labels: readonly LabelVersionRow[];
  currentLabelId: string | null;
  /** The consumption instant and its local date in the meal's time zone. */
  consumedAt: string;
  consumedLocalDate: string;
  requestedLabelId?: string;
  /** A same-Product correction: the original item's exact label (G2). */
  originalLabelId?: string;
}

const instant = (value: string) => Date.parse(value);

/** Published by `consumedAt` and in effect on its local date. */
export function labelInEffect(label: LabelVersionRow, consumedAt: string, consumedLocalDate: string): boolean {
  return instant(label.created_at) <= instant(consumedAt) && (label.effective_from === null || label.effective_from <= consumedLocalDate);
}

/** A newer label of the same Product was already in effect by `consumedAt`. */
export function labelReplacedBefore(label: LabelVersionRow, labels: readonly LabelVersionRow[], consumedAt: string, consumedLocalDate: string): boolean {
  return labels.some((l) => l.version_number > label.version_number && labelInEffect(l, consumedAt, consumedLocalDate));
}

/** Pure, deterministic label-version selection (see header). */
export function selectLabelVersion(input: LabelSelectionInput): LabelSelection {
  const { labels, consumedAt, consumedLocalDate, requestedLabelId } = input;
  const byId = new Map(labels.map((l) => [l.id, l]));

  if (input.originalLabelId !== undefined && (requestedLabelId === undefined || requestedLabelId === input.originalLabelId)) {
    const original = byId.get(input.originalLabelId);
    if (original) return { kind: 'selected', label: original, basis: 'correction_original_label' };
  }

  const current = input.currentLabelId ? byId.get(input.currentLabelId) : undefined;
  if (!current) return { kind: 'no_label' };

  if (labels.length === 1 || labelInEffect(current, consumedAt, consumedLocalDate)) {
    if (requestedLabelId === undefined || requestedLabelId === current.id) return { kind: 'selected', label: current, basis: 'current_label' };
    return {
      kind: 'invalid',
      message: 'The current label version applies at consumed_at; label_version_id can only be chosen when the applicable label is ambiguous.',
    };
  }

  const candidates = labels
    .filter((l) => !labelReplacedBefore(l, labels, consumedAt, consumedLocalDate))
    .sort((a, b) => a.version_number - b.version_number);
  if (requestedLabelId === undefined) {
    // A hint only (never applied): the newest candidate already in effect at C.
    const inEffect = candidates.filter((l) => labelInEffect(l, consumedAt, consumedLocalDate));
    return { kind: 'confirmation_required', candidates, suggested: inEffect[inEffect.length - 1] ?? null };
  }
  const chosen = candidates.find((l) => l.id === requestedLabelId);
  if (!chosen) return { kind: 'invalid', message: 'label_version_id is not a label version of this product that could have applied at consumed_at.' };
  return { kind: 'selected', label: chosen, basis: 'user_confirmed_backdated' };
}

export interface PreparedProductItem {
  food_id: null;
  food_serving_id: null;
  recipe_version_id: null;
  unit: string | null;
  product_id: string;
  product_label_version_id: string;
  product_serving_id: string | null;
  logged_via_barcode_id: string | null;
  quantity: number;
  consumed_at: string;
  nutrition_snapshot: MealItemSnapshot;
  nutrition_calculation_version: string;
}

export type ProductPreparation =
  | { kind: 'prepared'; item: PreparedProductItem }
  | { kind: 'issue'; path: string; message: string; reason?: string }
  | { kind: 'barcode_not_found'; path: string }
  | { kind: 'no_label'; path: string }
  | { kind: 'confirmation_required'; path: string; details: Record<string, unknown> };

interface ProductItemContext {
  /** `items.0` style prefix for error paths. */
  path: string;
  consumedAt: string;
  consumedLocalDate: string;
  vocabulary: readonly NutrientDefinition[];
  /** Set for a correction of a Product item (G2). */
  original?: { product_id: string; product_label_version_id: string };
}

async function labelContent(db: ScopedDbClient, labelId: string) {
  const [nutrients, servings] = await Promise.all([
    db.select<ProductNutrientRow>('product_nutrient', { columns: NUTRIENT_COLUMNS, eq: { label_version_id: labelId }, limit: IN_MEMORY_PAGE_FETCH_CAP }),
    db.select<ProductServingRow>('product_serving', { columns: SERVING_COLUMNS, eq: { label_version_id: labelId }, limit: IN_MEMORY_PAGE_FETCH_CAP }),
  ]);
  return { nutrients, servings };
}

const servingDto = (s: ProductServingRow) => ({
  id: s.id,
  serving_description: s.serving_description,
  canonical_quantity: Number(s.canonical_quantity),
  canonical_unit: s.canonical_unit,
});

/** Resolves, validates and calculates one Product item. Reads reference
 * data only; writes nothing. */
export async function prepareProductItem(db: ScopedDbClient, input: ProductItemInput, ctx: ProductItemContext): Promise<ProductPreparation> {
  let product: ProductRow | undefined;
  let barcode: { row: BarcodeRow; digits: string; type: string } | null = null;

  if (input.barcode !== undefined) {
    const normalized = normalizeBarcode(input.barcode, input.barcode_type);
    if (!normalized.ok) return { kind: 'issue', path: `${ctx.path}.barcode`, message: normalized.message, reason: normalized.reason };
    // Layer 11A rule: only ACTIVE barcodes resolve; retired/unknown = not found.
    const [row] = await db.select<BarcodeRow>('barcode', { columns: BARCODE_COLUMNS, eq: { gtin: normalized.gtin, status: 'active' }, limit: 2 });
    if (!row) return { kind: 'barcode_not_found', path: `${ctx.path}.barcode` };
    barcode = { row, digits: normalized.digits, type: normalized.barcode_type };
    [product] = await db.select<ProductRow>('product', { columns: PRODUCT_COLUMNS, eq: { id: row.product_id }, limit: 1 });
    if (!product) return { kind: 'barcode_not_found', path: `${ctx.path}.barcode` };
  } else {
    [product] = await db.select<ProductRow>('product', { columns: PRODUCT_COLUMNS, eq: { id: input.product_id ?? '' }, limit: 1 });
    if (!product) return { kind: 'issue', path: `${ctx.path}.product_id`, message: 'Product not found.' };
  }

  const labels = await db.select<LabelVersionRow>('product_label_version', { columns: LABEL_COLUMNS, eq: { product_id: product.id }, limit: IN_MEMORY_PAGE_FETCH_CAP });
  const selection = selectLabelVersion({
    labels,
    currentLabelId: product.current_label_version_id,
    consumedAt: ctx.consumedAt,
    consumedLocalDate: ctx.consumedLocalDate,
    ...(input.label_version_id !== undefined ? { requestedLabelId: input.label_version_id } : {}),
    ...(ctx.original && ctx.original.product_id === product.id ? { originalLabelId: ctx.original.product_label_version_id } : {}),
  });

  if (selection.kind === 'no_label') return { kind: 'no_label', path: ctx.path };
  if (selection.kind === 'invalid') return { kind: 'issue', path: `${ctx.path}.label_version_id`, message: selection.message };
  if (selection.kind === 'confirmation_required') {
    const candidates = await Promise.all(
      selection.candidates.map(async (label) => {
        const content = await labelContent(db, label.id);
        const servingId = input.product_serving_id !== undefined && content.servings.some((s) => s.id === input.product_serving_id) ? input.product_serving_id : undefined;
        const calculable = input.unit !== undefined || servingId !== undefined;
        return {
          ...labelSummaryDto(label),
          servings: content.servings.map(servingDto),
          nutrition_for_input: calculable
            ? computeProductNutrition({
                product,
                label,
                ...content,
                vocabulary: ctx.vocabulary,
                input: { quantity: input.quantity, ...(servingId !== undefined ? { product_serving_id: servingId } : { unit: input.unit ?? '' }) },
              }).result.summary
            : null,
        };
      }),
    );
    return {
      kind: 'confirmation_required',
      path: ctx.path,
      details: {
        path: ctx.path,
        product_id: product.id,
        consumed_at: ctx.consumedAt,
        consumed_local_date: ctx.consumedLocalDate,
        current_label_version_id: product.current_label_version_id,
        suggested_label_version_id: selection.suggested?.id ?? null,
        candidates,
      },
    };
  }

  const label = selection.label;
  const content = await labelContent(db, label.id);
  const serving = input.product_serving_id !== undefined ? content.servings.find((s) => s.id === input.product_serving_id) : undefined;
  if (input.product_serving_id !== undefined && !serving) {
    return {
      kind: 'issue',
      path: `${ctx.path}.product_serving_id`,
      message: `product_serving_id is not a serving of this product's label version ${label.version_number}.`,
    };
  }

  const computed = computeProductNutrition({
    product,
    label,
    ...content,
    vocabulary: ctx.vocabulary,
    input: { quantity: input.quantity, ...(serving ? { product_serving_id: serving.id } : { unit: input.unit ?? '' }) },
  });
  const unit = serving ? null : (input.unit ?? null);
  const source: ProductSnapshotSource = {
    type: 'product',
    product_id: product.id,
    brand_name: product.brand_name,
    product_name: product.product_name,
    variant_name: product.variant_name,
    market: product.market,
    package: product.package_quantity === null ? null : { quantity: Number(product.package_quantity), unit: product.package_unit },
    label_version: {
      id: label.id,
      version_number: label.version_number,
      nutrition_source: label.nutrition_source,
      authority: productAuthorityOf(label.nutrition_source),
      effective_from: label.effective_from,
      published_at: label.created_at,
    },
    label_version_selection: selection.basis,
    quantity: input.quantity,
    unit,
    serving: serving
      ? {
          product_serving_id: serving.id,
          description: serving.serving_description,
          canonical_quantity: Number(serving.canonical_quantity),
          canonical_unit: serving.canonical_unit,
          source: serving.source,
        }
      : null,
    barcode: barcode
      ? { barcode_id: barcode.row.id, canonical_gtin: barcode.row.gtin, submitted_digits: barcode.digits, submitted_type: barcode.type, rules_version: BARCODE_RULES_VERSION }
      : null,
    product_nutrition_version: PRODUCT_NUTRITION_VERSION,
    generic_food_fallback: 'none',
  };

  return {
    kind: 'prepared',
    item: {
      food_id: null,
      food_serving_id: null,
      recipe_version_id: null,
      unit,
      product_id: product.id,
      product_label_version_id: label.id,
      product_serving_id: serving?.id ?? null,
      logged_via_barcode_id: barcode?.row.id ?? null,
      quantity: input.quantity,
      consumed_at: ctx.consumedAt,
      nutrition_calculation_version: NUTRITION_CALCULATION_VERSION,
      nutrition_snapshot: buildProductSnapshot(computed.calculation, computed.nonAuthoritativeNutrientIds, source, computed.result),
    },
  };
}
