// Layer 12B.1 — operator command: ingest the committed USDA selection into a
// database as trusted reference data. NOT part of the API server (app.ts never
// imports this; `pg` is a dev dependency, absent from the production image).
//
//   npm run ingest:usda -- --file <FDC SR Legacy JSON> --release <file name> \
//     --project-ref <supabase ref> [--manifest <path>] [--ca-file <pem>] [--apply]
//
// The connection string comes from INGEST_DATABASE_URL in the operator's own
// shell (never a file in the repo, never printed). It must name the given
// project ref, so a run cannot silently hit another project. Without --apply
// the run is a dry run: all checks and writes happen inside a transaction
// that is rolled back.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { applyPlan, IngestionStopped, type ApplyResult } from './apply';
import { buildPlan, PlanError, type Plan } from './plan';

export const DEFAULT_MANIFEST = path.join(__dirname, 'dev-bootstrap.manifest.json');

export interface CliArgs {
  file: string;
  release: string;
  projectRef: string;
  manifest: string;
  caFile: string | null;
  apply: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const file = get('file');
  const release = get('release');
  const projectRef = get('project-ref');
  if (!file || !release || !projectRef) {
    throw new Error('Usage: npm run ingest:usda -- --file <SR Legacy JSON> --release <file name> --project-ref <ref> [--manifest <path>] [--ca-file <pem>] [--apply]');
  }
  if (!/^[a-z0-9]{6,40}$/.test(projectRef) && projectRef !== 'local') throw new Error('--project-ref must be a Supabase project ref (or "local")');
  return { file, release, projectRef, manifest: get('manifest') ?? DEFAULT_MANIFEST, caFile: get('ca-file') ?? null, apply: argv.includes('--apply') };
}

/** The connection must belong to the named project; credentials are never echoed. */
export function checkTarget(databaseUrl: string, projectRef: string): { host: string; local: boolean } {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('INGEST_DATABASE_URL is not a valid postgres URL');
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) throw new Error('INGEST_DATABASE_URL must be a postgres:// URL');
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (projectRef === 'local') {
    if (!local) throw new Error('--project-ref local only allows a localhost database');
  } else if (!`${decodeURIComponent(url.username)}@${url.hostname}`.includes(projectRef)) {
    throw new Error(`INGEST_DATABASE_URL does not belong to project ${projectRef}`);
  }
  return { host: url.hostname, local };
}

export function summarize(plan: Plan, result: ApplyResult | null): string {
  const servings = plan.foods.reduce((n, f) => n + f.servings.length, 0);
  const nutrients = plan.foods.reduce((n, f) => n + f.nutrients.length, 0);
  const lines = [
    `manifest: ${plan.manifestName} (${plan.foods.length} foods), nutrient map ${plan.mapVersion}`,
    `planned: ${plan.foods.length} foods, ${servings} servings, ${nutrients} nutrient values`,
  ];
  if (result) {
    lines.push(`inserted: ${result.inserted.length}  unchanged: ${result.unchanged.length}  changed: ${result.changed.length}  conflicts: ${result.conflicts.length}`);
    lines.push(`written rows: foods ${result.counts.foods}, aliases ${result.counts.aliases}, servings ${result.counts.servings}, nutrients ${result.counts.nutrients}`);
    lines.push(result.committed ? 'COMMITTED' : 'DRY RUN: rolled back, nothing written');
    for (const c of result.changed) lines.push(`  changed: ${c}`);
    for (const c of result.conflicts) lines.push(`  conflict: ${c}`);
  }
  return lines.join('\n');
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.INGEST_DATABASE_URL;
  if (!databaseUrl) throw new Error('Set INGEST_DATABASE_URL in your shell (never in a file in the repo).');
  const target = checkTarget(databaseUrl, args.projectRef);

  const plan = buildPlan(JSON.parse(readFileSync(args.file, 'utf8')), JSON.parse(readFileSync(args.manifest, 'utf8')));
  console.log(summarize(plan, null));

  const client = new Client({
    connectionString: databaseUrl,
    ssl: target.local ? false : { rejectUnauthorized: true, ...(args.caFile ? { ca: readFileSync(args.caFile, 'utf8') } : {}) },
  });
  await client.connect();
  try {
    const result = await applyPlan(client, plan, { release: args.release, dryRun: !args.apply });
    console.log(summarize(plan, result));
    return 0;
  } catch (error) {
    if (error instanceof IngestionStopped) {
      console.error(summarize(plan, error.result));
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
      // PlanError lists every problem; other errors print their message only (no connection details).
      console.error(error instanceof PlanError ? error.message : error instanceof Error ? error.message : 'ingestion failed');
      process.exit(1);
    },
  );
}
