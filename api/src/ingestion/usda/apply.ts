// Layer 12B.1 — write an ingestion plan as trusted reference data.
//
// Runs as the database owner over a direct operator connection (never an API
// route, never a client token, never a service-role key in an app). One
// transaction for the whole run: everything is written or nothing is.
//
// Idempotency and refresh policy, per source record (usda_fdc, FDC ID):
//   absent                      -> insert Food, alias, servings, nutrients and
//                                  the immutable food_source_record
//   present, same content hash  -> unchanged (nothing written)
//   present, different hash     -> CHANGED: the whole run stops for review.
//                                  Reference data is never overwritten in place.
// A Food whose canonical_name already exists without this source record is a
// conflict and also stops the run. Dry run (the default) performs every check
// and every write inside the transaction, then rolls back.

import type { ClientBase } from 'pg';
import { USDA_NUTRIENT_MAP } from './nutrientMap';
import { SR_BASIS, USDA_LICENCE, type Plan, type PlannedFood } from './plan';

export interface ApplyOptions {
  /** Recorded verbatim as source_release, e.g. the downloaded file name. */
  release: string;
  dryRun: boolean;
}

export interface ApplyResult {
  inserted: string[];
  unchanged: string[];
  changed: string[];
  conflicts: string[];
  committed: boolean;
  counts: { foods: number; aliases: number; servings: number; nutrients: number };
}

export class IngestionStopped extends Error {
  constructor(
    message: string,
    readonly result: ApplyResult,
  ) {
    super(message);
    this.name = 'IngestionStopped';
  }
}

const RELEASE_PATTERN = /^[A-Za-z0-9 ._:()-]{1,200}$/;

async function nutrientIds(client: ClientBase): Promise<Map<string, string>> {
  const { rows } = await client.query<{ id: string; canonical_key: string; unit: string }>('select id, canonical_key, unit from nutrient');
  const byKey = new Map(rows.map((r) => [r.canonical_key, r]));
  const out = new Map<string, string>();
  const problems: string[] = [];
  for (const m of USDA_NUTRIENT_MAP) {
    const row = byKey.get(m.key);
    if (!row) problems.push(`nutrient ${m.key} is not in the vocabulary`);
    else if (row.unit !== m.unit) problems.push(`nutrient ${m.key} has unit ${row.unit}, mapping expects ${m.unit}`);
    else out.set(m.key, row.id);
  }
  if (problems.length) throw new Error(`Nutrient vocabulary mismatch: ${problems.join('; ')}`);
  return out;
}

/** Bulk insert of the new Foods and their rows: a handful of statements, not one per row. */
async function insertFoods(client: ClientBase, foods: PlannedFood[], ids: Map<string, string>, release: string, counts: ApplyResult['counts'], progress: (m: string) => void) {
  if (!foods.length) return;
  const { rows } = await client.query<{ id: string; canonical_name: string }>(
    "insert into food (canonical_name, category, source) select n, c, 'trusted_database' from unnest($1::text[], $2::text[]) as t(n, c) returning id, canonical_name",
    [foods.map((f) => f.canonicalName), foods.map((f) => f.category)],
  );
  const idOf = new Map(rows.map((r) => [r.canonical_name, r.id]));
  const foodId = (f: PlannedFood) => idOf.get(f.canonicalName)!;
  counts.foods += rows.length;
  progress(`  foods: ${rows.length}`);

  await client.query("insert into food_alias (food_id, locale, alias_text, is_primary, source) select f, 'en', a, true, 'trusted_database' from unnest($1::uuid[], $2::text[]) as t(f, a)", [
    foods.map(foodId),
    foods.map((f) => f.description),
  ]);
  counts.aliases += foods.length;
  progress(`  aliases: ${foods.length}`);

  const servings = foods.flatMap((f) => f.servings.map((s) => ({ food: foodId(f), ...s })));
  if (servings.length) {
    await client.query(
      "insert into food_serving (food_id, serving_description, region, canonical_quantity, canonical_unit, source) select f, d, null, q, 'g', 'trusted_database' from unnest($1::uuid[], $2::text[], $3::numeric[]) as t(f, d, q)",
      [servings.map((s) => s.food), servings.map((s) => s.description), servings.map((s) => s.grams)],
    );
  }
  counts.servings += servings.length;
  progress(`  servings: ${servings.length}`);

  const nutrients = foods.flatMap((f) => f.nutrients.map((n) => ({ food: foodId(f), nutrient: ids.get(n.key)!, amount: n.amount })));
  if (nutrients.length) {
    await client.query(
      "insert into food_nutrient (food_id, nutrient_id, amount_per_canonical_unit, source, basis_quantity, basis_unit) select f, n, a, 'trusted_database', $4, $5 from unnest($1::uuid[], $2::uuid[], $3::numeric[]) as t(f, n, a)",
      [nutrients.map((n) => n.food), nutrients.map((n) => n.nutrient), nutrients.map((n) => n.amount), SR_BASIS.quantity, SR_BASIS.unit],
    );
  }
  counts.nutrients += nutrients.length;
  progress(`  nutrient values: ${nutrients.length}`);

  await client.query(
    `insert into food_source_record (food_id, source_system, source_dataset, source_record_id, source_secondary_id, source_release, source_description, licence, content_sha256)
     select f, 'usda_fdc', 'sr_legacy', r, s, $5, d, $6, h from unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $7::text[]) as t(f, r, s, d, h)`,
    [foods.map(foodId), foods.map((f) => f.fdcId), foods.map((f) => f.ndbNumber), foods.map((f) => f.description), release, USDA_LICENCE, foods.map((f) => f.contentSha256)],
  );
  progress(`  source records: ${foods.length}`);
}

export async function applyPlan(client: ClientBase, plan: Plan, options: ApplyOptions, progress: (message: string) => void = () => undefined): Promise<ApplyResult> {
  if (!RELEASE_PATTERN.test(options.release)) throw new Error('release must be 1-200 characters of letters, digits, space and ._:()-');
  const result: ApplyResult = { inserted: [], unchanged: [], changed: [], conflicts: [], committed: false, counts: { foods: 0, aliases: 0, servings: 0, nutrients: 0 } };

  await client.query('begin');
  try {
    const ids = await nutrientIds(client);
    progress('connected; checking existing records');
    const existing = await client.query<{ source_record_id: string; content_sha256: string }>(
      "select source_record_id, content_sha256 from food_source_record where source_system = 'usda_fdc' and source_record_id = any($1::text[])",
      [plan.foods.map((f) => f.fdcId)],
    );
    const hashOf = new Map(existing.rows.map((r) => [r.source_record_id, r.content_sha256]));
    const clashes = await client.query<{ canonical_name: string }>('select canonical_name from food where canonical_name = any($1::text[])', [plan.foods.map((f) => f.canonicalName)]);
    const taken = new Set(clashes.rows.map((r) => r.canonical_name));

    const toInsert: PlannedFood[] = [];
    for (const food of plan.foods) {
      const label = `fdc ${food.fdcId} (NDB ${food.ndbNumber}) ${food.description}`;
      const hash = hashOf.get(food.fdcId);
      if (hash !== undefined) {
        if (hash === food.contentSha256) result.unchanged.push(label);
        else result.changed.push(label);
      } else if (taken.has(food.canonicalName)) {
        result.conflicts.push(label);
      } else {
        toInsert.push(food);
        result.inserted.push(label);
      }
    }
    if (result.changed.length || result.conflicts.length) {
      await client.query('rollback');
      result.inserted = [];
      throw new IngestionStopped('Stopped for review: some source records changed or conflict with existing Foods. Nothing was written.', result);
    }
    progress(`writing ${toInsert.length} new foods (${result.unchanged.length} already present and unchanged)`);
    await insertFoods(client, toInsert, ids, options.release, result.counts, progress);
    if (options.dryRun) {
      await client.query('rollback');
    } else {
      await client.query('commit');
      result.committed = true;
    }
    return result;
  } catch (error) {
    if (!(error instanceof IngestionStopped)) await client.query('rollback').catch(() => undefined);
    throw error;
  }
}
