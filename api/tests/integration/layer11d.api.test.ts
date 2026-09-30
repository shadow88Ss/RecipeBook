// Layer 11D integration tests — FatSecret and Open Food Facts adapters
// through the Layer 11C registry, routing and admin API, against the real
// migration chain and RLS harness. Provider HTTP is a deterministic fixture
// (tests/helpers/providerFixtures.ts): this is mock-verified adapter
// behaviour, not live-provider verification.

import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import pino from 'pino';
import request from 'supertest';
import { createApp } from '../../src/app';
import { createDefaultAdapterRegistry } from '../../src/domain/integrations/adapters';
import { EnvSecretResolver } from '../../src/domain/integrations/secrets';
import { PgHarnessProfileRepository } from '../helpers/pgHarnessProfileRepository';
import { PgHarnessScopedDbFactory } from '../helpers/pgHarnessScopedDb';
import { rebuildTestDatabase } from '../helpers/testDb';
import { seedScenario, SEED } from '../helpers/seed';
import { signTestToken, TEST_JWT_SECRET } from '../helpers/jwt';
import { seedNutritionFixtures } from '../helpers/nutritionFixtures';
import { BARCODE, seedProductFixtures } from '../helpers/productFixtures';
import { FakeProviderHttp, FS_ACCESS_TOKEN_PREFIX, FS_CLIENT_ID, FS_CLIENT_SECRET, FS_OATS, FS_YOGURT, OFF_KJ_ONLY, OFF_SPREAD } from '../helpers/providerFixtures';

const ADMIN = 'a0a0a0a0-0000-4000-8000-0000000000ad';
const CONTACT = 'dev-contact@myrecipebook.example';
const ADMIN_BASE = '/v1/admin/integrations';
const LOOKUP = (code: string) => `/v1/products/barcode/${code}/lookup`;

let pool: Pool;
let app: ReturnType<typeof createApp>;
const http = new FakeProviderHttp();
const logs: string[] = [];
let clock = Date.UTC(2026, 8, 30, 12, 0, 0);
const now = () => new Date(clock);
/** Moves past every provider cooldown and cache entry. */
const later = () => {
  clock += 3_600_000;
};

const as = (account: string) => ({
  get: (path: string, query: Record<string, string> = {}) => request(app).get(path).query(query).set('Authorization', `Bearer ${signTestToken(account)}`),
  post: (path: string, body: unknown = {}) => request(app).post(path).set('Authorization', `Bearer ${signTestToken(account)}`).send(body as object),
  patch: (path: string, body: unknown) => request(app).patch(path).set('Authorization', `Bearer ${signTestToken(account)}`).send(body as object),
});
const A = () => as(SEED.accountA);
const admin = () => as(ADMIN);

const FS_CONFIG = { cache_ttl_seconds: 0, request_timeout_ms: 500 };
const OFF_CONFIG = { contact_email: CONTACT, cache_ttl_seconds: 0, request_timeout_ms: 500 };

async function countReferenceRows() {
  const { rows } = await pool.query(
    'select (select count(*) from product)::int as product, (select count(*) from product_label_version)::int as label, (select count(*) from product_nutrient)::int as nutrient, (select count(*) from product_serving)::int as serving, (select count(*) from barcode)::int as barcode, (select count(*) from food)::int as food',
  );
  return rows[0];
}

beforeAll(async () => {
  pool = await rebuildTestDatabase('recipebook_api_test_layer11d');
  await seedScenario(pool);
  await seedNutritionFixtures(pool);
  await seedProductFixtures(pool);
  await pool.query("insert into account (id, email, display_name) values ($1, 'platform-admin@example.com', 'Platform Admin')", [ADMIN]);
  await pool.query("insert into platform_role_assignment (account_id, role) values ($1, 'platform_admin')", [ADMIN]);
  http.fsFoods.set(FS_YOGURT.food_id, FS_YOGURT);
  http.fsFoods.set(FS_OATS.food_id, FS_OATS);
  http.offProducts.set(OFF_SPREAD.code, OFF_SPREAD);
  http.offProducts.set(OFF_KJ_ONLY.code, OFF_KJ_ONLY);
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
      registry: createDefaultAdapterRegistry({ fetch: http.fetch, now }),
      secrets: new EnvSecretResolver({ FATSECRET_CLIENT_ID: FS_CLIENT_ID, FATSECRET_CLIENT_SECRET: FS_CLIENT_SECRET }),
      deploymentEnvironment: 'test',
      now,
    },
  });
}, 120_000);

afterAll(async () => {
  await pool.end();
});

beforeEach(() => {
  http.reset();
  later();
});

describe('42 A-C: the real adapters register through the 11C framework', () => {
  it('nothing is callable until a platform_admin configures and enables the rows', async () => {
    const res = await A().get(LOOKUP('5901234123457'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'none', candidates: [], external_lookup: { status: 'not_configured', providers_answered: [], complete: true } });
    expect(http.calls).toEqual([]);
    const enable = await admin().patch(`${ADMIN_BASE}/fatsecret`, { enabled: true });
    expect(enable.status).toBe(409);
    expect(enable.body.error.details.blockers).toEqual(['credential_not_configured']);
  });

  it('platform_admin configures FatSecret (OAuth client credential by reference) and Open Food Facts (User-Agent contact)', async () => {
    const fs = await admin().patch(`${ADMIN_BASE}/fatsecret`, { configuration: FS_CONFIG, secret_reference: 'env:FATSECRET_CLIENT_SECRET', enabled: true });
    expect(fs.status).toBe(200);
    expect(fs.body).toMatchObject({
      enabled: true,
      adapter: { available: true, test_connection_supported: true },
      credential: { required: true, attached: true, configured: true },
    });
    expect(fs.body.capabilities).toEqual([
      { capability: 'barcode_lookup', enabled: true, priority: 20, supported_by_adapter: true },
      { capability: 'food_search', enabled: false, priority: 20, supported_by_adapter: false },
      { capability: 'nutrition_lookup', enabled: true, priority: 20, supported_by_adapter: true },
      { capability: 'product_search', enabled: true, priority: 20, supported_by_adapter: true },
    ]);
    const off = await admin().patch(`${ADMIN_BASE}/open_food_facts`, { configuration: OFF_CONFIG, enabled: true });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ enabled: true, adapter: { available: true }, credential: { required: false, attached: false, configured: null } });
    expect(off.body.capabilities.find((c: { capability: string }) => c.capability === 'product_search')).toEqual({ capability: 'product_search', enabled: false, priority: 30, supported_by_adapter: false });
    // an unsupported capability cannot be switched back on
    const bad = await admin().patch(`${ADMIN_BASE}/open_food_facts`, { capabilities: [{ capability: 'product_search', enabled: true }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.reason).toBe('capability_not_supported_by_adapter');
    // the credential reference must be the one the adapter declares
    const other = await admin().patch(`${ADMIN_BASE}/fatsecret`, { secret_reference: 'env:SOME_OTHER_SECRET' });
    expect(other.body.error.details.reason).toBe('secret_reference_not_declared_by_adapter');
    // an OFF configuration without a contact is refused
    expect((await admin().patch(`${ADMIN_BASE}/open_food_facts`, { configuration: { app_name: 'MyRecipeBook' } })).status).toBe(400);
  });

  it('45 G / 31: platform_admin tests both connections with minimal read requests; results land in health', async () => {
    const fs = await admin().post(`${ADMIN_BASE}/fatsecret/test`);
    expect(fs.body).toMatchObject({ result: 'succeeded', health: { status: 'healthy' } });
    expect(http.callsTo('fatsecret_token')).toHaveLength(1);
    expect(http.callsTo('fatsecret').every((c) => c.method === 'GET')).toBe(true);
    const off = await admin().post(`${ADMIN_BASE}/open_food_facts/test`);
    expect(off.body).toMatchObject({ result: 'succeeded', health: { status: 'healthy' } });
    expect(http.callsTo('off').every((c) => c.method === 'GET')).toBe(true);
    http.fatsecret = 'invalid_ip';
    const failed = await admin().post(`${ADMIN_BASE}/fatsecret/test`);
    expect(failed.body).toMatchObject({ result: 'failed', failure: { code: 'authentication_failed', retryable: false }, health: { status: 'authentication_failed' } });
    http.fatsecret = 'ok';
    expect((await admin().post(`${ADMIN_BASE}/fatsecret/test`)).body.health.status).toBe('healthy');
    const list = await admin().get(ADMIN_BASE);
    const row = list.body.items.find((p: { provider_key: string }) => p.provider_key === 'fatsecret');
    expect(row).toMatchObject({ enabled: true, adapter: { available: true }, credential: { configured: true }, health: { status: 'healthy' } });
    expect(row.health.last_successful_check_at).toBeTruthy();
  });
});

describe('43: barcode lookup is internal-first and external results stay candidates', () => {
  it('A: an internal Product barcode wins without any provider call', async () => {
    const res = await A().get(LOOKUP(BARCODE.yogurtAE));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'internal', match: { match: 'exact_canonical_gtin', canonical_gtin: '04006381333931' }, candidates: [], external_lookup: null });
    expect(res.body.product.id).toBeTruthy();
    expect(http.calls).toEqual([]);
  });

  it('F: an invalid barcode is rejected before any lookup or provider call', async () => {
    for (const code of ['5901234123458', '59012341234x7', '1234567']) {
      const res = await A().get(LOOKUP(code));
      expect(res.status, code).toBe(400);
    }
    expect((await A().get(LOOKUP('96385074'))).status).toBe(400); // 8 digits: type must be declared
    expect(http.calls).toEqual([]);
  });

  it('B, E, G, I-L: an unknown EAN-13 routes externally; the FatSecret candidate is normalized and nothing is written', async () => {
    http.fsBarcodes.set('5901234123457', FS_YOGURT.food_id);
    const before = await countReferenceRows();
    const res = await A().get(LOOKUP('5901234123457'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      submitted: { canonical_gtin: '05901234123457', barcode_type: 'ean_13' },
      source: 'external_candidate',
      product: null,
      preferred_candidate: { provider_key: 'fatsecret', external_product_id: '4384' },
      external_lookup: { status: 'found', providers_answered: ['fatsecret'], complete: true },
      next_step: 'confirmation_required_before_use',
    });
    const [c] = res.body.candidates;
    expect(c).toMatchObject({
      status: 'unconfirmed_external_candidate',
      loggable: false,
      provider_key: 'fatsecret',
      brand_name: 'Example Dairy',
      product_name: 'Plain Greek Yogurt',
      barcode: { canonical_gtin: '05901234123457', provider_code: '5901234123457' },
      provenance: { authority: 'external_candidate' },
    });
    expect(http.callsTo('fatsecret')[0]?.url).toContain('barcode=5901234123457');
    expect(http.callsTo('off')).toEqual([]); // mode=first stops at the first answer
    expect(await countReferenceRows()).toEqual(before);
    // the existing canonical endpoint is unchanged and never calls providers
    http.reset();
    expect((await A().get('/v1/products/barcode/5901234123457')).status).toBe(404);
    expect(http.calls).toEqual([]);
  });

  it('C, D: UPC-A and UPC-E use Layer 11A normalization before any provider sees them', async () => {
    http.fsBarcodes.set('0012345678905', FS_OATS.food_id);
    const upcA = await A().get(LOOKUP('012345678905'));
    expect(upcA.body.submitted).toMatchObject({ canonical_gtin: '00012345678905', barcode_type: 'upc_a' });
    expect(upcA.body.candidates[0]).toMatchObject({ external_product_id: '38821', barcode: { canonical_gtin: '00012345678905', provider_code: '0012345678905' } });
    http.fsBarcodes.set('0004252000061', FS_OATS.food_id);
    const upcE = await A().get(LOOKUP('00425261'), { type: 'upc_e' });
    expect(upcE.body.submitted).toMatchObject({ canonical_gtin: '00004252000061', barcode_type: 'upc_e' });
    expect(http.callsTo('fatsecret').map((c) => new URL(c.url).searchParams.get('barcode')).filter(Boolean)).toEqual(['0012345678905', '0004252000061']);
  });

  it('H: the Open Food Facts candidate is normalized into the same contract, with attribution', async () => {
    const res = await A().get(LOOKUP('3017624010701'));
    expect(res.body).toMatchObject({ source: 'external_candidate', external_lookup: { status: 'found', providers_answered: ['open_food_facts'] } });
    const [c] = res.body.candidates;
    expect(c).toMatchObject({
      provider_key: 'open_food_facts',
      external_product_id: '3017624010701',
      brand_name: 'Example Foods',
      package: { quantity: '400', unit: 'g' },
      markets: ['en:france', 'en:germany'],
      provenance: { authority: 'external_candidate', attribution: { required: true, link: 'https://openfoodfacts.org' } },
    });
    expect(http.callsTo('off')[0]?.headers['user-agent']).toBe(`MyRecipeBook/1.0 (${CONTACT})`);
  });

  it('11B boundary: a candidate cannot be logged as a Product', async () => {
    const res = await A().post(`/v1/profiles/${SEED.profileA}/meals`, {
      meal_type: 'snack',
      logged_date: new Date().toISOString().slice(0, 10),
      local_timezone: 'UTC',
      consumed_at: new Date().toISOString(),
      items: [{ type: 'product', product_id: 'fatsecret:4384', quantity: 1, unit: 'g' }],
    });
    expect(res.status).toBe(400);
    expect((await pool.query("select count(*)::int as n from meal_item where product_id is not null")).rows[0].n).toBe(0);
  });
});

describe('42 D-K and 16-18: routing, fallback and aggregate outcomes', () => {
  const both = '3017624010701';
  beforeEach(() => {
    http.fsBarcodes.set(both, FS_YOGURT.food_id);
  });

  it('D: configured priority decides the order; E: a disabled provider is skipped', async () => {
    let res = await A().get(LOOKUP(both));
    expect(res.body.candidates.map((c: { provider_key: string }) => c.provider_key)).toEqual(['fatsecret']);
    expect((await admin().patch(`${ADMIN_BASE}/open_food_facts`, { capabilities: [{ capability: 'barcode_lookup', priority: 5 }] })).status).toBe(200);
    http.reset();
    res = await A().get(LOOKUP(both));
    expect(res.body.candidates.map((c: { provider_key: string }) => c.provider_key)).toEqual(['open_food_facts']);
    expect(http.callsTo('fatsecret')).toEqual([]);
    expect((await admin().patch(`${ADMIN_BASE}/open_food_facts`, { capabilities: [{ capability: 'barcode_lookup', priority: 30 }] })).status).toBe(200);

    expect((await admin().patch(`${ADMIN_BASE}/fatsecret`, { enabled: false })).status).toBe(200);
    http.reset();
    res = await A().get(LOOKUP(both));
    expect(res.body.external_lookup.providers_answered).toEqual(['open_food_facts']);
    expect(http.callsTo('fatsecret')).toEqual([]);
    expect(http.callsTo('fatsecret_token')).toEqual([]);
    expect((await admin().patch(`${ADMIN_BASE}/fatsecret`, { enabled: true })).status).toBe(200);
  });

  it('18/19: mode=all returns provider-distinct, unmerged candidates and their disagreements', async () => {
    const res = await A().get(LOOKUP(both), { mode: 'all' });
    expect(res.body.candidates.map((c: { provider_key: string }) => c.provider_key)).toEqual(['fatsecret', 'open_food_facts']);
    expect(res.body.preferred_candidate.provider_key).toBe('fatsecret');
    const fields = res.body.disagreements.map((d: { field: string }) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['brand_name', 'product_name']));
    const [fs, off] = res.body.candidates;
    expect(fs.brand_name).toBe('Example Dairy');
    expect(off.brand_name).toBe('Example Foods');
    expect(off.nutrition[0].nutrients.find((n: { nutrient_key: string }) => n.nutrient_key === 'protein')).toBeUndefined();
  });

  it('F: not_found falls through to the next provider', async () => {
    http.fsBarcodes.delete(both);
    const res = await A().get(LOOKUP(both));
    expect(res.body).toMatchObject({ source: 'external_candidate', external_lookup: { status: 'found', providers_answered: ['open_food_facts'], complete: true } });
    expect(http.callsTo('fatsecret').length).toBeGreaterThan(0);
  });

  it('G: a timeout falls through safely (bounded by the configured timeout)', async () => {
    http.fatsecret = 'timeout';
    const started = Date.now();
    const res = await A().get(LOOKUP(both));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(res.body).toMatchObject({ source: 'external_candidate', external_lookup: { status: 'found', providers_answered: ['open_food_facts'], complete: false } });
  });

  it('H: an authentication failure is handled, the provider cools down, and another provider answers', async () => {
    http.fatsecret = 'invalid_ip'; // FatSecret refuses the (valid) token from this address
    const res = await A().get(LOOKUP(both));
    expect(res.body.external_lookup.providers_answered).toEqual(['open_food_facts']);
    const apiCalls = http.callsTo('fatsecret').length;
    expect(apiCalls).toBeGreaterThan(0);
    // cooling down: FatSecret is not called again for a while
    http.fatsecret = 'ok';
    await A().get(LOOKUP(both));
    expect(http.callsTo('fatsecret')).toHaveLength(apiCalls);
    expect(JSON.stringify(res.body)).not.toMatch(/authentication|Invalid IP|10\.0\.0\.1/);
  });

  it('I: a rate limit is handled (no immediate retry) and the next provider answers', async () => {
    http.fatsecret = 'http_429';
    const res = await A().get(LOOKUP(both));
    expect(res.body.external_lookup.providers_answered).toEqual(['open_food_facts']);
    expect(http.callsTo('fatsecret')).toHaveLength(1);
    http.fatsecret = 'ok';
    await A().get(LOOKUP(both)); // still inside Retry-After: FatSecret skipped
    expect(http.callsTo('fatsecret')).toHaveLength(1);
  });

  it('J: an invalid provider response is never a candidate', async () => {
    http.fatsecret = 'malformed';
    const res = await A().get(LOOKUP(both));
    expect(res.body.candidates.map((c: { provider_key: string }) => c.provider_key)).toEqual(['open_food_facts']);
    expect(res.body.external_lookup.complete).toBe(false);
  });

  it('K: every provider failing is a safe aggregate outcome, not an error or a silent not-found', async () => {
    http.fatsecret = 'http_500';
    http.off = 'network_error';
    const res = await A().get(LOOKUP(both));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'none', candidates: [], external_lookup: { status: 'temporarily_unavailable', providers_answered: [], complete: false } });
    expect(JSON.stringify(res.body)).not.toMatch(/provider_unavailable|upstream|fetch failed|health/);
    later();
    http.reset();
    const nowhere = await A().get(LOOKUP('4003994155486'));
    expect(nowhere.body).toMatchObject({ source: 'none', external_lookup: { status: 'not_found', complete: true } });
  });
});

describe('14: provider-backed search and candidate retrieval', () => {
  it('search returns labelled external candidates only; Open Food Facts search is not used', async () => {
    const res = await A().get('/v1/external-products/search', { q: 'Greek Yogurt' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'external_candidate', external_lookup: { status: 'found', providers_answered: ['fatsecret'] } });
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ provider_key: 'fatsecret', nutrient_mapping_status: 'not_retrieved', status: 'unconfirmed_external_candidate' });
    expect(http.callsTo('off')).toEqual([]);
    expect((await A().get('/v1/external-products/search', { q: 'x' })).status).toBe(400);
    const none = await A().get('/v1/external-products/search', { q: 'unobtainium' });
    expect(none.body).toMatchObject({ items: [], external_lookup: { status: 'not_found' } });
  });

  it('nutrition lookup by provider id; unknown ids 404; unavailable providers 503 without detail', async () => {
    const fs = await A().get('/v1/external-products/fatsecret/4384');
    expect(fs.status).toBe(200);
    expect(fs.body.candidate).toMatchObject({ provider_key: 'fatsecret', external_product_id: '4384', nutrient_mapping_status: 'core_complete' });
    const off = await A().get('/v1/external-products/open_food_facts/5000112637922');
    expect(off.body.candidate.nutrition[0].unmapped).toEqual(expect.arrayContaining([expect.objectContaining({ provider_field: 'energy-kj_100g', reason: 'kj_only_no_approved_conversion' })]));
    expect((await A().get('/v1/external-products/fatsecret/999999')).status).toBe(404);
    expect((await A().get('/v1/external-products/usda/1')).status).toBe(404);
    expect((await A().get('/v1/external-products/fatsecret/bad%20id')).status).toBe(400);
    http.fatsecret = 'http_500';
    const down = await A().get('/v1/external-products/fatsecret/38821');
    expect(down.status).toBe(503);
    expect(down.body.error).toMatchObject({ code: 'SERVICE_UNAVAILABLE', message: 'The product source is temporarily unavailable.' });
    expect(down.body.error.details).toBeUndefined();
  });
});

describe('45: security', () => {
  it('A-C, H: consumer responses carry no secret, token, client id, reference name, configuration or raw payload', async () => {
    http.fsBarcodes.set('5901234123457', FS_YOGURT.food_id);
    const bodies = [
      (await A().get(LOOKUP('5901234123457'))).body,
      (await A().get(LOOKUP('3017624010701'), { mode: 'all' })).body,
      (await A().get('/v1/external-products/search', { q: 'oats' })).body,
      (await A().get('/v1/external-products/fatsecret/4384')).body,
    ];
    http.fatsecret = 'leaky_error';
    later();
    bodies.push((await A().get('/v1/external-products/fatsecret/38821')).body);
    const all = JSON.stringify(bodies);
    for (const forbidden of [FS_CLIENT_SECRET, FS_CLIENT_ID, FS_ACCESS_TOKEN_PREFIX, 'env:', 'FATSECRET_CLIENT', 'secret_reference', CONTACT, 'request_timeout_ms', 'food_description', 'serving_url', 'nutriments', 'health_status']) {
      expect(all, forbidden).not.toContain(forbidden);
    }
  });

  it('D: the routing function gives ordinary users no secret reference or credential metadata', async () => {
    const db = new PgHarnessScopedDbFactory(pool).forUser({ accountId: SEED.accountA, accessToken: signTestToken(SEED.accountA) } as never);
    const rows = await db.rpcRows<Record<string, unknown>>('enabled_provider_routes', { p_family: 'product_data', p_capability: 'barcode_lookup' });
    expect(rows.map((r) => r.provider_key)).toEqual(['fatsecret', 'open_food_facts']);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(['configuration', 'credential_attached', 'environment', 'priority', 'provider_key']);
    expect(JSON.stringify(rows)).not.toMatch(/env:|FATSECRET_CLIENT|client_id|secret_reference/i);
    // and the registry table itself stays unreadable to them
    expect(await db.select('external_provider', { columns: 'provider_key, secret_reference', limit: 10 })).toEqual([]);
  });

  it('E: admin DTOs show credential state, never the secret or its reference name', async () => {
    const bodies = [(await admin().get(ADMIN_BASE)).body, (await admin().get(`${ADMIN_BASE}/fatsecret`)).body, (await admin().get(`${ADMIN_BASE}/fatsecret/audit`)).body];
    const all = JSON.stringify(bodies);
    for (const forbidden of [FS_CLIENT_SECRET, FS_CLIENT_ID, FS_ACCESS_TOKEN_PREFIX, 'FATSECRET_CLIENT_SECRET', 'FATSECRET_CLIENT_ID']) expect(all, forbidden).not.toContain(forbidden);
    expect(bodies[1].credential).toEqual({ required: true, attached: true, configured: true });
  });

  it('F: an ordinary user cannot change provider configuration or run a test', async () => {
    expect((await A().patch(`${ADMIN_BASE}/fatsecret`, { enabled: false })).status).toBe(403);
    expect((await A().post(`${ADMIN_BASE}/fatsecret/test`)).status).toBe(403);
    const db = new PgHarnessScopedDbFactory(pool).forUser({ accountId: SEED.accountA, accessToken: signTestToken(SEED.accountA) } as never);
    expect(await db.update('external_provider', { provider_key: 'fatsecret' }, { enabled: false }, 'provider_key')).toBeNull();
    const { rows } = await pool.query("select enabled from external_provider where provider_key = 'fatsecret'");
    expect(rows[0].enabled).toBe(true);
  });

  it('38: logs carry provider, capability, outcome, duration and request id; never secrets, tokens, queries or payloads', () => {
    const all = logs.join('\n');
    for (const forbidden of [FS_CLIENT_SECRET, FS_ACCESS_TOKEN_PREFIX, 'Greek Yogurt', 'unobtainium', 'Plain Greek', 'Hazelnut', CONTACT]) expect(all, forbidden).not.toContain(forbidden);
    const calls = logs.map((l) => JSON.parse(l)).filter((l) => l.event === 'integration_call');
    expect(calls.length).toBeGreaterThan(10);
    for (const line of calls) {
      expect(Object.keys(line)).toEqual(expect.arrayContaining(['provider_key', 'family', 'capability', 'outcome', 'duration_ms', 'request_id']));
      expect(typeof line.request_id).toBe('string');
    }
    expect(calls.map((l) => l.outcome)).toEqual(expect.arrayContaining(['found', 'not_found', 'timeout', 'rate_limited', 'authentication_failed', 'invalid_provider_response']));
  });
});

describe('46: storage boundary', () => {
  it('B, C: the provider TTL is enforced and expired temporary data is not treated as current', async () => {
    expect((await admin().patch(`${ADMIN_BASE}/fatsecret`, { configuration: { ...FS_CONFIG, cache_ttl_seconds: 60 } })).status).toBe(200);
    expect((await admin().patch(`${ADMIN_BASE}/fatsecret`, { configuration: { ...FS_CONFIG, cache_ttl_seconds: 86_401 } })).status).toBe(400);
    const first = await A().get('/v1/external-products/fatsecret/4384');
    const second = await A().get('/v1/external-products/fatsecret/4384');
    expect(first.body.candidate.freshness.served_from_cache).toBe(false);
    expect(second.body.candidate.freshness.served_from_cache).toBe(true);
    expect(second.body.candidate.retrieved_at).toBe(first.body.candidate.retrieved_at);
    const apiCalls = http.callsTo('fatsecret').length;
    clock += 61_000;
    const third = await A().get('/v1/external-products/fatsecret/4384');
    expect(third.body.candidate.freshness.served_from_cache).toBe(false);
    expect(third.body.candidate.retrieved_at).toBe(now().toISOString());
    expect(http.callsTo('fatsecret').length).toBe(apiCalls + 1);
    expect((await admin().patch(`${ADMIN_BASE}/fatsecret`, { configuration: FS_CONFIG })).status).toBe(200);
  });

  it('A, D, E, F: nothing is persisted; storable identifiers and provenance follow each provider policy', async () => {
    const before = await countReferenceRows();
    http.fsBarcodes.set('3017624010701', FS_YOGURT.food_id);
    const res = await A().get(LOOKUP('3017624010701'), { mode: 'all' });
    const [fs, off] = res.body.candidates;
    expect(fs.storage).toEqual({ indefinitely_storable: { food_id: '4384', serving_id: ['17120'] }, temporary_cache_max_seconds: 86_400, raw_response_retained: false, persisted: false });
    expect(off.storage).toEqual({ indefinitely_storable: {}, temporary_cache_max_seconds: 86_400, raw_response_retained: false, persisted: false });
    for (const c of [fs, off]) {
      expect(c.provenance).toMatchObject({ source_type: 'external_provider', provider_key: c.provider_key, authority: 'external_candidate' });
      expect(Date.parse(c.retrieved_at)).not.toBeNaN();
    }
    expect(await countReferenceRows()).toEqual(before);
  });
});
