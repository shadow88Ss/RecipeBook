// Layer 12B.2a — operator command: publish one manufacturer label as trusted
// Product reference data. NOT part of the API server (app.ts never imports
// this; `pg` is a dev dependency, absent from the production image).
//
//   npm run publish:label -- --file <label.json> --project-ref <ref> [--ca-file <pem>]
//       [--new-label-version] [--apply --confirm <gtin>]
//
// The connection string comes from INGEST_DATABASE_URL in the operator's own
// shell (never a file in the repo, never printed); it must name the project
// ref, and TLS certificates are always verified. Without --apply the run is
// a dry run (every check and write inside a transaction that is rolled back).
// --apply also needs --confirm with the canonical GTIN the dry run printed,
// so a write is always a deliberate, reviewed act.

import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { CANONICAL_NUTRIENTS } from '../../domain/nutrition/vocabulary';
import { checkTarget } from '../usda/cli';
import { applyLabelPlan, LabelConflictError, type LabelResult } from './apply';
import { buildLabelPlan, LabelPlanError, type LabelPlan } from './plan';

export interface LabelCliArgs {
  file: string;
  projectRef: string;
  caFile: string | null;
  apply: boolean;
  confirm: string | null;
  newLabelVersion: boolean;
}

export function parseLabelArgs(argv: string[]): LabelCliArgs {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const file = get('file');
  const projectRef = get('project-ref');
  if (!file || !projectRef) {
    throw new Error('Usage: npm run publish:label -- --file <label.json> --project-ref <ref> [--ca-file <pem>] [--new-label-version] [--apply --confirm <gtin>]');
  }
  if (!/^[a-z0-9]{6,40}$/.test(projectRef) && projectRef !== 'local') throw new Error('--project-ref must be a Supabase project ref (or "local")');
  const apply = argv.includes('--apply');
  const confirm = get('confirm') ?? null;
  if (apply && !confirm) throw new Error('--apply needs --confirm <canonical GTIN> as printed by the dry run');
  return { file, projectRef, caFile: get('ca-file') ?? null, apply, confirm, newLabelVersion: argv.includes('--new-label-version') };
}

/** The plan as the operator must review it (no connection details). */
export function describePlan(plan: LabelPlan): string {
  const p = plan.product;
  const lines = [
    `Product: ${p.brand_name} | ${p.product_name}${p.variant_name ? ` | ${p.variant_name}` : ''} | market ${p.market}${p.package_quantity !== null ? ` | package ${p.package_quantity} ${p.package_unit}` : ''}`,
    `Barcode: canonical GTIN ${plan.barcode.gtin} (${plan.barcode.barcode_type}, submitted ${plan.barcode.submitted_code})`,
    `Label: manufacturer_label, effective date ${plan.label.effective_from ?? 'not stated'}`,
    `Nutrition (stored, per ${plan.label.nutrients[0]?.basis_quantity} ${plan.label.nutrients[0]?.basis_unit}):`,
    ...plan.label.nutrients.map((n) => `  ${n.key.padEnd(13)} ${n.amount} ${CANONICAL_UNIT[n.key] ?? ''}`),
    `Servings: ${plan.label.servings.length ? plan.label.servings.map((s) => `"${s.description}" = ${s.quantity} ${s.unit}`).join('; ') : 'none (log by weight/volume)'}`,
    ...plan.notMapped.map((m) => `Not stored: ${m}`),
    ...plan.warnings.map((w) => `WARNING: ${w}`),
    `Provenance: ${plan.label.provenance_reference}`,
  ];
  if (plan.synthetic) lines.unshift('SYNTHETIC EXAMPLE FILE: dry run only, never published.');
  return lines.join('\n');
}

const CANONICAL_UNIT: Record<string, string> = Object.fromEntries(CANONICAL_NUTRIENTS.map((n) => [n.key, n.unit]));

export function describeResult(result: LabelResult): string {
  const what =
    result.outcome === 'created'
      ? `CREATE Product ${result.product_id} with barcode and label version ${result.version_number}`
      : result.outcome === 'new_label_version'
        ? `PUBLISH label version ${result.version_number} for Product ${result.product_id} (previous version superseded, kept)`
        : `UNCHANGED: Product ${result.product_id} already has this exact current label; nothing to write`;
  const lines = [what, ...result.changes.map((c) => `  change: ${c}`)];
  lines.push(result.committed ? 'COMMITTED' : result.outcome === 'unchanged' ? 'NOTHING WRITTEN' : 'DRY RUN: rolled back, nothing written');
  return lines.join('\n');
}

async function main(): Promise<number> {
  const args = parseLabelArgs(process.argv.slice(2));
  const text = readFileSync(args.file, 'utf8');
  const plan = buildLabelPlan(JSON.parse(text), text);
  console.log(describePlan(plan));
  if (args.apply && plan.synthetic) throw new Error('This is a synthetic example file; it can never be published.');
  if (args.apply && args.confirm !== plan.barcode.gtin) throw new Error(`--confirm must be the canonical GTIN ${plan.barcode.gtin} shown above`);

  const databaseUrl = process.env.INGEST_DATABASE_URL;
  if (!databaseUrl) throw new Error('Set INGEST_DATABASE_URL in your shell (never in a file in the repo).');
  const target = checkTarget(databaseUrl, args.projectRef);
  const client = new Client({
    connectionString: databaseUrl,
    ssl: target.local ? false : { rejectUnauthorized: true, ...(args.caFile ? { ca: readFileSync(args.caFile, 'utf8') } : {}) },
  });
  console.log(`connecting to ${target.host} …`);
  await client.connect();
  try {
    const result = await applyLabelPlan(client, plan, { dryRun: !args.apply, confirmNewLabelVersion: args.newLabelVersion });
    console.log(describeResult(result));
    return 0;
  } catch (error) {
    if (error instanceof LabelConflictError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof LabelPlanError ? error.message : error instanceof Error ? error.message : 'label publication failed');
      process.exit(1);
    },
  );
}
