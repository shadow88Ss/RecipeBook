// Layer 12B.1 — write an ingestion plan as trusted reference data.
//
// Runs as the database owner over a direct operator connection (never an API
// route, never a client token, never a service-role key in an app). One
// transaction for the whole run: everything is written or nothing is.
//
// Idempotency and refresh policy, per source record (usda_fdc, FDC ID):
//   absent                      -> insert Food, alias, servings, nutrients and
//                                  the immutable food_source_record
//   present, same content hash  -> unchanged; only supplemental nutrient
//                                  values it lacks are added (Layer 13B,
//                                  nutrientMap.ts), nothing else is written
//   present, different hash     -> CHANGED: the whole run stops for review.
//                                  Reference data is never overwritten in place.
// A Food whose canonical_name already exists without this source record is a
// conflict and also stops the run. Dry run (the default) performs every check
// and every write inside the transaction, then rolls back.

import type { ClientBase } from 'pg';
import { SUPPLEMENTAL_KEYS, USDA_NUTRIENT_MAP } from './nutrientMap';
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
  /** Layer 13B — unchanged records that received supplemental nutrient values. */
  supplemented: string[];
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

/**
 * Layer 13B — adds supplemental nutrient values (nutrientMap.ts) to Foods
 * whose source record is unchanged. Only absent (food, nutrient) values are
 * inserted, from the same USDA record and on the same per-100 g basis; no
 * existing row is updated or replaced, so reference data is still never
 * overwritten in place.
 */
async function supplementNutrients(client: ClientBase, foods: PlannedFood[], ids: Map<string, string>, counts: ApplyResult['counts'], progress: (m: string) => void): Promise<string[]> {
  const wanted = foods.flatMap((f) => f.nutrients.filter((n) => SUPPLEMENTAL_KEYS.has(n.key)).map((n) => ({ fdcId: f.fdcId, nutrient: ids.get(n.key)!, amount: n.amount, label: `fdc ${f.fdcId} (NDB ${f.ndbNumber}) ${f.description}` })));
  if (!wanted.length) return [];
  const { rows } = await client.query<{ source_record_id: string }>(
    `with added as (
       insert into food_nutrient (food_id, nutrient_id, amount_per_canonical_unit, source, basis_quantity, basis_unit)
       select r.food_id, t.n, t.a, 'trusted_database', $4, $5
         from unnest($1::text[], $2::uuid[], $3::numeric[]) as t(fdc, n, a)
         join food_source_record r on r.source_system = 'usda_fdc' and r.source_record_id = t.fdc
        where not exists (select 1 from food_nutrient x where x.food_id = r.food_id and x.nutrient_id = t.n)
       returning food_id
     )
     select r.source_record_id from added a join food_source_record r on r.food_id = a.food_id`,
    [wanted.map((w) => w.fdcId), wanted.map((w) => w.nutrient), wanted.map((w) => w.amount), SR_BASIS.quantity, SR_BASIS.unit],
  );
  counts.nutrients += rows.length;
  progress(`  supplemental nutrient values for unchanged foods: ${rows.length}`);
  const touched = new Set(rows.map((r) => r.source_record_id));
  return [...new Set(wanted.filter((w) => touched.has(w.fdcId)).map((w) => w.label))];
}

export async function applyPlan(client: ClientBase, plan: Plan, options: ApplyOptions, progress: (message: string) => void = () => undefined): Promise<ApplyResult> {
  if (!RELEASE_PATTERN.test(options.release)) throw new Error('release must be 1-200 characters of letters, digits, space and ._:()-');
  const result: ApplyResult = { inserted: [], unchanged: [], changed: [], conflicts: [], committed: false, counts: { foods: 0, aliases: 0, servings: 0, nutrients: 0 }, supplemented: [] };

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
    const toSupplement: PlannedFood[] = [];
    for (const food of plan.foods) {
      const label = `fdc ${food.fdcId} (NDB ${food.ndbNumber}) ${food.description}`;
      const hash = hashOf.get(food.fdcId);
      if (hash !== undefined) {
        if (hash === food.contentSha256) {
          result.unchanged.push(label);
          toSupplement.push(food);
        }
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
    result.supplemented = await supplementNutrients(client, toSupplement, ids, result.counts, progress);
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
