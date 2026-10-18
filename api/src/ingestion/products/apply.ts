// Layer 12B.2a — publish a label plan as trusted Product reference data.
//
// Runs as the database owner over the operator's direct connection (never an
// API route, never a client token, never a service-role key). One transaction
// per label; a transaction-scoped advisory lock on the canonical GTIN
// serializes concurrent runs for the same barcode.
//
// Decision per canonical GTIN:
//   active barcode, same Product identity, same current label -> UNCHANGED (nothing written)
//   active barcode, same identity, different label            -> STOP unless the operator
//                                                                confirms a new label version;
//                                                                then version n+1 (n superseded)
//   active barcode, different Product identity                -> STOP (identity is never changed)
//   only a retired barcode with this GTIN                     -> STOP (reassignment is a separate workflow)
//   no barcode, but a Product with the same identity exists   -> STOP (possible duplicate Product)
//   no barcode, no such Product                               -> CREATE Product + barcode + version 1
// Writes go through the existing schema: Product and Barcode inserts, then
// publish_product_label_version() (Layer 11A), whose triggers number the
// version, supersede the previous one and seal its nutrients and servings.
// Dry run (the default) performs every check and write, then rolls back.

import type { ClientBase } from 'pg';
import { CANONICAL_NUTRIENT_BY_KEY } from '../../domain/nutrition/vocabulary';
import type { LabelPlan } from './plan';

export type LabelOutcome = 'created' | 'new_label_version' | 'unchanged';
export type LabelConflict =
  | 'label_changed_needs_confirmation'
  | 'product_identity_mismatch'
  | 'barcode_previously_retired'
  | 'possible_duplicate_product'
  | 'nutrient_vocabulary_mismatch';

export interface LabelResult {
  outcome: LabelOutcome;
  committed: boolean;
  product_id: string;
  label_version_id: string | null;
  version_number: number | null;
  /** Differences from the current label, when one exists. */
  changes: string[];
}

export class LabelConflictError extends Error {
  constructor(
    readonly conflict: LabelConflict,
    readonly details: string[],
  ) {
    super(`Stopped (${conflict}); nothing was written:\n  - ${details.join('\n  - ')}`);
    this.name = 'LabelConflictError';
  }
}

export interface ApplyLabelOptions {
  dryRun: boolean;
  /** The operator confirms the label is a genuine new manufacturer-label version. */
  confirmNewLabelVersion: boolean;
}

interface ProductRow {
  id: string;
  brand_name: string;
  product_name: string;
  variant_name: string | null;
  manufacturer_name: string | null;
  market: string | null;
  package_quantity: string | null;
  package_unit: string | null;
  current_label_version_id: string | null;
}

const same = (a: string | null, b: string | null) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
const num = (v: string | number | null) => (v === null ? null : Number(v));

function identityDifferences(row: ProductRow, plan: LabelPlan): string[] {
  const p = plan.product;
  const diffs: string[] = [];
  const check = (field: string, stored: string | null, planned: string | null) => {
    if (!same(stored, planned)) diffs.push(`${field}: stored "${stored ?? ''}", file "${planned ?? ''}"`);
  };
  check('brand_name', row.brand_name, p.brand_name);
  check('product_name', row.product_name, p.product_name);
  check('variant_name', row.variant_name, p.variant_name);
  check('manufacturer_name', row.manufacturer_name, p.manufacturer_name);
  check('market', row.market, p.market);
  if (num(row.package_quantity) !== p.package_quantity || row.package_unit !== p.package_unit) {
    diffs.push(`package: stored ${row.package_quantity ?? '-'} ${row.package_unit ?? ''}, file ${p.package_quantity ?? '-'} ${p.package_unit ?? ''}`);
  }
  return diffs;
}

async function currentLabelDifferences(client: ClientBase, labelVersionId: string, plan: LabelPlan): Promise<string[]> {
  const version = await client.query<{ nutrition_source: string; effective_from: string | null }>(
    "select nutrition_source::text, to_char(effective_from, 'YYYY-MM-DD') as effective_from from product_label_version where id = $1",
    [labelVersionId],
  );
  const nutrients = await client.query<{ key: string; amount: string; basis_quantity: string; basis_unit: string }>(
    'select n.canonical_key as key, pn.amount::text, pn.basis_quantity::text, pn.basis_unit from product_nutrient pn join nutrient n on n.id = pn.nutrient_id where pn.label_version_id = $1',
    [labelVersionId],
  );
  const servings = await client.query<{ description: string; quantity: string; unit: string }>(
    'select serving_description as description, canonical_quantity::text as quantity, canonical_unit as unit from product_serving where label_version_id = $1',
    [labelVersionId],
  );
  const diffs: string[] = [];
  const v = version.rows[0];
  if (v?.nutrition_source !== 'manufacturer_label') diffs.push(`current label source is ${v?.nutrition_source}, not manufacturer_label`);
  if ((v?.effective_from ?? null) !== plan.label.effective_from) diffs.push(`effective date: stored ${v?.effective_from ?? 'none'}, file ${plan.label.effective_from ?? 'none'}`);

  const stored = new Map(nutrients.rows.map((r) => [r.key, r]));
  for (const n of plan.label.nutrients) {
    const s = stored.get(n.key);
    if (!s) diffs.push(`${n.key}: not on the current label, file ${n.amount}`);
    else if (Number(s.amount) !== n.amount || Number(s.basis_quantity) !== n.basis_quantity || s.basis_unit !== n.basis_unit) {
      diffs.push(`${n.key}: stored ${Number(s.amount)} per ${Number(s.basis_quantity)} ${s.basis_unit}, file ${n.amount} per ${n.basis_quantity} ${n.basis_unit}`);
    }
    stored.delete(n.key);
  }
  for (const key of stored.keys()) diffs.push(`${key}: on the current label, not in the file`);

  const servingKey = (d: string, q: number, u: string) => `${d.trim().toLowerCase()}|${q}|${u}`;
  const storedServings = new Set(servings.rows.map((s) => servingKey(s.description, Number(s.quantity), s.unit)));
  const plannedServings = new Set(plan.label.servings.map((s) => servingKey(s.description, s.quantity, s.unit)));
  if (storedServings.size !== plannedServings.size || [...plannedServings].some((s) => !storedServings.has(s))) {
    diffs.push(`servings: stored [${[...storedServings].join(', ')}], file [${[...plannedServings].join(', ')}]`);
  }
  return diffs;
}

async function nutrientIds(client: ClientBase, plan: LabelPlan): Promise<Map<string, string>> {
  const { rows } = await client.query<{ id: string; canonical_key: string; unit: string }>('select id, canonical_key, unit from nutrient where canonical_key = any($1::text[])', [
    plan.label.nutrients.map((n) => n.key),
  ]);
  const byKey = new Map(rows.map((r) => [r.canonical_key, r]));
  const problems = plan.label.nutrients
    .filter((n) => byKey.get(n.key)?.unit !== CANONICAL_NUTRIENT_BY_KEY.get(n.key)?.unit)
    .map((n) => `${n.key}: not in the database vocabulary with unit ${CANONICAL_NUTRIENT_BY_KEY.get(n.key)?.unit}`);
  if (problems.length) throw new LabelConflictError('nutrient_vocabulary_mismatch', problems);
  return new Map(rows.map((r) => [r.canonical_key, r.id]));
}

async function publish(client: ClientBase, productId: string, plan: LabelPlan, ids: Map<string, string>) {
  const nutrients = plan.label.nutrients.map((n) => ({ nutrient_id: ids.get(n.key), amount: n.amount, basis_quantity: n.basis_quantity, basis_unit: n.basis_unit }));
  const servings = plan.label.servings.map((s) => ({ serving_description: s.description, canonical_quantity: s.quantity, canonical_unit: s.unit }));
  const { rows } = await client.query<{ id: string }>("select publish_product_label_version($1, 'manufacturer_label', $2, $3::date, $4::jsonb, $5::jsonb) as id", [
    productId,
    plan.label.provenance_reference,
    plan.label.effective_from,
    JSON.stringify(nutrients),
    JSON.stringify(servings),
  ]);
  const id = rows[0]!.id;
  const version = await client.query<{ version_number: number }>('select version_number from product_label_version where id = $1', [id]);
  return { id, version_number: version.rows[0]!.version_number };
}

export async function applyLabelPlan(client: ClientBase, plan: LabelPlan, options: ApplyLabelOptions): Promise<LabelResult> {
  await client.query('begin');
  try {
    await client.query("select pg_advisory_xact_lock(hashtextextended('product_label_entry:' || $1, 0))", [plan.barcode.gtin]);
    const ids = await nutrientIds(client, plan);
    const barcodes = await client.query<{ product_id: string; status: string }>('select product_id, status::text from barcode where gtin = $1', [plan.barcode.gtin]);
    const active = barcodes.rows.find((b) => b.status === 'active');
    let result: LabelResult;

    if (active) {
      const product = (await client.query<ProductRow>('select * from product where id = $1', [active.product_id])).rows[0]!;
      const identity = identityDifferences(product, plan);
      if (identity.length) throw new LabelConflictError('product_identity_mismatch', [`barcode ${plan.barcode.gtin} belongs to Product ${product.id}`, ...identity]);
      const changes = product.current_label_version_id ? await currentLabelDifferences(client, product.current_label_version_id, plan) : ['the Product has no label version yet'];
      if (!changes.length) {
        result = { outcome: 'unchanged', committed: false, product_id: product.id, label_version_id: product.current_label_version_id, version_number: null, changes };
      } else if (!options.confirmNewLabelVersion) {
        throw new LabelConflictError('label_changed_needs_confirmation', [
          `Product ${product.id} has a different current label; confirm only if the manufacturer label itself changed (--new-label-version)`,
          ...changes,
        ]);
      } else {
        const published = await publish(client, product.id, plan, ids);
        result = { outcome: 'new_label_version', committed: false, product_id: product.id, label_version_id: published.id, version_number: published.version_number, changes };
      }
    } else if (barcodes.rows.length) {
      throw new LabelConflictError('barcode_previously_retired', [`barcode ${plan.barcode.gtin} was retired from Product ${barcodes.rows[0]!.product_id}; reuse needs the separate reassignment workflow`]);
    } else {
      const twins = await client.query<{ id: string }>(
        `select id from product
          where lower(btrim(brand_name)) = lower(btrim($1)) and lower(btrim(product_name)) = lower(btrim($2))
            and coalesce(lower(btrim(variant_name)), '') = coalesce(lower(btrim($3)), '') and market is not distinct from $4`,
        [plan.product.brand_name, plan.product.product_name, plan.product.variant_name, plan.product.market],
      );
      if (twins.rows.length) {
        throw new LabelConflictError('possible_duplicate_product', [`a Product with this brand, name, variant and market already exists (${twins.rows.map((r) => r.id).join(', ')}) under another barcode`]);
      }
      const p = plan.product;
      const created = await client.query<{ id: string }>(
        `insert into product (brand_name, product_name, variant_name, manufacturer_name, market, package_quantity, package_unit, food_id, source, provenance_reference)
         values ($1, $2, $3, $4, $5, $6, $7, null, 'manufacturer_data', $8) returning id`,
        [p.brand_name, p.product_name, p.variant_name, p.manufacturer_name, p.market, p.package_quantity, p.package_unit, plan.label.provenance_reference],
      );
      const productId = created.rows[0]!.id;
      await client.query("insert into barcode (product_id, gtin, barcode_type, submitted_code, source, provenance_reference) values ($1, $2, $3, $4, 'manufacturer_data', $5)", [
        productId,
        plan.barcode.gtin,
        plan.barcode.barcode_type,
        plan.barcode.submitted_code,
        plan.label.provenance_reference,
      ]);
      const published = await publish(client, productId, plan, ids);
      result = { outcome: 'created', committed: false, product_id: productId, label_version_id: published.id, version_number: published.version_number, changes: [] };
    }

    if (options.dryRun || result.outcome === 'unchanged') {
      await client.query('rollback');
    } else {
      await client.query('commit');
      result.committed = true;
    }
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  }
}
