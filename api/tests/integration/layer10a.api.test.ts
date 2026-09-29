// Layer 10A integration tests — historical target context: explicit,
// idempotent daily target snapshots and Daily Tracker integration, against
// the real migration chain and RLS harness. TEST FIXTURES ONLY.
//
// Dates are derived from the real clock. To exercise a second, different
// local date without faking time, the tests use a second IANA zone whose
// current local date differs from UTC's: Pacific/Kiritimati (UTC+14) when
// that is already "tomorrow", otherwise Pacific/Honolulu (UTC-10), which is
// then still "yesterday" — at any instant exactly one of them differs.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { createApp } from '../../src/app';
import { logger } from '../../src/lib/logger';
import { localDateOf } from '../../src/domain/meals/meal.time';
import { PgHarnessProfileRepository } from '../helpers/pgHarnessProfileRepository';
import { PgHarnessScopedDbFactory } from '../helpers/pgHarnessScopedDb';
import { rebuildTestDatabase } from '../helpers/testDb';
import { seedScenario, SEED } from '../helpers/seed';
import { seedNutritionFixtures } from '../helpers/nutritionFixtures';
import { signTestToken, TEST_JWT_SECRET } from '../helpers/jwt';

let pool: Pool;
let app: ReturnType<typeof createApp>;

const as = (account: string) => ({
  get: (path: string, query: Record<string, string> = {}) => request(app).get(path).query(query).set('Authorization', `Bearer ${signTestToken(account)}`),
  post: (path: string, body: unknown = {}) => request(app).post(path).set('Authorization', `Bearer ${signTestToken(account)}`).send(body as object),
});
const A = () => as(SEED.accountA);
const PROFILE_A2 = 'b0b0b0b0-0000-4000-8000-0000000000a2';
const snapshots = (profile: string) => `/v1/profiles/${profile}/target-snapshots`;
const tracker = (account: string, profile: string, date: string, timezone: string) => as(account).get(`/v1/profiles/${profile}/daily-tracker`, { date, timezone });
const capture = (account: string, profile: string, local_date: string, timezone: string, extra: Record<string, unknown> = {}) => as(account).post(snapshots(profile), { local_date, timezone, ...extra });

const UTC_TODAY = () => localDateOf(new Date(), 'UTC');
const OTHER_TZ = () => (localDateOf(new Date(), 'Pacific/Kiritimati') !== UTC_TODAY() ? 'Pacific/Kiritimati' : 'Pacific/Honolulu');
const OTHER_TODAY = () => localDateOf(new Date(), OTHER_TZ());
const LEGACY_DAY = '2025-01-15';

type Field = { field_name: string; value: number; unit: string; source: string; source_reference: string };
const field = (fields: Field[], key: string) => fields.find((f) => f.field_name === key);

/** Pre-7C rows exactly as an old database held them (test-only). */
async function insertLegacy(profile: string, fieldName: string, value: number, unit: string) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local session_replication_role = replica');
    await client.query('insert into nutrition_target (profile_id, field_name, value, unit) values ($1, $2, $3, $4)', [profile, fieldName, value, unit]);
    await client.query('commit');
  } finally {
    client.release();
  }
}

async function txAs(account: string): Promise<PoolClient> {
  const c = await pool.connect();
  await c.query('begin');
  await c.query("select set_config('request.jwt.claim.sub', $1, true)", [account]);
  await c.query('set local role authenticated');
  return c;
}
async function asAccountSql(account: string, sql: string, params: unknown[] = []) {
  const c = await txAs(account);
  try {
    return await c.query(sql, params);
  } finally {
    await c.query('rollback');
    c.release();
  }
}

const worldState = async () =>
  (
    await pool.query(`select
      (select count(*)::int from effective_target_snapshot) as snapshots,
      (select md5(coalesce(string_agg(to_jsonb(t)::text, ',' order by id), '')) from nutrition_target t) as user_targets,
      (select md5(coalesce(string_agg(to_jsonb(t)::text, ',' order by id), '')) from clinician_target t) as clinician_targets,
      (select count(*)::int from meal_log) as meal_logs,
      (select count(*)::int from meal_item) as meal_items,
      (select count(*)::int from audit_event) as audit_events,
      (select md5(coalesce(string_agg(to_jsonb(f)::text, ',' order by id), '')) from food f) as foods,
      (select md5(coalesce(string_agg(to_jsonb(n)::text, ',' order by id), '')) from food_nutrient n) as food_nutrients,
      (select count(*)::int from recipe_version) as recipe_versions,
      (select count(*)::int from grocery_list) as grocery_lists,
      (select count(*)::int from meal_plan) as meal_plans`)
  ).rows[0];

let snapshotId: string;

beforeAll(async () => {
  pool = await rebuildTestDatabase('recipebook_api_test_layer10a');
  await seedScenario(pool);
  await seedNutritionFixtures(pool);
  await pool.query("insert into profile (id, account_id, display_name, is_child) values ($1, $2, 'Profile A2', false)", [PROFILE_A2, SEED.accountA]);
  app = createApp({
    profileRepository: new PgHarnessProfileRepository(pool),
    scopedDbFactory: new PgHarnessScopedDbFactory(pool),
    jwtSecret: TEST_JWT_SECRET,
    logger,
  });
  const a = A();
  expect((await a.post(`/v1/profiles/${SEED.profileA}/nutrition-targets`, { field_name: 'energy', value: 2000, unit: 'kcal' })).status).toBe(201);
  expect((await a.post(`/v1/profiles/${SEED.profileA}/nutrition-targets`, { field_name: 'protein', value: 90, unit: 'g' })).status).toBe(201);
  expect((await a.post(`/v1/profiles/${SEED.profileA}/clinician-targets`, { field_name: 'protein', value: 120, unit: 'g' })).status).toBe(201);
  await insertLegacy(SEED.profileA, 'carbs', 250, 'g'); // legacy alias -> carbohydrate
  await insertLegacy(SEED.profileA, 'mystery_target', 5, 'g'); // unknown -> unresolved
}, 90_000);

afterAll(async () => {
  await pool.end();
});

describe('capture (A-O, 1, 8, 9, 13, 14)', () => {
  it('A-I/V/W/13/14: captures today’s resolver output with canonical keys, units, mixed provenance, unresolved fields and day context', async () => {
    const before = await worldState();
    const res = await capture(SEED.accountA, SEED.profileA, UTC_TODAY(), 'UTC', {
      // M/N/O: none of this is accepted
      snapshot_payload: { energy: { value: 1, unit: 'kcal', source: 'user_target' } },
      fields: [{ field_name: 'energy', value: 1 }],
      resolver_version: 'forged',
      unresolved_fields: [],
      snapshot_reason: 'manual_audit',
      source: 'clinician_target',
    });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    const s = res.body.snapshot;
    snapshotId = s.id;
    expect(s).toMatchObject({ profile_id: SEED.profileA, local_date: UTC_TODAY(), local_timezone: 'UTC', snapshot_reason: 'daily_tracking', resolver_version: 'phase2-canonical-target-keys-v2' });
    expect(typeof s.captured_at).toBe('string');
    expect(s.fields.map((f: Field) => f.field_name)).toEqual(['carbohydrate', 'energy', 'protein']);
    expect(field(s.fields, 'energy')).toMatchObject({ value: 2000, unit: 'kcal', source: 'user_target' });
    expect(field(s.fields, 'protein')).toMatchObject({ value: 120, unit: 'g', source: 'clinician_target' }); // clinician over user
    expect(field(s.fields, 'carbohydrate')).toMatchObject({ value: 250, unit: 'g', source: 'user_target' }); // legacy "carbs"
    expect(s.unresolved_fields).toEqual([expect.objectContaining({ field_name: 'mystery_target', reason: 'unknown_target_key', source: 'user_target' })]);
    expect(s).not.toHaveProperty('created_by_account_id');

    const row = (await pool.query('select snapshot_payload, snapshot_reason, resolver_version, created_by_account_id, unresolved_fields from effective_target_snapshot where id = $1', [snapshotId])).rows[0];
    expect(Object.keys(row.snapshot_payload).sort()).toEqual(['carbohydrate', 'energy', 'protein']);
    expect(row).toMatchObject({ snapshot_reason: 'daily_tracking', resolver_version: 'phase2-canonical-target-keys-v2', created_by_account_id: SEED.accountA });
    expect(row.unresolved_fields).toHaveLength(1);
    const after = await worldState();
    expect({ ...after, snapshots: before.snapshots }).toEqual(before); // AD: only the snapshot was written
    expect(after.snapshots).toBe(before.snapshots + 1);
  });

  it('J/K/8: a retry returns the same snapshot (200, created: false)', async () => {
    const res = await capture(SEED.accountA, SEED.profileA, UTC_TODAY(), 'UTC');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: false, snapshot: { id: snapshotId } });
  });

  it('9: the same Profile/date in another time zone returns the frozen snapshot and its stored zone', async () => {
    const res = await capture(SEED.accountA, SEED.profileA, UTC_TODAY(), 'Etc/GMT');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: false, snapshot: { id: snapshotId, local_timezone: 'UTC' } });
    expect((await pool.query("select count(*)::int as n from effective_target_snapshot where profile_id = $1 and snapshot_reason = 'daily_tracking' and local_date = $2", [SEED.profileA, UTC_TODAY()])).rows[0].n).toBe(1);
  });

  it('7: concurrent captures for one Profile/date produce exactly one snapshot', async () => {
    const results = await Promise.all([1, 2, 3, 4].map(() => capture(SEED.accountA, PROFILE_A2, UTC_TODAY(), 'UTC')));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 200, 201]);
    expect(new Set(results.map((r) => r.body.snapshot.id)).size).toBe(1);
    expect((await pool.query("select count(*)::int as n from effective_target_snapshot where profile_id = $1 and snapshot_reason = 'daily_tracking'", [PROFILE_A2])).rows[0].n).toBe(1);
  });

  it('10/11: past and future dates cannot be captured (API and database); invalid zones are rejected', async () => {
    const past = await capture(SEED.accountA, SEED.profileA, LEGACY_DAY, 'UTC');
    expect(past.status).toBe(400);
    expect(past.body.error.details.issues[0].path).toBe('local_date');
    expect((await capture(SEED.accountA, SEED.profileA, '2099-01-01', 'UTC')).status).toBe(400);
    expect((await capture(SEED.accountA, SEED.profileA, UTC_TODAY(), 'Mars/Olympus')).status).toBe(400);
    expect((await capture(SEED.accountA, SEED.profileA, UTC_TODAY(), '+04:00')).status).toBe(400);
    await expect(
      asAccountSql(
        SEED.accountA,
        "insert into effective_target_snapshot (profile_id, snapshot_payload, resolver_version, resolved_at, snapshot_reason, local_date, local_timezone, unresolved_fields) values ($1, '{}', 'x', now(), 'daily_tracking', $2, 'UTC', '[]')",
        [SEED.profileA, LEGACY_DAY],
      ),
    ).rejects.toMatchObject({ constraint: 'effective_target_snapshot_current_local_date' });
    await expect(
      asAccountSql(
        SEED.accountA,
        "insert into effective_target_snapshot (profile_id, snapshot_payload, resolver_version, resolved_at, snapshot_reason, local_date, local_timezone, unresolved_fields) values ($1, '{}', 'x', now(), 'daily_tracking', $2, 'UTC', '[]')",
        [SEED.profileA, UTC_TODAY()],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await expect(
      asAccountSql(SEED.accountA, "insert into effective_target_snapshot (profile_id, snapshot_payload, resolver_version, resolved_at, snapshot_reason) values ($1, '{}', 'x', now(), 'daily_tracking')", [SEED.profileA]),
    ).rejects.toMatchObject({ constraint: 'effective_target_snapshot_daily_context' });
  });

  it('L/17: snapshots are immutable and cannot be deleted', async () => {
    await expect(asAccountSql(SEED.accountA, "update effective_target_snapshot set local_timezone = 'Asia/Dubai' where id = $1", [snapshotId])).rejects.toThrow();
    await expect(asAccountSql(SEED.accountA, 'delete from effective_target_snapshot where id = $1', [snapshotId])).rejects.toThrow(/permission denied/);
    await expect(pool.query("update effective_target_snapshot set snapshot_payload = '{}' where id = $1", [snapshotId])).rejects.toThrow();
  });
});

describe('same-day stability and the Daily Tracker (1-6, P-U, 12, 17, 18)', () => {
  let frozenRow: string;

  it('1/2/3/P/17: a later same-day target change leaves the frozen day and the snapshot untouched; the live resolver changes', async () => {
    frozenRow = (await pool.query('select md5(to_jsonb(s)::text) as h from effective_target_snapshot s where id = $1', [snapshotId])).rows[0].h;
    expect((await A().post(`/v1/profiles/${SEED.profileA}/nutrition-targets`, { field_name: 'energy', value: 1800, unit: 'kcal' })).status).toBe(201);
    const live = await A().get(`/v1/profiles/${SEED.profileA}/effective-target`);
    expect(live.body.resolved.energy).toMatchObject({ value: 1800 }); // 3
    const today = await tracker(SEED.accountA, SEED.profileA, UTC_TODAY(), 'UTC');
    expect(today.status).toBe(200);
    expect(today.body.target).toMatchObject({ status: 'daily_snapshot', context: 'daily_snapshot', daily_snapshot: { id: snapshotId, local_date: UTC_TODAY(), local_timezone: 'UTC' } });
    expect(field(today.body.target.fields, 'energy')).toMatchObject({ value: 2000 }); // 2
    expect(today.body.target.unresolved_fields).toEqual([expect.objectContaining({ field_name: 'mystery_target' })]);
    expect(today.body.comparison.status).toBe('available');
    expect(today.body.comparison.nutrients.find((n: { nutrient_key: string }) => n.nutrient_key === 'energy')).toMatchObject({ target: { value: 2000 } });
    expect((await pool.query('select md5(to_jsonb(s)::text) as h from effective_target_snapshot s where id = $1', [snapshotId])).rows[0].h).toBe(frozenRow); // 17
  });

  it('4: another local day captured after the change uses the changed target', async () => {
    const res = await capture(SEED.accountA, SEED.profileA, OTHER_TODAY(), OTHER_TZ());
    expect(res.status).toBe(201);
    expect(field(res.body.snapshot.fields, 'energy')).toMatchObject({ value: 1800 });
    expect(res.body.snapshot).toMatchObject({ local_date: OTHER_TODAY(), local_timezone: OTHER_TZ() });
  });

  it('Q: a past day uses its daily snapshot', async () => {
    const [earlier, laterTz] = OTHER_TODAY() < UTC_TODAY() ? [OTHER_TODAY(), 'UTC'] : [UTC_TODAY(), OTHER_TZ()];
    const res = await tracker(SEED.accountA, SEED.profileA, earlier, laterTz);
    expect(res.body).toMatchObject({ is_current_day: false, target: { context: 'daily_snapshot', daily_snapshot: { local_date: earlier } } });
    const daily = await A().get(`${snapshots(SEED.profileA)}/daily/${earlier}`);
    expect(daily.body).toMatchObject({ local_date: earlier, context: 'daily_snapshot', snapshot: { local_date: earlier } });
  });

  it('R/S/12: a legacy past day without a snapshot is historical_target_unavailable — never today’s target', async () => {
    const res = await tracker(SEED.accountA, SEED.profileA, LEGACY_DAY, 'UTC');
    expect(res.body.target).toMatchObject({ status: 'historical_target_unavailable', context: 'historical_target_unavailable', fields: [], daily_snapshot: null });
    expect(res.body.comparison).toMatchObject({ status: 'historical_target_unavailable', nutrients: [] });
    const daily = await A().get(`${snapshots(SEED.profileA)}/daily/${LEGACY_DAY}`);
    expect(daily.body).toEqual({ local_date: LEGACY_DAY, context: 'historical_target_unavailable', snapshot: null });
    // no row was reconstructed for it
    expect((await pool.query('select count(*)::int as n from effective_target_snapshot where local_date = $1', [LEGACY_DAY])).rows[0].n).toBe(0);
  });

  it('5/6/T/U/18: GET before capture uses the live target and writes nothing; after capture uses the frozen snapshot and writes nothing', async () => {
    expect((await as(SEED.accountB).post(`/v1/profiles/${SEED.profileB}/nutrition-targets`, { field_name: 'energy', value: 2500, unit: 'kcal' })).status).toBe(201);
    const before = await worldState();
    const live = await tracker(SEED.accountB, SEED.profileB, UTC_TODAY(), 'UTC');
    expect(live.body.target).toMatchObject({ status: 'current', context: 'live_current_target', daily_snapshot: null, implemented_sources: ['clinician_target', 'user_target'] });
    expect(field(live.body.target.fields, 'energy')).toMatchObject({ value: 2500 });
    await tracker(SEED.accountB, SEED.profileB, LEGACY_DAY, 'UTC');
    expect(await worldState()).toEqual(before); // viewing never freezes the day

    expect((await capture(SEED.accountB, SEED.profileB, UTC_TODAY(), 'UTC')).status).toBe(201);
    const afterCapture = await worldState();
    const frozen = await tracker(SEED.accountB, SEED.profileB, UTC_TODAY(), 'UTC');
    expect(frozen.body.target).toMatchObject({ status: 'daily_snapshot', context: 'daily_snapshot' });
    expect(await worldState()).toEqual(afterCapture);
  });

  it('snapshot list: daily snapshots only, newest first, date filters', async () => {
    const res = await A().get(snapshots(SEED.profileA));
    expect(res.status).toBe(200);
    expect(res.body.data.map((s: { local_date: string }) => s.local_date)).toEqual([UTC_TODAY(), OTHER_TODAY()].sort().reverse());
    const filtered = await A().get(snapshots(SEED.profileA), { from: UTC_TODAY(), to: UTC_TODAY() });
    expect(filtered.body.data).toHaveLength(1);
    // the 4B list still returns every snapshot, now with its day context
    const all = await A().get(`/v1/profiles/${SEED.profileA}/effective-target-snapshots`);
    expect(all.body.data.find((s: { id: string }) => s.id === snapshotId)).toMatchObject({ local_date: UTC_TODAY(), local_timezone: 'UTC', snapshot_reason: 'daily_tracking' });
  });
});

describe('authorization (X-AC, 15, 16)', () => {
  let childSnapshot: string;

  it('AA: full_management captures for the child', async () => {
    expect((await as(SEED.accountFullManagement).post(`/v1/profiles/${SEED.profileChild}/nutrition-targets`, { field_name: 'energy', value: 1600, unit: 'kcal' })).status).toBe(201);
    const res = await capture(SEED.accountFullManagement, SEED.profileChild, UTC_TODAY(), 'UTC');
    expect(res.status).toBe(201);
    childSnapshot = res.body.snapshot.id;
  });

  it('15/16/AB: pediatric_weight_management reads snapshots but cannot capture (API and database)', async () => {
    const p = as(SEED.accountPediatric);
    expect((await capture(SEED.accountPediatric, SEED.profileChild, UTC_TODAY(), 'UTC')).status).toBe(403);
    expect((await p.get(`${snapshots(SEED.profileChild)}/daily/${UTC_TODAY()}`)).body).toMatchObject({ context: 'daily_snapshot', snapshot: { id: childSnapshot } });
    expect((await p.get(snapshots(SEED.profileChild))).body.data).toHaveLength(1);
    expect((await tracker(SEED.accountPediatric, SEED.profileChild, UTC_TODAY(), 'UTC')).body.target).toMatchObject({ context: 'daily_snapshot' });
    await expect(
      asAccountSql(
        SEED.accountPediatric,
        "insert into effective_target_snapshot (profile_id, snapshot_payload, resolver_version, resolved_at, snapshot_reason, local_date, local_timezone, unresolved_fields) values ($1, '{}', 'x', now(), 'daily_tracking', $2, 'Etc/GMT-14', '[]')",
        [SEED.profileChild, localDateOf(new Date(), 'Etc/GMT-14')],
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(42501|23505)$/) });
  });

  it('Z: view_only reads but cannot capture (API and database)', async () => {
    const v = as(SEED.accountViewOnly);
    expect((await v.get(`${snapshots(SEED.profileChild)}/daily/${UTC_TODAY()}`)).status).toBe(200);
    expect((await v.get(snapshots(SEED.profileChild))).status).toBe(200);
    expect((await capture(SEED.accountViewOnly, SEED.profileChild, UTC_TODAY(), 'UTC')).status).toBe(403);
    await expect(
      asAccountSql(
        SEED.accountViewOnly,
        "insert into effective_target_snapshot (profile_id, snapshot_payload, resolver_version, resolved_at, snapshot_reason, local_date, local_timezone, unresolved_fields) values ($1, '{}', 'x', now(), 'daily_tracking', $2, 'Pacific/Kiritimati', '[]')",
        [SEED.profileChild, localDateOf(new Date(), 'Pacific/Kiritimati')],
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(42501|23505)$/) });
  });

  it('X/Y/AC: unrelated Accounts and a revoked guardian see and capture nothing; no cross-Profile capture', async () => {
    for (const account of [SEED.accountUnrelated, SEED.accountRevoked]) {
      expect((await capture(account, SEED.profileChild, UTC_TODAY(), 'UTC')).status).toBe(404);
      expect((await as(account).get(`${snapshots(SEED.profileChild)}/daily/${UTC_TODAY()}`)).status).toBe(404);
      expect((await as(account).get(snapshots(SEED.profileChild))).status).toBe(404);
      expect((await asAccountSql(account, 'select count(*)::int as n from effective_target_snapshot')).rows[0].n).toBe(0);
    }
    expect((await capture(SEED.accountA, SEED.profileB, OTHER_TODAY(), OTHER_TZ())).status).toBe(404);
    await expect(
      asAccountSql(
        SEED.accountA,
        "insert into effective_target_snapshot (profile_id, snapshot_payload, resolver_version, resolved_at, snapshot_reason, local_date, local_timezone, unresolved_fields) values ($1, '{}', 'x', now(), 'daily_tracking', $2, $3, '[]')",
        [SEED.profileB, OTHER_TODAY(), OTHER_TZ()],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
