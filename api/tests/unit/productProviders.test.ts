// Layer 11D — FatSecret and Open Food Facts adapters against deterministic
// HTTP fixtures (mock-verified behaviour; no live provider is called).

import { beforeEach, describe, expect, it } from 'vitest';
import type { AdapterDefinition, ProductDataAdapter } from '../../src/domain/integrations/adapters';
import { createAdapterContext } from '../../src/domain/integrations/execution';
import { IntegrationFailure } from '../../src/domain/integrations/integration.model';
import { providerDisagreements, type ExternalProductCandidate } from '../../src/domain/integrations/productData';
import { createFatSecretDefinition, fatSecretBarcode, fatSecretConfigSchema } from '../../src/domain/integrations/providers/fatsecret';
import { createOpenFoodFactsDefinition, openFoodFactsCode } from '../../src/domain/integrations/providers/openFoodFacts';
import { EnvSecretResolver } from '../../src/domain/integrations/secrets';
import { normalizeBarcode } from '../../src/domain/products/barcode';
import { FakeProviderHttp, FS_ACCESS_TOKEN_PREFIX, FS_CLIENT_ID, FS_CLIENT_SECRET, FS_OATS, FS_YOGURT, OFF_KJ_ONLY, OFF_SPREAD } from '../helpers/providerFixtures';

let http: FakeProviderHttp;
let clock: number;
const now = () => new Date(clock);
const secrets = new EnvSecretResolver({ FATSECRET_CLIENT_ID: FS_CLIENT_ID, FATSECRET_CLIENT_SECRET: FS_CLIENT_SECRET });

function ctx(def: AdapterDefinition, config: Record<string, unknown> = {}, environment: 'production' | 'sandbox' = 'production') {
  return createAdapterContext({
    definition: def,
    providerKey: def.provider_key,
    environment,
    configuration: def.configSchema.parse(config),
    credentialAttached: true,
    secrets,
    signal: new AbortController().signal,
    requestId: 'req-test',
  });
}
const gtin = (code: string, type?: Parameters<typeof normalizeBarcode>[1]) => {
  const n = normalizeBarcode(code, type);
  if (!n.ok) throw new Error(n.message);
  return n.gtin;
};
const ops = (def: AdapterDefinition) => def.adapter as ProductDataAdapter;
const failureOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return err as IntegrationFailure;
  }
  throw new Error('expected a failure');
};
const nutrient = (c: ExternalProductCandidate, key: string, basis = 0) => c.nutrition[basis]?.nutrients.find((n) => n.nutrient_key === key);
const unmappedField = (c: ExternalProductCandidate, field: string, basis = 0) => c.nutrition[basis]?.unmapped.find((n) => n.provider_field === field);

beforeEach(() => {
  http = new FakeProviderHttp();
  clock = Date.UTC(2026, 8, 30, 12, 0, 0);
  http.fsFoods.set(FS_YOGURT.food_id, FS_YOGURT);
  http.fsFoods.set(FS_OATS.food_id, FS_OATS);
  http.fsBarcodes.set('5901234123457', FS_YOGURT.food_id);
  http.offProducts.set(OFF_SPREAD.code, OFF_SPREAD);
  http.offProducts.set(OFF_KJ_ONLY.code, OFF_KJ_ONLY);
});

describe('barcode request forms come from the Layer 11A canonical GTIN', () => {
  it('UPC-A, EAN-13, EAN-8, UPC-E (11A expansion) and GTIN-14', () => {
    expect(fatSecretBarcode(gtin('036000291452'))).toBe('0036000291452'); // UPC-A
    expect(fatSecretBarcode(gtin('5901234123457'))).toBe('5901234123457'); // EAN-13
    expect(fatSecretBarcode(gtin('96385074', 'ean_8'))).toBe('0000096385074'); // EAN-8 as GTIN-13
    expect(fatSecretBarcode(gtin('01234565', 'upc_e'))).toBe('0012345000065'); // UPC-E -> UPC-A 012345000065
    expect(fatSecretBarcode(gtin('10036000291459'))).toBeNull(); // packaging-level GTIN-14 has no GTIN-13 form
    expect(openFoodFactsCode(gtin('5901234123457'))).toBe('5901234123457');
    expect(openFoodFactsCode(gtin('036000291452'))).toBe('0036000291452');
    expect(openFoodFactsCode(gtin('96385074', 'ean_8'))).toBe('96385074');
    expect(openFoodFactsCode(gtin('10036000291459'))).toBe('10036000291459');
  });
});

describe('FatSecret adapter', () => {
  const def = () => createFatSecretDefinition({ fetch: http.fetch, now });

  it('declares only implemented capabilities and a server-side credential', () => {
    const d = def();
    expect(d.capabilities).toEqual(['product_search', 'barcode_lookup', 'nutrition_lookup']);
    expect(d.credential).toEqual({ reference: 'env:FATSECRET_CLIENT_SECRET', parts: { client_id: 'env:FATSECRET_CLIENT_ID' } });
    expect(ops(d).searchFoods).toBeUndefined();
    expect(fatSecretConfigSchema.safeParse({ cache_ttl_seconds: 90_000 }).success).toBe(false); // > 24 h storage limit
    expect(fatSecretConfigSchema.safeParse({ api_base_url: 'https://evil.example' }).success).toBe(false);
  });

  it('barcode lookup -> normalized candidate (G, 44 A-K)', async () => {
    const d = def();
    const c = (await ops(d).lookupBarcode?.(ctx(d), gtin('5901234123457'))) as ExternalProductCandidate;
    expect(c).toMatchObject({
      status: 'unconfirmed_external_candidate',
      loggable: false,
      provider_key: 'fatsecret',
      external_product_id: '4384',
      barcode: { canonical_gtin: '05901234123457', provider_code: '5901234123457' },
      brand_name: 'Example Dairy',
      product_name: 'Plain Greek Yogurt',
      markets: ['US'],
      package: null,
      provenance: { source_type: 'external_provider', authority: 'external_candidate', provider_classification: 'commercial_nutrition_database' },
      storage: { indefinitely_storable: { food_id: '4384', serving_id: ['17120'] }, temporary_cache_max_seconds: 86_400, raw_response_retained: false, persisted: false },
    });
    expect(c.retrieved_at).toBe(now().toISOString());
    expect(c.servings).toEqual([
      { external_serving_id: '17120', description: '1 container (170 g)', metric_quantity: '170.000', metric_unit: 'g', number_of_units: '1.000', measurement_description: 'container', is_default: null },
    ]);
    expect(c.nutrition[0]?.basis).toEqual({ kind: 'per_serving', external_serving_id: '17120', metric_quantity: '170.000', metric_unit: 'g' });
    expect(nutrient(c, 'energy')).toMatchObject({ amount: '100', unit: 'kcal', status: 'reported', provider_field: 'calories' });
    expect(nutrient(c, 'protein')).toMatchObject({ amount: '17', unit: 'g' });
    expect(nutrient(c, 'carbohydrate')).toMatchObject({ amount: '6', unit: 'g' }); // US total carbohydrate
    expect(nutrient(c, 'fat')).toMatchObject({ amount: '0', status: 'known_zero' }); // H
    expect(nutrient(c, 'fiber')).toBeUndefined(); // I: omitted -> missing, never 0
    expect(nutrient(c, 'sodium')).toMatchObject({ amount: '65', unit: 'mg' });
    expect(unmappedField(c, 'saturated_fat')).toMatchObject({ reason: 'no_canonical_key' }); // G
    expect(unmappedField(c, 'calcium')).toMatchObject({ reason: 'unit_unverified' });
    expect(c.nutrient_mapping_status).toBe('core_complete');
    expect(JSON.stringify(c)).not.toMatch(/manufacturer/);
  });

  it('non-US database: carbohydrate definition is not assumed', async () => {
    const d = def();
    const c = (await ops(d).fetchNutrition?.(ctx(d, { region: 'GB' }), '4384')) as ExternalProductCandidate;
    expect(nutrient(c, 'carbohydrate')).toBeUndefined();
    expect(unmappedField(c, 'carbohydrate')).toMatchObject({ reason: 'carbohydrate_definition_unverified', amount: '6' });
    expect(c.nutrient_mapping_status).toBe('partial');
    expect(http.callsTo('fatsecret')[0]?.url).toContain('region=GB');
  });

  it('generic food with several servings; unknown barcode and unknown id are not found', async () => {
    const d = def();
    const oats = (await ops(d).fetchNutrition?.(ctx(d), '38821')) as ExternalProductCandidate;
    expect(oats.warnings).toContain('generic_food_not_a_branded_product');
    expect(oats.servings.map((s) => s.external_serving_id)).toEqual(['1', '2']);
    expect(oats.servings[1]?.is_default).toBe(true);
    expect(nutrient(oats, 'fiber', 1)).toMatchObject({ amount: '10.1' });
    expect(await ops(d).lookupBarcode?.(ctx(d), gtin('4006381333931'))).toBeNull();
    expect(await ops(d).fetchNutrition?.(ctx(d), '999999')).toBeNull();
    expect(await ops(d).fetchNutrition?.(ctx(d), 'abc')).toBeNull();
  });

  it('search returns candidates without inventing nutrition', async () => {
    const d = def();
    const items = (await ops(d).searchProducts?.(ctx(d), { query: 'yogurt', limit: 5 })) as ExternalProductCandidate[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ external_product_id: '4384', nutrient_mapping_status: 'not_retrieved', nutrition: [] });
    expect(items[0]?.warnings).toContain('nutrition_requires_lookup');
    expect(http.callsTo('fatsecret')[0]?.url).toContain('max_results=5');
  });

  it('OAuth client credentials: token reused, single-flight, refreshed near expiry and after "invalid token"', async () => {
    const d = def();
    await Promise.all([ops(d).fetchNutrition?.(ctx(d, { cache_ttl_seconds: 0 }), '4384'), ops(d).fetchNutrition?.(ctx(d, { cache_ttl_seconds: 0 }), '38821')]);
    await ops(d).fetchNutrition?.(ctx(d, { cache_ttl_seconds: 0 }), '4384');
    expect(http.tokensIssued).toBe(1);
    const tokenCall = http.callsTo('fatsecret_token')[0];
    expect(tokenCall).toMatchObject({ method: 'POST' });
    expect(tokenCall?.body).toBe('grant_type=client_credentials&scope=barcode+basic');
    expect(tokenCall?.headers.authorization).toBe(`Basic ${Buffer.from(`${FS_CLIENT_ID}:${FS_CLIENT_SECRET}`).toString('base64')}`);
    for (const call of http.callsTo('fatsecret')) expect(call.headers.authorization).toBe(`Bearer ${FS_ACCESS_TOKEN_PREFIX}1`);

    clock += 86_400_000 - 30_000; // inside the refresh margin
    await ops(d).fetchNutrition?.(ctx(d, { cache_ttl_seconds: 0 }), '4384');
    expect(http.tokensIssued).toBe(2);

    http.expireTokenOnce = 1;
    const again = await ops(d).fetchNutrition?.(ctx(d, { cache_ttl_seconds: 0 }), '4384');
    expect(again?.external_product_id).toBe('4384');
    expect(http.tokensIssued).toBe(3);
  });

  it('failures map to the Layer 11C model and never carry provider text (H, I, J)', async () => {
    const cases: Array<[FakeProviderHttp['fatsecret'], string, boolean]> = [
      ['bad_credentials', 'authentication_failed', false],
      ['invalid_ip', 'authentication_failed', false],
      ['missing_scope', 'capability_not_supported', false],
      ['rate_limit_code', 'rate_limited', true],
      ['http_429', 'rate_limited', true],
      ['http_500', 'provider_unavailable', true],
      ['network_error', 'provider_unavailable', true],
      ['leaky_error', 'provider_unavailable', true],
      ['invalid_json', 'invalid_provider_response', false],
      ['malformed', 'invalid_provider_response', false],
    ];
    for (const [behaviour, code, retryable] of cases) {
      const d = def();
      http.fatsecret = behaviour;
      const failure = await failureOf(ops(d).lookupBarcode?.(ctx(d), gtin('5901234123457')) as Promise<unknown>);
      expect(failure, behaviour).toBeInstanceOf(IntegrationFailure);
      expect(failure.code, behaviour).toBe(code);
      expect(failure.retryable, behaviour).toBe(retryable);
      expect(failure.message).not.toContain(FS_CLIENT_SECRET);
    }
    http.fatsecret = 'http_429';
    const d = def();
    expect((await failureOf(ops(d).fetchNutrition?.(ctx(d), '4384') as Promise<unknown>)).retryAfterSeconds).toBe(120);
  });

  it('a missing credential is authentication_failed before any HTTP call', async () => {
    const d = def();
    const noSecret = createAdapterContext({
      definition: d,
      providerKey: 'fatsecret',
      environment: 'production',
      configuration: fatSecretConfigSchema.parse({}),
      credentialAttached: false,
      secrets,
      signal: new AbortController().signal,
      requestId: null,
    });
    expect((await failureOf(ops(d).fetchNutrition?.(noSecret, '4384') as Promise<unknown>)).code).toBe('authentication_failed');
    expect(http.calls).toEqual([]);
  });

  it('temporary cache: provider TTL enforced, expired data never served, normalized data only (46 B, C, F)', async () => {
    const d = def();
    const first = (await ops(d).fetchNutrition?.(ctx(d, { cache_ttl_seconds: 600 }), '4384')) as ExternalProductCandidate;
    const second = (await ops(d).fetchNutrition?.(ctx(d, { cache_ttl_seconds: 600 }), '4384')) as ExternalProductCandidate;
    expect(first.freshness.served_from_cache).toBe(false);
    expect(second.freshness).toEqual({ served_from_cache: true, cache_expires_at: new Date(clock + 600_000).toISOString() });
    expect(second.retrieved_at).toBe(first.retrieved_at);
    expect(http.callsTo('fatsecret')).toHaveLength(1);
    // another region is another cache entry
    await ops(d).fetchNutrition?.(ctx(d, { cache_ttl_seconds: 600, region: 'GB' }), '4384');
    expect(http.callsTo('fatsecret')).toHaveLength(2);
    clock += 600_001;
    const third = (await ops(d).fetchNutrition?.(ctx(d, { cache_ttl_seconds: 600 }), '4384')) as ExternalProductCandidate;
    expect(third.freshness.served_from_cache).toBe(false);
    expect(third.retrieved_at).toBe(now().toISOString());
    expect(http.callsTo('fatsecret')).toHaveLength(3);
    // ttl 0 disables caching
    await ops(d).fetchNutrition?.(ctx(d, { cache_ttl_seconds: 0 }), '38821');
    await ops(d).fetchNutrition?.(ctx(d, { cache_ttl_seconds: 0 }), '38821');
    expect(http.callsTo('fatsecret')).toHaveLength(5);
  });
});

describe('Open Food Facts adapter', () => {
  const def = () => createOpenFoodFactsDefinition({ fetch: http.fetch, now });
  const config = { contact_email: 'dev@myrecipebook.example' };

  it('declares only implemented capabilities, no credential; identifies itself with the required User-Agent', async () => {
    const d = def();
    expect(d.capabilities).toEqual(['barcode_lookup', 'nutrition_lookup']);
    expect(d.credential).toBeUndefined();
    expect(ops(d).searchProducts).toBeUndefined(); // 10 searches/min/IP is not safe for consumer search
    expect(d.configSchema.safeParse({}).success).toBe(false); // contact email is required
    expect(d.configSchema.safeParse({ ...config, product_reads_per_minute: 16 }).success).toBe(false);
    await ops(d).lookupBarcode?.(ctx(d, config), gtin('3017624010701'));
    const call = http.callsTo('off')[0];
    expect(call?.url.startsWith('https://world.openfoodfacts.org/api/v2/product/3017624010701?fields=')).toBe(true);
    expect(call?.headers['user-agent']).toBe('MyRecipeBook/1.0 (dev@myrecipebook.example)');
    expect(call?.headers.authorization).toBeUndefined();
    await ops(d).lookupBarcode?.(ctx(d, config, 'sandbox'), gtin('3017624010701'));
    expect(http.callsTo('off')[1]?.url.startsWith('https://world.openfoodfacts.net/')).toBe(true);
  });

  it('barcode lookup -> normalized candidate (H, 44 A-I)', async () => {
    const d = def();
    const c = (await ops(d).lookupBarcode?.(ctx(d, config), gtin('3017624010701'))) as ExternalProductCandidate;
    expect(c).toMatchObject({
      provider_key: 'open_food_facts',
      external_product_id: '3017624010701',
      barcode: { canonical_gtin: '03017624010701', provider_code: '3017624010701' },
      brand_name: 'Example Foods',
      product_name: 'Hazelnut Spread',
      markets: ['en:france', 'en:germany'],
      package: { quantity: '400', unit: 'g', text: '400 g' },
      ingredients_text: expect.stringContaining('hazelnuts'),
      provenance: {
        authority: 'external_candidate',
        provider_classification: 'community_product_database',
        provider_record_url: 'https://world.openfoodfacts.org/product/3017624010701',
        attribution: { required: true, link: 'https://openfoodfacts.org', licence: expect.stringContaining('ODbL') },
      },
      storage: { indefinitely_storable: {}, raw_response_retained: false, persisted: false },
    });
    expect(c.warnings).toContain('multiple_brands_listed');
    expect(c.servings).toEqual([{ external_serving_id: null, description: '15 g', metric_quantity: '15', metric_unit: 'g', number_of_units: null, measurement_description: null, is_default: null }]);
    expect(c.nutrition[0]?.basis).toEqual({ kind: 'per_100', quantity: '100', unit: 'g' });
    expect(nutrient(c, 'energy')).toMatchObject({ amount: '539', unit: 'kcal' });
    expect(nutrient(c, 'fat')).toMatchObject({ amount: '30.9' });
    expect(nutrient(c, 'fiber')).toMatchObject({ amount: '0', status: 'known_zero' });
    expect(nutrient(c, 'protein')).toBeUndefined(); // missing, not zero
    expect(nutrient(c, 'calcium')).toMatchObject({ amount: '108', unit: 'mg', provider_amount: '0.108', provider_unit: 'g' });
    expect(nutrient(c, 'carbohydrate')).toBeUndefined();
    expect(unmappedField(c, 'carbohydrates_100g')).toMatchObject({ reason: 'carbohydrate_definition_unverified' });
    expect(unmappedField(c, 'sodium_100g')).toMatchObject({ reason: 'may_be_derived_from_salt' });
    expect(unmappedField(c, 'energy-kj_100g')).toMatchObject({ reason: 'kj_only_no_approved_conversion' });
    expect(unmappedField(c, 'vitamin-a_100g')).toMatchObject({ reason: 'measure_requires_mapping_review' });
    expect(c.nutrition[0]?.missing_core).toEqual(['protein', 'carbohydrate']);
    expect(c.nutrient_mapping_status).toBe('partial');
  });

  it('kJ-only energy stays unmapped: no conversion, no 4/4/9 (44 J, K)', async () => {
    const d = def();
    const c = (await ops(d).lookupBarcode?.(ctx(d, config), gtin('5000112637922'))) as ExternalProductCandidate;
    expect(nutrient(c, 'energy')).toBeUndefined();
    expect(unmappedField(c, 'energy-kj_100g')).toMatchObject({ amount: '180', unit: 'kJ', reason: 'kj_only_no_approved_conversion' });
    expect(nutrient(c, 'protein')).toMatchObject({ status: 'known_zero' });
    expect(c.nutrition[0]?.basis).toEqual({ kind: 'per_100', quantity: '100', unit: 'ml' });
    expect(c.nutrition[0]?.missing_core).toEqual(['energy', 'carbohydrate', 'fat']);
    expect(c.package).toEqual({ quantity: '330', unit: 'ml', text: '330 ml' });
  });

  it('not found, invalid responses and the local rate budget', async () => {
    const d = def();
    expect(await ops(d).lookupBarcode?.(ctx(d, config), gtin('5901234123457'))).toBeNull();
    expect(await ops(d).fetchNutrition?.(ctx(d, config), '12')).toBeNull(); // not an OFF code: no call
    expect(http.callsTo('off')).toHaveLength(1);
    http.off = 'malformed';
    expect((await failureOf(ops(def()).lookupBarcode?.(ctx(d, config), gtin('3017624010701')) as Promise<unknown>)).code).toBe('invalid_provider_response');
    http.off = 'invalid_json';
    expect((await failureOf(ops(def()).lookupBarcode?.(ctx(d, config), gtin('3017624010701')) as Promise<unknown>)).code).toBe('invalid_provider_response');
    http.off = 'ok';
    const limited = def();
    const tight = { ...config, product_reads_per_minute: 2, cache_ttl_seconds: 0 };
    await ops(limited).lookupBarcode?.(ctx(limited, tight), gtin('3017624010701'));
    await ops(limited).lookupBarcode?.(ctx(limited, tight), gtin('3017624010701'));
    const before = http.callsTo('off').length;
    const refused = await failureOf(ops(limited).lookupBarcode?.(ctx(limited, tight), gtin('3017624010701')) as Promise<unknown>);
    expect(refused.code).toBe('rate_limited');
    expect(refused.retryAfterSeconds).toBe(60);
    expect(http.callsTo('off')).toHaveLength(before); // refused locally, provider not called
    clock += 60_001;
    await ops(limited).lookupBarcode?.(ctx(limited, tight), gtin('3017624010701'));
    expect(http.callsTo('off')).toHaveLength(before + 1);
  });
});

describe('provider disagreement is preserved, never merged (44 L)', () => {
  it('reports differing fields per provider and keeps each candidate intact', async () => {
    http.fsBarcodes.set('3017624010701', FS_YOGURT.food_id);
    const fs = createFatSecretDefinition({ fetch: http.fetch, now });
    const off = createOpenFoodFactsDefinition({ fetch: http.fetch, now });
    const a = (await ops(fs).lookupBarcode?.(ctx(fs), gtin('3017624010701'))) as ExternalProductCandidate;
    const b = (await ops(off).lookupBarcode?.(ctx(off, { contact_email: 'dev@myrecipebook.example' }), gtin('3017624010701'))) as ExternalProductCandidate;
    const diff = providerDisagreements([a, b]);
    expect(diff.map((d) => d.field)).toEqual(expect.arrayContaining(['brand_name', 'product_name', 'serving']));
    expect(diff.find((d) => d.field === 'brand_name')?.values).toEqual([
      { provider_key: 'fatsecret', value: 'example dairy' },
      { provider_key: 'open_food_facts', value: 'example foods' },
    ]);
    expect(nutrient(a, 'energy')?.amount).toBe('100');
    expect(nutrient(b, 'energy')?.amount).toBe('539');
    expect(nutrient(b, 'protein')).toBeUndefined(); // not filled from the other provider
  });
});
