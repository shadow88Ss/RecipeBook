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

async function insertFood(client: ClientBase, food: PlannedFood, ids: Map<string, string>, release: string, counts: ApplyResult['counts']) {
  const { rows } = await client.query<{ id: string }>("insert into food (canonical_name, category, source) values ($1, $2, 'trusted_database') returning id", [food.canonicalName, food.category]);
  const foodId = rows[0]!.id;
  await client.query("insert into food_alias (food_id, locale, alias_text, is_primary, source) values ($1, 'en', $2, true, 'trusted_database')", [foodId, food.description]);
  counts.aliases += 1;
  for (const s of food.servings) {
    await client.query("insert into food_serving (food_id, serving_description, region, canonical_quantity, canonical_unit, source) values ($1, $2, null, $3, 'g', 'trusted_database')", [foodId, s.description, s.grams]);
    counts.servings += 1;
  }
  for (const n of food.nutrients) {
    await client.query(
      "insert into food_nutrient (food_id, nutrient_id, amount_per_canonical_unit, source, basis_quantity, basis_unit) values ($1, $2, $3, 'trusted_database', $4, $5)",
      [foodId, ids.get(n.key), n.amount, SR_BASIS.quantity, SR_BASIS.unit],
    );
    counts.nutrients += 1;
  }
  await client.query(
    `insert into food_source_record (food_id, source_system, source_dataset, source_record_id, source_secondary_id, source_release, source_description, licence, content_sha256)
     values ($1, 'usda_fdc', 'sr_legacy', $2, $3, $4, $5, $6, $7)`,
    [foodId, food.fdcId, food.ndbNumber, release, food.description, USDA_LICENCE, food.contentSha256],
  );
  counts.foods += 1;
}

export async function applyPlan(client: ClientBase, plan: Plan, options: ApplyOptions): Promise<ApplyResult> {
  if (!RELEASE_PATTERN.test(options.release)) throw new Error('release must be 1-200 characters of letters, digits, space and ._:()-');
  const result: ApplyResult = { inserted: [], unchanged: [], changed: [], conflicts: [], committed: false, counts: { foods: 0, aliases: 0, servings: 0, nutrients: 0 } };

  await client.query('begin');
  try {
    const ids = await nutrientIds(client);
    for (const food of plan.foods) {
      const label = `fdc ${food.fdcId} (NDB ${food.ndbNumber}) ${food.description}`;
      const existing = await client.query<{ content_sha256: string }>("select content_sha256 from food_source_record where source_system = 'usda_fdc' and source_record_id = $1", [food.fdcId]);
      if (existing.rows[0]) {
        if (existing.rows[0].content_sha256 === food.contentSha256) result.unchanged.push(label);
        else result.changed.push(label);
        continue;
      }
      const clash = await client.query('select 1 from food where canonical_name = $1', [food.canonicalName]);
      if (clash.rowCount) {
        result.conflicts.push(label);
        continue;
      }
      await insertFood(client, food, ids, options.release, result.counts);
      result.inserted.push(label);
    }
    if (result.changed.length || result.conflicts.length) {
      await client.query('rollback');
      throw new IngestionStopped('Stopped for review: some source records changed or conflict with existing Foods. Nothing was written.', result);
    }
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
