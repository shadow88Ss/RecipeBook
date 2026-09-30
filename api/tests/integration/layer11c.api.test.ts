// Layer 11C integration tests — platform administration and the provider
// framework, against the real migration chain and RLS harness. Every
// adapter here is a FAKE test adapter: nothing calls an external API.

import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import pino from 'pino';
import request from 'supertest';
import { z } from 'zod';
import { createApp } from '../../src/app';
import { AdapterRegistry, createDefaultAdapterRegistry, type ProductDataAdapter } from '../../src/domain/integrations/adapters';
import { FAMILY_CAPABILITIES, IntegrationFailure } from '../../src/domain/integrations/integration.model';
import { ProviderRouter } from '../../src/domain/integrations/routing';
import { EnvSecretResolver } from '../../src/domain/integrations/secrets';
import { PgHarnessProfileRepository } from '../helpers/pgHarnessProfileRepository';
import { PgHarnessScopedDbFactory } from '../helpers/pgHarnessScopedDb';
import { rebuildTestDatabase } from '../helpers/testDb';
import { seedScenario, SEED } from '../helpers/seed';
import { signTestToken, TEST_JWT_SECRET } from '../helpers/jwt';

const ADMIN = 'a0a0a0a0-0000-4000-8000-0000000000ad';
const SECRET_VALUE = 'sk_test_SUPERSECRET_9f8e7d6c';
const WRONG_SECRET_VALUE = 'sk_test_WRONGSECRET_0000';

let pool: Pool;
let app: ReturnType<typeof createApp>;
const logs: string[] = [];

const as = (account: string) => ({
  get: (path: string, query: Record<string, string> = {}) => request(app).get(path).query(query).set('Authorization', `Bearer ${signTestToken(account)}`),
  post: (path: string, body: unknown = {}) => request(app).post(path).set('Authorization', `Bearer ${signTestToken(account)}`).send(body as object),
  patch: (path: string, body: unknown) => request(app).patch(path).set('Authorization', `Bearer ${signTestToken(account)}`).send(body as object),
});
const admin = () => as(ADMIN);
const BASE = '/v1/admin/integrations';

// ---------------- fake adapters ----------------
const productAdapter = (): ProductDataAdapter => ({
  family: 'product_data',
  lookupBarcode: async (_ctx, gtin) => ({ external_id: `ext-${gtin}`, gtin, brand_name: 'Example', product_name: 'Example Product', market: null }),
  searchProducts: async () => [],
});
const emptyConfig = z.strictObject({});

function buildRegistry(): AdapterRegistry {
  return createDefaultAdapterRegistry()
    .register({
      provider_key: 'example_product_provider',
      capabilities: ['barcode_lookup', 'product_search'],
      configSchema: z.strictObject({
        api_version: z.enum(['v1', 'v2']),
        market: z.string().regex(/^[A-Z]{2}$/).optional(),
        request_timeout_ms: z.number().int().positive().max(30_000).optional(),
      }),
      adapter: productAdapter(),
      testConnection: async (ctx) => {
        if ((await ctx.secret()) !== SECRET_VALUE) throw new IntegrationFailure('authentication_failed');
      },
    })
    .register({ provider_key: 'provider_a', capabilities: ['barcode_lookup'], configSchema: emptyConfig, adapter: productAdapter() })
    .register({ provider_key: 'provider_b', capabilities: ['barcode_lookup'], configSchema: emptyConfig, adapter: productAdapter() })
    .register({
      provider_key: 'example_shop',
      capabilities: ['product_search', 'price'],
      configSchema: z.strictObject({ store_region: z.string().max(10).optional() }),
      adapter: { family: 'commerce', searchProducts: async () => [], getPrice: async () => null },
    })
    .register({
      provider_key: 'example_band',
      capabilities: ['activity_sync'],
      configSchema: emptyConfig,
      adapter: { family: 'wearable', syncActivity: async () => ({ records: 0, next_cursor: null }) },
    })
    .register({
      provider_key: 'failing_provider',
      capabilities: ['barcode_lookup'],
      configSchema: emptyConfig,
      adapter: productAdapter(),
      // A raw provider error that even contains the secret: must be mapped, never surfaced.
      testConnection: async (ctx) => {
        throw new Error(`upstream said 500 for key ${await ctx.secret()}`);
      },
    })
    .register({
      provider_key: 'slow_provider',
      capabilities: ['barcode_lookup'],
      configSchema: z.strictObject({ request_timeout_ms: z.number().int().positive().max(30_000) }),
      adapter: productAdapter(),
      testConnection: () => new Promise<void>(() => undefined),
    })
    .register({
      provider_key: 'limited_provider',
      capabilities: ['barcode_lookup'],
      configSchema: emptyConfig,
      adapter: productAdapter(),
      testConnection: async () => {
        throw new IntegrationFailure('rate_limited', { retryAfterSeconds: 30 });
      },
    })
    .register({
      provider_key: 'example_device',
      capabilities: ['sleep_read'],
      configSchema: emptyConfig,
      adapter: { family: 'device_health', execution: 'device_native', native_framework: 'example_os_health', permissions: { sleep_read: ['sleep.read'] } },
    });
}

const registerProvider = (body: Record<string, unknown>) =>
  admin().post(BASE, { connection_model: 'platform', credential_model: 'none', provider_family: 'product_data', ...body });

beforeAll(async () => {
  pool = await rebuildTestDatabase('recipebook_api_test_layer11c');
  await seedScenario(pool);
  await pool.query("insert into account (id, email, display_name) values ($1, 'platform-admin@example.com', 'Platform Admin')", [ADMIN]);
  await pool.query("insert into platform_role_assignment (account_id, role) values ($1, 'platform_admin')", [ADMIN]);
  const sink = new Writable({
    write(chunk, _enc, cb) {
      logs.push(String(chunk));
      cb();
    },
  });
  app = createApp({
    profileRepository: new PgHarnessProfileRepository(pool),
    scopedDbFactory: new PgHarnessScopedDbFactory(pool),
    jwtSecret: TEST_JWT_SECRET,
    logger: pino({ level: 'trace' }, sink),
    integrations: {
      registry: buildRegistry(),
      secrets: new EnvSecretResolver({ EXAMPLE_PRODUCT_SECRET: SECRET_VALUE, EXAMPLE_WRONG_SECRET: WRONG_SECRET_VALUE, FAILING_SECRET: SECRET_VALUE }),
      deploymentEnvironment: 'test',
    },
  });
}, 120_000);

afterAll(async () => {
  await pool.end();
});

describe('A-E: platform administration is a separate security domain', () => {
  it('D: platform_admin lists the registry: seeded definitions, all disabled, no adapter, health unknown', async () => {
    const res = await admin().get(BASE);
    expect(res.status).toBe(200);
    expect(res.body.deployment_environment).toBe('test');
    const keys = res.body.items.map((p: { provider_key: string }) => p.provider_key);
    expect(keys).toEqual(expect.arrayContaining(['fatsecret', 'open_food_facts', 'usda', 'whoop', 'apple_health', 'health_connect', 'instacart', 'google_sign_in', 'apple_sign_in']));
    for (const p of res.body.items) {
      expect(p).toMatchObject({ enabled: false, adapter: { available: false }, health: { status: 'unknown' } });
    }
    const fatsecret = res.body.items.find((p: { provider_key: string }) => p.provider_key === 'fatsecret');
    expect(fatsecret).toMatchObject({
      provider_family: 'product_data',
      connection_model: 'platform',
      credential_model: 'oauth_client',
      credential: { required: true, secret_reference: null, configured: false },
    });
    expect(fatsecret.capabilities.map((c: { capability: string }) => c.capability)).toEqual(['barcode_lookup', 'food_search', 'nutrition_lookup', 'product_search']);
  });

  it('A/B/C: ordinary, full_management, pediatric, view_only and revoked Accounts are refused on every admin route', async () => {
    for (const account of [SEED.accountA, SEED.accountFullManagement, SEED.accountPediatric, SEED.accountViewOnly, SEED.accountRevoked, SEED.accountUnrelated]) {
      const u = as(account);
      expect((await u.get(BASE)).status, account).toBe(403);
      expect((await u.get(`${BASE}/fatsecret`)).status).toBe(403);
      expect((await u.patch(`${BASE}/fatsecret`, { enabled: true })).status).toBe(403);
      expect((await u.post(`${BASE}/fatsecret/test`)).status).toBe(403);
      expect((await u.get(`${BASE}/fatsecret/health`)).status).toBe(403);
      expect((await u.get(`${BASE}/fatsecret/audit`)).status).toBe(403);
      expect((await u.get(`${BASE}/routing`, { family: 'product_data', capability: 'barcode_lookup' })).status).toBe(403);
      expect((await u.post(BASE, { provider_key: 'sneaky', display_name: 'x', provider_family: 'product_data', connection_model: 'platform', credential_model: 'none' })).status).toBe(403);
    }
    expect((await request(app).get(BASE)).status).toBe(401);
  });

  it('A/B: RLS refuses non-admins even when calling the database directly', async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('request.jwt.claim.sub', $1, true)", [SEED.accountFullManagement]);
      await client.query('set local role authenticated');
      expect((await client.query('select * from external_provider')).rows).toEqual([]);
      expect((await client.query("update external_provider set enabled = true where provider_key = 'usda' returning id")).rows).toEqual([]);
      await expect(client.query("insert into platform_role_assignment (account_id, role) values ($1, 'platform_admin')", [SEED.accountFullManagement])).rejects.toThrow(/permission denied/);
    } finally {
      await client.query('rollback');
      client.release();
    }
    for (const fn of ["select * from external_provider_audit_history(gen_random_uuid())", 'select * from external_provider_connection_counts()']) {
      const c = await pool.connect();
      try {
        await c.query('begin');
        await c.query("select set_config('request.jwt.claim.sub', $1, true)", [SEED.accountA]);
        await c.query('set local role authenticated');
        await expect(c.query(fn)).rejects.toThrow(/platform_admin required/);
      } finally {
        await c.query('rollback');
        c.release();
      }
    }
  });

  it('E: platform_admin gains no Profile health or nutrition access', async () => {
    const a = admin();
    expect((await a.get(`/v1/profiles/${SEED.profileA}`)).status).toBe(404);
    expect((await a.get(`/v1/profiles/${SEED.profileChild}/meals`)).status).toBe(404);
    expect((await a.get(`/v1/profiles/${SEED.profileA}/weight-measurements`)).status).toBe(404);
    expect((await a.get(`/v1/profiles/${SEED.profileA}/progress`, { from: '2026-09-01', to: '2026-09-02', timezone: 'UTC' })).status).toBe(404);
    const scope = await pool.connect();
    try {
      await scope.query('begin');
      await scope.query("select set_config('request.jwt.claim.sub', $1, true)", [ADMIN]);
      await scope.query('set local role authenticated');
      expect((await scope.query('select profile_access_scope($1) as s', [SEED.profileA])).rows[0].s).toBeNull();
      expect((await scope.query('select count(*)::int as n from meal_item')).rows[0].n).toBe(0);
      expect((await scope.query('select count(*)::int as n from wearable_connection')).rows[0].n).toBe(0);
    } finally {
      await scope.query('rollback');
      scope.release();
    }
  });

  it('a revoked platform role grants nothing', async () => {
    await pool.query("insert into account (id, email, display_name) values ('a0a0a0a0-0000-4000-8000-0000000000ae', 'former-admin@example.com', 'Former')");
    await pool.query("insert into platform_role_assignment (account_id, role, revoked_at) values ('a0a0a0a0-0000-4000-8000-0000000000ae', 'platform_admin', now())");
    expect((await as('a0a0a0a0-0000-4000-8000-0000000000ae').get(BASE)).status).toBe(403);
  });
});

describe('§31 extensibility: a new ProductDataProvider plugs in without core changes', () => {
  it('registers, configures, references its secret, enables and is discovered by capability routing', async () => {
    const registered = await registerProvider({
      provider_key: 'example_product_provider',
      display_name: 'Example Product Provider',
      credential_model: 'api_key',
      capabilities: [{ capability: 'barcode_lookup', priority: 5 }, { capability: 'product_search', priority: 5 }],
    });
    expect(registered.status).toBe(201);
    expect(registered.body).toMatchObject({ enabled: false, adapter: { available: true, test_connection_supported: true }, credential: { required: true, configured: false } });

    // cannot be enabled before it is configured
    const early = await admin().patch(`${BASE}/example_product_provider`, { enabled: true });
    expect(early.status).toBe(409);
    expect(early.body.error.details.blockers).toEqual(expect.arrayContaining(['invalid_configuration', 'credential_not_configured']));

    const configured = await admin().patch(`${BASE}/example_product_provider`, { configuration: { api_version: 'v2', market: 'AE' }, secret_reference: 'env:EXAMPLE_PRODUCT_SECRET' });
    expect(configured.status).toBe(200);
    expect(configured.body).toMatchObject({ configuration: { api_version: 'v2', market: 'AE' }, credential: { secret_reference: 'env:EXAMPLE_PRODUCT_SECRET', configured: true } });

    const enabled = await admin().patch(`${BASE}/example_product_provider`, { enabled: true });
    expect(enabled.status).toBe(200);
    expect(enabled.body.enabled).toBe(true);

    const plan = await admin().get(`${BASE}/routing`, { family: 'product_data', capability: 'barcode_lookup' });
    expect(plan.body.routes).toEqual([
      { position: 0, kind: 'internal', key: 'internal_product_catalog' },
      { position: 1, kind: 'external', provider_key: 'example_product_provider', priority: 5 },
    ]);
    const search = await admin().get(`${BASE}/routing`, { family: 'product_data', capability: 'product_search' });
    expect(search.body.routes.map((r: { provider_key?: string; key?: string }) => r.provider_key ?? r.key)).toEqual(['internal_product_catalog', 'example_product_provider']);

    // the core domains are untouched and still behave as before
    expect((await as(SEED.accountA).get('/v1/foods', { q: 'rice' })).status).toBe(200);
    expect((await as(SEED.accountA).get('/v1/products/barcode/4006381333931')).status).toBe(404);
  });

  it('ordinary server code (any authenticated caller) routes by capability without admin rights, and gets no secrets', async () => {
    const router = new ProviderRouter(buildRegistry());
    const db = new PgHarnessScopedDbFactory(pool).forUser({ accountId: SEED.accountA, accessToken: signTestToken(SEED.accountA) } as never);
    const plan = await router.plan(db, 'product_data', 'barcode_lookup');
    const external = plan.routes.filter((r) => r.kind === 'external');
    expect(external.map((r) => (r.kind === 'external' ? r.provider_key : ''))).toEqual(['example_product_provider']);
    const route = external[0];
    if (route?.kind !== 'external') throw new Error('no route');
    expect(route.configuration).toEqual({ api_version: 'v2', market: 'AE' });
    expect(JSON.stringify(plan)).not.toContain(SECRET_VALUE);
    const candidate = await (route.definition.adapter as ProductDataAdapter).lookupBarcode?.(
      { provider_key: route.provider_key, environment: route.environment, configuration: route.configuration, timeoutMs: 1000, secret: async () => 'unused' },
      '04006381333931',
    );
    expect(candidate).toMatchObject({ external_id: 'ext-04006381333931' });
  });
});

describe('§32 priority, §20 routing, H/I', () => {
  it('orders providers deterministically by priority; a disabled provider is not routed', async () => {
    for (const [key, priority] of [
      ['provider_a', 1],
      ['provider_b', 2],
    ] as const) {
      expect((await registerProvider({ provider_key: key, display_name: key, capabilities: [{ capability: 'barcode_lookup', priority }] })).status).toBe(201);
      expect((await admin().patch(`${BASE}/${key}`, { enabled: true })).status).toBe(200);
    }
    const order = async () =>
      (await admin().get(`${BASE}/routing`, { family: 'product_data', capability: 'barcode_lookup' })).body.routes
        .filter((r: { kind: string }) => r.kind === 'external')
        .map((r: { provider_key: string }) => r.provider_key);
    expect(await order()).toEqual(['provider_a', 'provider_b', 'example_product_provider']);

    // H: disable provider_a -> provider_b first
    expect((await admin().patch(`${BASE}/provider_a`, { enabled: false })).status).toBe(200);
    expect(await order()).toEqual(['provider_b', 'example_product_provider']);

    // priority change reorders; a disabled capability is not routed
    expect((await admin().patch(`${BASE}/example_product_provider`, { capabilities: [{ capability: 'barcode_lookup', priority: 1 }] })).status).toBe(200);
    expect(await order()).toEqual(['example_product_provider', 'provider_b']);
    // an enabled provider cannot lose its last supported capability
    const lastCapability = await admin().patch(`${BASE}/provider_b`, { capabilities: [{ capability: 'barcode_lookup', enabled: false }] });
    expect(lastCapability.status).toBe(409);
    expect(lastCapability.body.error.details.blockers).toEqual(['no_supported_capability_enabled']);
    // a disabled capability is not routed while the provider's other capabilities stay routable
    expect((await admin().patch(`${BASE}/example_product_provider`, { capabilities: [{ capability: 'product_search', enabled: false }] })).status).toBe(200);
    const search = await admin().get(`${BASE}/routing`, { family: 'product_data', capability: 'product_search' });
    expect(search.body.routes.map((r: { provider_key?: string; key?: string }) => r.provider_key ?? r.key)).toEqual(['internal_product_catalog']);
    expect(await order()).toEqual(['example_product_provider', 'provider_b']);
    expect((await admin().patch(`${BASE}/example_product_provider`, { capabilities: [{ capability: 'product_search', enabled: true }] })).status).toBe(200);
  });

  it('I: an unsupported capability is not routed and cannot be assigned', async () => {
    const plan = await admin().get(`${BASE}/routing`, { family: 'product_data', capability: 'nutrition_lookup' });
    expect(plan.body.routes.filter((r: { kind: string }) => r.kind === 'external')).toEqual([]);
    const assign = await admin().patch(`${BASE}/provider_b`, { capabilities: [{ capability: 'nutrition_lookup' }] });
    expect(assign.status).toBe(400);
    expect(assign.body.error.details.reason).toBe('capability_not_supported_by_adapter');
  });

  it('seeded providers without adapters can never be enabled or routed', async () => {
    const res = await admin().patch(`${BASE}/fatsecret`, { enabled: true });
    expect(res.status).toBe(409);
    expect(res.body.error.details.blockers).toEqual(expect.arrayContaining(['adapter_not_available', 'credential_not_configured']));
    // even if the row were flipped directly in the database, routing excludes it
    await pool.query("update external_provider set enabled = true where provider_key = 'open_food_facts'");
    const plan = await admin().get(`${BASE}/routing`, { family: 'product_data', capability: 'barcode_lookup' });
    expect(plan.body.routes.map((r: { provider_key?: string }) => r.provider_key)).not.toContain('open_food_facts');
    expect(plan.body.excluded).toEqual([{ provider_key: 'open_food_facts', reason: 'adapter_not_available' }]);
    await pool.query("update external_provider set enabled = false where provider_key = 'open_food_facts'");
    // identity stays with Supabase Auth
    const identity = await admin().patch(`${BASE}/google_sign_in`, { enabled: true });
    expect(identity.status).toBe(409);
    expect(identity.body.error.details.blockers).toContain('identity_managed_by_supabase_auth');
  });
});

describe('§33 family and capability isolation', () => {
  beforeAll(async () => {
    expect((await registerProvider({ provider_key: 'example_shop', display_name: 'Example Shop', provider_family: 'commerce', capabilities: [{ capability: 'product_search' }, { capability: 'price' }] })).status).toBe(201);
    expect((await admin().patch(`${BASE}/example_shop`, { enabled: true })).status).toBe(200);
    expect(
      (await registerProvider({ provider_key: 'example_band', display_name: 'Example Band', provider_family: 'wearable', connection_model: 'user_authorized', capabilities: [{ capability: 'activity_sync' }] })).status,
    ).toBe(201);
    expect((await admin().patch(`${BASE}/example_band`, { enabled: true })).status).toBe(200);
  });

  it('a commerce provider cannot take barcode_lookup, and never appears in product_data routes', async () => {
    const res = await admin().patch(`${BASE}/example_shop`, { capabilities: [{ capability: 'barcode_lookup' }] });
    expect(res.status).toBe(400);
    const reg = await registerProvider({ provider_key: 'shop_two', display_name: 'Shop Two', provider_family: 'commerce', capabilities: [{ capability: 'barcode_lookup' }] });
    expect(reg.status).toBe(400);
    // the database refuses it too (composite FK to the family vocabulary)
    const shopId = (await pool.query("select id from external_provider where provider_key = 'example_shop'")).rows[0].id;
    await expect(pool.query("insert into external_provider_capability (provider_id, provider_family, capability) values ($1, 'commerce', 'barcode_lookup')", [shopId])).rejects.toThrow(/foreign key/);
    await expect(pool.query("insert into external_provider_capability (provider_id, provider_family, capability) values ($1, 'product_data', 'barcode_lookup')", [shopId])).rejects.toThrow(/foreign key/);

    const productSearch = await admin().get(`${BASE}/routing`, { family: 'product_data', capability: 'product_search' });
    expect(productSearch.body.routes.map((r: { provider_key?: string; key?: string }) => r.provider_key ?? r.key)).not.toContain('example_shop');
    const commerceSearch = await admin().get(`${BASE}/routing`, { family: 'commerce', capability: 'product_search' });
    expect(commerceSearch.body.routes).toEqual([{ position: 0, kind: 'external', provider_key: 'example_shop', priority: 100 }]);
  });

  it('a wearable provider is never a product-data provider; undefined family/capability pairs route to nothing', async () => {
    const wrong = await admin().get(`${BASE}/routing`, { family: 'product_data', capability: 'activity_sync' });
    expect(wrong.body).toMatchObject({ capability_defined: false, routes: [] });
    const right = await admin().get(`${BASE}/routing`, { family: 'wearable', capability: 'activity_sync' });
    expect(right.body.routes).toEqual([{ position: 0, kind: 'external', provider_key: 'example_band', priority: 100 }]);
    // an adapter of another family registered under a provider_key is excluded
    const reg = await registerProvider({ provider_key: 'example_band_as_product', display_name: 'x', capabilities: [] });
    expect(reg.status).toBe(201);
  });

  it('a family mismatch between the registry row and the adapter blocks registration', async () => {
    const res = await registerProvider({ provider_key: 'example_band', display_name: 'dup', provider_family: 'product_data' });
    expect([400, 409]).toContain(res.status);
    const mismatch = await registerProvider({ provider_key: 'example_shop_twin', display_name: 'x' });
    expect(mismatch.status).toBe(201); // no adapter under this key: registrable, never enableable
    expect((await admin().patch(`${BASE}/example_shop_twin`, { enabled: true })).body.error.details.blockers).toContain('adapter_not_available');
  });
});

describe('J: configuration is validated per adapter; secrets never enter configuration', () => {
  it('rejects unknown, wrong-typed and cross-provider settings, and secret-looking keys', async () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['example_product_provider', { api_version: 'v9' }, 'invalid_configuration'],
      ['example_product_provider', { api_version: 'v1', store_region: 'AE' }, 'invalid_configuration'], // example_shop's setting
      ['example_shop', { api_version: 'v1' }, 'invalid_configuration'],
      ['example_product_provider', { api_version: 'v1', api_key: 'abc' }, 'secret_in_configuration'],
      ['example_product_provider', { api_version: 'v1', nested: { client_secret: 'abc' } }, 'secret_in_configuration'],
      ['fatsecret', { region: 'AE' }, 'no_configuration_schema'],
    ];
    for (const [key, configuration, reason] of cases) {
      const res = await admin().patch(`${BASE}/${key}`, { configuration });
      expect(res.status, `${key} ${JSON.stringify(configuration)}`).toBe(400);
      expect(res.body.error.details.reason).toBe(reason);
    }
    const stored = await pool.query("select configuration from external_provider where provider_key = 'example_product_provider'");
    expect(stored.rows[0].configuration).toEqual({ api_version: 'v2', market: 'AE' });
  });

  it('a secret is accepted only as a reference; plaintext values are refused by the API and the database', async () => {
    for (const secret_reference of [SECRET_VALUE, 'vault:fatsecret', 'env:lowercase', 'EXAMPLE_PRODUCT_SECRET']) {
      expect((await admin().patch(`${BASE}/fatsecret`, { secret_reference })).status).toBe(400);
    }
    await expect(pool.query("update external_provider set secret_reference = $1 where provider_key = 'fatsecret'", [SECRET_VALUE])).rejects.toThrow(/secret_reference/);
    const none = await admin().patch(`${BASE}/open_food_facts`, { secret_reference: 'env:OFF_KEY' });
    expect(none.status).toBe(400); // a credential-less provider takes no secret
  });

  it('a runtime-invalid stored configuration is not routed', async () => {
    await pool.query("update external_provider set configuration = '{\"api_version\": \"v9\"}' where provider_key = 'example_product_provider'");
    const plan = await admin().get(`${BASE}/routing`, { family: 'product_data', capability: 'barcode_lookup' });
    expect(plan.body.excluded).toEqual(expect.arrayContaining([{ provider_key: 'example_product_provider', reason: 'invalid_configuration' }]));
    await pool.query("update external_provider set configuration = '{\"api_version\": \"v2\", \"market\": \"AE\"}' where provider_key = 'example_product_provider'");
  });
});

describe('§21-24 health, failure and retry model', () => {
  it('a successful test records healthy + last successful check; a wrong credential records authentication_failed (not retryable)', async () => {
    const ok = await admin().post(`${BASE}/example_product_provider/test`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ result: 'succeeded', failure: null, enabled: true, credential_configured: true, health: { status: 'healthy', failure_code: null } });
    expect(ok.body.health.last_successful_check_at).toBe(ok.body.health.checked_at);

    await admin().patch(`${BASE}/example_product_provider`, { secret_reference: 'env:EXAMPLE_WRONG_SECRET' });
    const bad = await admin().post(`${BASE}/example_product_provider/test`);
    expect(bad.body).toMatchObject({ result: 'failed', failure: { code: 'authentication_failed', retryable: false }, health: { status: 'authentication_failed', failure_code: 'authentication_failed' } });
    expect(bad.body.health.last_successful_check_at).toBe(ok.body.health.checked_at);
    await admin().patch(`${BASE}/example_product_provider`, { secret_reference: 'env:EXAMPLE_PRODUCT_SECRET' });

    const health = await admin().get(`${BASE}/example_product_provider/health`);
    expect(health.body).toMatchObject({ provider_key: 'example_product_provider', health: { status: 'authentication_failed' } });
  });

  it('raw provider errors map to provider_unavailable with no message; timeouts and rate limits are retryable', async () => {
    await registerProvider({ provider_key: 'failing_provider', display_name: 'Failing', credential_model: 'api_key', capabilities: [{ capability: 'barcode_lookup' }] });
    await admin().patch(`${BASE}/failing_provider`, { secret_reference: 'env:FAILING_SECRET' });
    const failed = await admin().post(`${BASE}/failing_provider/test`);
    expect(failed.status).toBe(200);
    expect(failed.body).toMatchObject({ result: 'failed', failure: { code: 'provider_unavailable', retryable: true }, health: { status: 'unavailable' } });
    expect(JSON.stringify(failed.body)).not.toMatch(/upstream|500 for key/);

    await registerProvider({ provider_key: 'slow_provider', display_name: 'Slow', capabilities: [{ capability: 'barcode_lookup' }] });
    await admin().patch(`${BASE}/slow_provider`, { configuration: { request_timeout_ms: 50 } });
    const slow = await admin().post(`${BASE}/slow_provider/test`);
    expect(slow.body).toMatchObject({ failure: { code: 'timeout', retryable: true }, health: { status: 'unavailable', failure_code: 'timeout' } });

    await registerProvider({ provider_key: 'limited_provider', display_name: 'Limited', capabilities: [{ capability: 'barcode_lookup' }] });
    const limited = await admin().post(`${BASE}/limited_provider/test`);
    expect(limited.body).toMatchObject({ failure: { code: 'rate_limited', retryable: true, retry_after_seconds: 30 }, health: { status: 'rate_limited' } });
  });

  it('no test for providers without an adapter, device-native or identity providers; missing credentials are reported, not called', async () => {
    expect((await admin().post(`${BASE}/fatsecret/test`)).body.error.details.reason).toBe('adapter_not_available');
    expect((await admin().post(`${BASE}/apple_health/test`)).body.error.details.reason).toBe('no_server_connection');
    expect((await admin().post(`${BASE}/google_sign_in/test`)).body.error.details.reason).toBe('no_server_connection');
    expect((await admin().post(`${BASE}/provider_a/test`)).body.error.details.reason).toBe('test_not_supported');
  });
});

describe('§10-13: platform configuration vs user connection; device-native', () => {
  it('WHOOP (user-authorized) links to the existing WearableConnection model; admins see aggregate counts only', async () => {
    await pool.query("insert into wearable_connection (profile_id, provider, provider_account_reference) values ($1, 'whoop', 'whoop-user-1')", [SEED.profileA]);
    await pool.query("insert into wearable_connection (profile_id, provider, provider_account_reference, last_sync_status) values ($1, 'whoop', 'whoop-user-2', 'retryable_failure')", [SEED.profileB]);
    const res = await admin().get(`${BASE}/whoop`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      provider_family: 'wearable',
      connection_model: 'user_authorized',
      credential_model: 'oauth_client',
      wearable_provider: 'whoop',
      user_connections: { model: 'wearable_connection', wearable_provider: 'whoop', active_connections: 2, failing_connections: 1 },
    });
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/whoop-user-|b0b0b0b0|profile_id/);
  });

  it('Apple Health / Health Connect are device-native: no server credential, no secret, no server test', async () => {
    for (const key of ['apple_health', 'health_connect']) {
      const res = await admin().get(`${BASE}/${key}`);
      expect(res.body).toMatchObject({ provider_family: 'device_health', connection_model: 'device_native', credential_model: 'device_native', credential: { required: false, configured: null } });
      expect((await admin().patch(`${BASE}/${key}`, { secret_reference: 'env:SOME_KEY' })).status).toBe(400);
    }
    await expect(pool.query("update external_provider set connection_model = 'platform' where provider_key = 'apple_health'")).rejects.toThrow();
    // a device-native adapter definition registers with OS permissions, not server operations
    expect((await registerProvider({ provider_key: 'example_device', display_name: 'Example Device', provider_family: 'device_health', connection_model: 'device_native', credential_model: 'device_native', capabilities: [{ capability: 'sleep_read' }] })).status).toBe(201);
    expect((await admin().patch(`${BASE}/example_device`, { enabled: true })).status).toBe(200);
    const plan = await admin().get(`${BASE}/routing`, { family: 'device_health', capability: 'sleep_read' });
    expect(plan.body.routes).toEqual([{ position: 0, kind: 'external', provider_key: 'example_device', priority: 100 }]);
  });

  it('server-to-server providers need no user connection', async () => {
    const res = await admin().get(`${BASE}/example_product_provider`);
    expect(res.body).toMatchObject({ connection_model: 'platform', user_connections: null });
  });
});

describe('§25 audit', () => {
  it('every admin change is an AuditEvent with ids and field names only', async () => {
    const res = await admin().get(`${BASE}/example_product_provider/audit`);
    expect(res.status).toBe(200);
    const types = res.body.items.map((e: { event_type: string }) => e.event_type);
    for (const t of [
      'external_provider_registered',
      'external_provider_capability_added',
      'external_provider_configuration_changed',
      'external_provider_secret_reference_changed',
      'external_provider_enabled',
      'external_provider_priority_changed',
      'external_provider_health_checked',
    ]) {
      expect(types, t).toContain(t);
    }
    const byAdmin = res.body.items.filter((e: { actor_account_id: string | null }) => e.actor_account_id === ADMIN);
    expect(byAdmin.length).toBeGreaterThan(0);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('EXAMPLE_PRODUCT_SECRET');
    expect(text).not.toContain(SECRET_VALUE);
    expect(text).not.toContain('"AE"'); // configuration values are not copied into audit
    const disabled = (await admin().get(`${BASE}/provider_a/audit`)).body.items.map((e: { event_type: string }) => e.event_type);
    expect(disabled).toContain('external_provider_disabled');
    // clients still cannot read audit_event directly
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('request.jwt.claim.sub', $1, true)", [ADMIN]);
      await c.query('set local role authenticated');
      await expect(c.query('select * from audit_event')).rejects.toThrow(/permission denied/);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });

  it('registry rows are never deleted and provider identity is immutable', async () => {
    await expect(pool.query("delete from external_provider where provider_key = 'provider_a'")).rejects.toThrow();
    await expect(pool.query("update external_provider set provider_key = 'renamed' where provider_key = 'provider_a'")).rejects.toThrow(/immutable/);
    await expect(pool.query("update external_provider set provider_family = 'commerce' where provider_key = 'provider_a'")).rejects.toThrow();
  });
});

describe('F/G: secrets never leave the server', () => {
  it('F: no API response contains a secret value', async () => {
    const responses = [
      await admin().get(BASE),
      await admin().get(`${BASE}/example_product_provider`),
      await admin().get(`${BASE}/example_product_provider/health`),
      await admin().post(`${BASE}/example_product_provider/test`),
      await admin().get(`${BASE}/example_product_provider/audit`),
      await admin().get(`${BASE}/routing`, { family: 'product_data', capability: 'barcode_lookup' }),
      await admin().post(`${BASE}/failing_provider/test`),
    ];
    for (const r of responses) {
      expect(JSON.stringify(r.body)).not.toContain(SECRET_VALUE);
      expect(JSON.stringify(r.body)).not.toContain(WRONG_SECRET_VALUE);
    }
  });

  it('G: no log line contains a secret value (including a provider error that embedded it)', () => {
    expect(logs.length).toBeGreaterThan(0);
    const all = logs.join('\n');
    expect(all).not.toContain(SECRET_VALUE);
    expect(all).not.toContain(WRONG_SECRET_VALUE);
  });
});

describe('vocabulary and API shape for a future Admin UI', () => {
  it('the TypeScript capability vocabulary equals the database vocabulary', async () => {
    const { rows } = await pool.query('select provider_family, capability from provider_capability_definition order by 1, 2');
    const db: Record<string, string[]> = {};
    for (const r of rows) (db[r.provider_family] ??= []).push(r.capability);
    const code = Object.fromEntries(Object.entries(FAMILY_CAPABILITIES).map(([f, caps]) => [f, [...caps].sort()]));
    expect(Object.fromEntries(Object.entries(db).map(([f, caps]) => [f, [...caps].sort()]))).toEqual(code);
    const res = await admin().get(`${BASE}/capabilities`);
    expect(res.body.families).toEqual(JSON.parse(JSON.stringify(FAMILY_CAPABILITIES)));
  });

  it('each list item carries what a dashboard needs', async () => {
    const res = await admin().get(BASE);
    const item = res.body.items.find((p: { provider_key: string }) => p.provider_key === 'example_product_provider');
    expect(Object.keys(item).sort()).toEqual(
      ['adapter', 'capabilities', 'configuration', 'connection_model', 'created_at', 'credential', 'credential_model', 'deployment_environment', 'display_name', 'enabled', 'environment', 'health', 'provider_family', 'provider_key', 'updated_at', 'wearable_provider'].sort(),
    );
    expect(item.capabilities[0]).toEqual({ capability: 'barcode_lookup', enabled: true, priority: 1, supported_by_adapter: true });
    expect((await admin().get(`${BASE}/not_registered`)).status).toBe(404);
  });
});
