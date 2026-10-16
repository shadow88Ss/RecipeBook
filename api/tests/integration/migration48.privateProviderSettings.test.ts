// Option A hardening (migration 48) — private provider settings leave the
// database. Real migration chain and RLS harness; provider HTTP is the
// deterministic fixture (tests/helpers/providerFixtures.ts).
//
// The database is first built as it stood BEFORE migration 48, with the
// Open Food Facts contact stored the old way, so the safe deploy order is
// exercised: new API on the old schema, then migration 48 applied.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import pino from 'pino';
import request from 'supertest';
import { createApp } from '../../src/app';
import { createDefaultAdapterRegistry } from '../../src/domain/integrations/adapters';
import { EnvSecretResolver } from '../../src/domain/integrations/secrets';
import { PgHarnessProfileRepository } from '../helpers/pgHarnessProfileRepository';
import { PgHarnessScopedDbFactory } from '../helpers/pgHarnessScopedDb';
import { MIGRATIONS_DIR, rebuildTestDatabase } from '../helpers/testDb';
import { seedScenario, SEED } from '../helpers/seed';
import { signTestToken, TEST_JWT_SECRET } from '../helpers/jwt';
import { FakeProviderHttp, OFF_SPREAD } from '../helpers/providerFixtures';

const MIGRATION_48 = '20261016120000_private_provider_settings.sql';
const ADMIN = 'a0a0a0a0-0000-4000-8000-0000000000ad';
const ENV_CONTACT = 'ops-contact@myrecipebook.example';
const STORED_CONTACT = 'stored-contact@myrecipebook.example';
const ADMIN_BASE = '/v1/admin/integrations';
const LOOKUP = (code: string) => `/v1/products/barcode/${code}/lookup`;
const PRIVATE_SHAPES = /@|contact|credential|secret|env:/i;

let pool: Pool;
const http = new FakeProviderHttp();
let clock = Date.UTC(2026, 9, 16, 12, 0, 0);
const now = () => new Date(clock);

function appWith(contact: string | null) {
  return createApp({
    profileRepository: new PgHarnessProfileRepository(pool),
    scopedDbFactory: new PgHarnessScopedDbFactory(pool),
    jwtSecret: TEST_JWT_SECRET,
    logger: pino({ level: 'silent' }),
    integrations: {
      registry: createDefaultAdapterRegistry({ fetch: http.fetch, now }),
      secrets: new EnvSecretResolver(contact ? { OPEN_FOOD_FACTS_CONTACT_EMAIL: contact } : {}),
      deploymentEnvironment: 'test',
      now,
    },
  });
}
let app: ReturnType<typeof createApp>;

const as = (account: string, target = () => app) => ({
  get: (p: string) => request(target()).get(p).set('Authorization', `Bearer ${signTestToken(account)}`),
  post: (p: string, body: object = {}) => request(target()).post(p).set('Authorization', `Bearer ${signTestToken(account)}`).send(body),
  patch: (p: string, body: object) => request(target()).patch(p).set('Authorization', `Bearer ${signTestToken(account)}`).send(body),
});
const user = () => as(SEED.accountA);
const admin = () => as(ADMIN);
const userDb = () => new PgHarnessScopedDbFactory(pool).forUser({ accountId: SEED.accountA, accessToken: signTestToken(SEED.accountA) } as never);

const referenceCounts = async () =>
  (
    await pool.query(
      'select (select count(*) from product)::int as product, (select count(*) from barcode)::int as barcode, (select count(*) from product_label_version)::int as label, (select count(*) from product_nutrient)::int as nutrient, (select count(*) from product_serving)::int as serving',
    )
  ).rows[0];

beforeAll(async () => {
  pool = await rebuildTestDatabase('recipebook_api_test_migration48', { stopBeforeMigration: MIGRATION_48 });
  await seedScenario(pool);
  await pool.query("insert into account (id, email, display_name) values ($1, 'platform-admin@example.com', 'Platform Admin')", [ADMIN]);
  await pool.query("insert into platform_role_assignment (account_id, role) values ($1, 'platform_admin')", [ADMIN]);
  // Open Food Facts as configured on DEV before migration 48: contact stored in configuration.
  await pool.query(
    "update external_provider set enabled = true, environment = 'production', configuration = jsonb_build_object('contact_email', $1::text, 'cache_ttl_seconds', 0, 'request_timeout_ms', 500) where provider_key = 'open_food_facts'",
    [STORED_CONTACT],
  );
  http.offProducts.set(OFF_SPREAD.code, OFF_SPREAD);
  app = appWith(ENV_CONTACT);
}, 120_000);

afterAll(async () => {
  await pool.end();
});

beforeEach(() => {
  http.reset();
  clock += 3_600_000;
});

describe('safe deploy order, step 1: the new API on the pre-48 database', () => {
  it('ignores the stored contact; the lookup works and identifies with the environment contact', async () => {
    const legacy = await userDb().rpcRows<Record<string, unknown>>('enabled_provider_routes', { p_family: 'product_data', p_capability: 'barcode_lookup' });
    expect(legacy[0]).toHaveProperty('credential_attached'); // the old function shape is still live
    const res = await user().get(LOOKUP('3017624010701'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'external_candidate', external_lookup: { status: 'found', providers_answered: ['open_food_facts'] } });
    expect(http.callsTo('off')[0]?.headers['user-agent']).toBe(`MyRecipeBook/1.0 (${ENV_CONTACT})`);
    expect(JSON.stringify(res.body)).not.toContain(STORED_CONTACT);
  });

  it('admins see only non-sensitive configuration and a configured flag', async () => {
    const res = await admin().get(`${ADMIN_BASE}/open_food_facts`);
    expect(res.status).toBe(200);
    expect(res.body.configuration).not.toHaveProperty('contact_email');
    expect(res.body.private_settings).toEqual([{ name: 'contact_email', configured: true }]);
    expect(JSON.stringify(res.body)).not.toMatch(/@|OPEN_FOOD_FACTS_CONTACT/);
  });
});

describe('safe deploy order, step 2: migration 48', () => {
  it('removes the stored contact without copying it anywhere, audited by field name only', async () => {
    await pool.query(await readFile(path.join(MIGRATIONS_DIR, MIGRATION_48), 'utf8'));
    const { rows } = await pool.query("select configuration from external_provider where provider_key = 'open_food_facts'");
    expect(rows[0].configuration).toEqual({ cache_ttl_seconds: 0, request_timeout_ms: 500 });
    const stored = await pool.query('select count(*)::int as n from external_provider where configuration::text like $1', ['%@%']);
    expect(stored.rows[0].n).toBe(0);
    const audit = await pool.query(
      "select event_type, actor_type, event_payload from audit_event where subject_type = 'external_provider' and event_type = 'external_provider_configuration_changed' order by occurred_at desc limit 1",
    );
    expect(audit.rows[0]).toMatchObject({ actor_type: 'system', event_payload: { provider_key: 'open_food_facts', changed_fields: ['configuration'] } });
    const leaked = await pool.query('select count(*)::int as n from audit_event where event_payload::text like $1', [`%${STORED_CONTACT}%`]);
    expect(leaked.rows[0].n).toBe(0);
  });
});

describe('ordinary users cannot retrieve private configuration or credential metadata', () => {
  it.each(['barcode_lookup', 'nutrition_lookup', 'product_search'])('enabled_provider_routes(product_data, %s) returns routing data only', async (capability) => {
    const rows = await userDb().rpcRows<Record<string, unknown>>('enabled_provider_routes', { p_family: 'product_data', p_capability: capability });
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(['configuration', 'environment', 'priority', 'provider_key']);
    expect(JSON.stringify(rows)).not.toMatch(PRIVATE_SHAPES);
    if (capability === 'barcode_lookup') expect(rows).toEqual([{ provider_key: 'open_food_facts', priority: 30, environment: 'production', configuration: { cache_ttl_seconds: 0, request_timeout_ms: 500 } }]);
  });

  it('the registry, admin API and audit stay closed to them; anon cannot route at all', async () => {
    const db = userDb();
    expect(await db.select('external_provider', { columns: 'provider_key, configuration, secret_reference', limit: 10 })).toEqual([]);
    expect((await user().get(`${ADMIN_BASE}/open_food_facts`)).status).toBe(403);
    expect((await user().get(ADMIN_BASE)).status).toBe(403);
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local role anon');
      await expect(client.query("select * from enabled_provider_routes('product_data', 'barcode_lookup')")).rejects.toThrow(/permission denied/);
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });

  it('consumer lookup responses carry no configuration, contact or credential detail', async () => {
    const before = await referenceCounts();
    const res = await user().get(LOOKUP('3017624010701'));
    const [c] = res.body.candidates;
    expect(c).toMatchObject({
      status: 'unconfirmed_external_candidate',
      loggable: false,
      provider_key: 'open_food_facts',
      provenance: {
        authority: 'external_candidate',
        attribution: {
          required: true,
          text: 'Product data from Open Food Facts (openfoodfacts.org), available under the Open Database License (ODbL).',
          link: 'https://openfoodfacts.org',
          licence: 'ODbL-1.0 (database), DbCL-1.0 (contents)',
        },
      },
    });
    expect(res.body.next_step).toBe('confirmation_required_before_use');
    expect(JSON.stringify(res.body)).not.toMatch(/contact|credential|secret|configuration|user-agent|ops-contact|stored-contact/i);
    expect(http.callsTo('off')[0]?.headers['user-agent']).toBe(`MyRecipeBook/1.0 (${ENV_CONTACT})`);
    expect(await referenceCounts()).toEqual(before);
  });
});

describe('platform admins keep full integration management', () => {
  it.each([
    ['the declared private key', { contact_email: ENV_CONTACT }],
    ['a contact-like key', { support_phone: '+971000000' }],
    ['an e-mail-like value at any depth', { app_name: 'MyRecipeBook', notes: { owner: 'someone@example.org' } }],
  ])('rejects %s in configuration', async (_label, configuration) => {
    const res = await admin().patch(`${ADMIN_BASE}/open_food_facts`, { configuration });
    expect(res.status).toBe(400);
    expect(res.body.error.details.reason).toBe('private_setting_in_configuration');
    expect(JSON.stringify(res.body)).not.toContain('@');
  });

  it('still configures, disables, enables, prioritizes and health-checks providers', async () => {
    const configured = await admin().patch(`${ADMIN_BASE}/open_food_facts`, { configuration: { cache_ttl_seconds: 0, request_timeout_ms: 600 } });
    expect(configured.status).toBe(200);
    expect(configured.body.configuration).toMatchObject({ request_timeout_ms: 600, app_name: 'MyRecipeBook' });
    expect((await admin().patch(`${ADMIN_BASE}/open_food_facts`, { enabled: false })).body.enabled).toBe(false);
    expect((await user().get(LOOKUP('3017624010701'))).body.source).toBe('none');
    const enabled = await admin().patch(`${ADMIN_BASE}/open_food_facts`, { enabled: true, capabilities: [{ capability: 'barcode_lookup', enabled: true, priority: 25 }] });
    expect(enabled.status).toBe(200);
    expect(enabled.body.capabilities.find((c: { capability: string }) => c.capability === 'barcode_lookup')).toMatchObject({ enabled: true, priority: 25 });
    const test = await admin().post(`${ADMIN_BASE}/open_food_facts/test`);
    expect(test.status).toBe(200);
    expect(test.body).toMatchObject({ result: 'succeeded', health: { status: 'healthy' } });
    expect(http.callsTo('off').at(-1)?.headers['user-agent']).toBe(`MyRecipeBook/1.0 (${ENV_CONTACT})`);
    const audit = await admin().get(`${ADMIN_BASE}/open_food_facts/audit`);
    expect(audit.status).toBe(200);
    expect(JSON.stringify(audit.body)).not.toContain('@');
  });

  it('the database itself refuses private settings in stored configuration', async () => {
    await expect(pool.query("update external_provider set configuration = configuration || '{\"contact_email\":\"x\"}' where provider_key = 'open_food_facts'")).rejects.toThrow(
      /external_provider_configuration_not_private/,
    );
    await expect(pool.query("update external_provider set configuration = configuration || '{\"note\":\"ops@example.org\"}' where provider_key = 'open_food_facts'")).rejects.toThrow(
      /external_provider_configuration_not_private/,
    );
  });
});

describe('an API without the environment contact never calls Open Food Facts', () => {
  it('blocks the admin test and enabling, and the consumer lookup makes no provider call', async () => {
    const bare = () => appWith(null);
    const adminBare = as(ADMIN, bare);
    const status = await adminBare.get(`${ADMIN_BASE}/open_food_facts`);
    expect(status.body.private_settings).toEqual([{ name: 'contact_email', configured: false }]);
    const test = await adminBare.post(`${ADMIN_BASE}/open_food_facts/test`);
    expect(test.status).toBe(409);
    expect(test.body.error.details.reason).toBe('private_setting_not_configured');
    const enable = await adminBare.patch(`${ADMIN_BASE}/open_food_facts`, { enabled: true });
    expect(enable.status).toBe(409);
    expect(enable.body.error.details.blockers).toContain('private_setting_not_configured');
    const lookup = await as(SEED.accountA, bare).get(LOOKUP('3017624010701'));
    expect(lookup.status).toBe(200);
    expect(lookup.body.candidates).toEqual([]);
    expect(http.callsTo('off')).toEqual([]);
  });
});
