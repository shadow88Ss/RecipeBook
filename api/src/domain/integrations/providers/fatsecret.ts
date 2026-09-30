// Layer 11D — FatSecret Platform API product_data adapter.
//
// Authentication: OAuth 2.0 client credentials only (the only grant the
// platform supports for server-to-server use). The client id and secret are
// resolved server-side from the adapter's declared env references; the
// access token lives in this process's memory only, is reused until shortly
// before it expires, is fetched single-flight, and is never logged, stored
// or returned. An "invalid token" answer drops it and retries once.
//
// Endpoints (URL-based API): food/barcode/find-by-id/v1 (barcode scope,
// GTIN-13 request form), food/v4 (servings + nutrition), foods/search/v1.
// Search answers carry no structured nutrition, so search candidates are
// `not_retrieved` until a nutrition_lookup is made for the food_id.
//
// Storage (platform.fatsecret.com/docs/guides/storable-data): only listed
// identifiers — here food_id and serving_id — may be kept indefinitely;
// everything else at most 24 hours. The adapter keeps nothing but a bounded
// in-memory candidate cache (TTL <= 24 h) and persists nothing.

import { z } from 'zod';
import type { AdapterContext, AdapterDefinition, ProductDataAdapter, ProductSearchRequest } from '../adapters';
import { IntegrationFailure } from '../integration.model';
import {
  buildCandidate,
  mapNutrients,
  providerDecimal,
  type CandidateNutritionBasis,
  type CandidateServing,
  type ExternalProductCandidate,
  type NutrientFieldRule,
  type ProviderStoragePolicy,
} from '../productData';
import { CandidateCache, cached, isRecord, providerRequest, text, type Transport } from './shared';

export const FATSECRET_PROVIDER_KEY = 'fatsecret';
export const FATSECRET_TOKEN_URL = 'https://oauth.fatsecret.com/connect/token';
export const FATSECRET_API_BASE = 'https://platform.fatsecret.com/rest';
export const FATSECRET_CREDENTIAL = {
  reference: 'env:FATSECRET_CLIENT_SECRET',
  parts: { client_id: 'env:FATSECRET_CLIENT_ID' },
} as const;

export const FATSECRET_STORAGE_POLICY: ProviderStoragePolicy = {
  terms_reference: 'https://platform.fatsecret.com/docs/guides/storable-data',
  indefinitely_storable: ['food_id', 'serving_id'],
  temporary_cache_max_seconds: 86_400,
  raw_response_retention: 'none',
  persistence: 'identifiers_only_after_ingestion_approval',
  // Attribution depends on the account's FatSecret plan; confirm it before
  // showing candidates in a client (Layer 11D report, deferred items).
  attribution: { required: false, text: null, link: null, licence: null },
};

export const fatSecretConfigSchema = z.strictObject({
  /** FatSecret regional database (ISO 3166-1 alpha-2). Non-US needs the
   * localization scope on the account. */
  region: z.string().regex(/^[A-Z]{2}$/).default('US'),
  language: z.string().regex(/^[a-z]{2}$/).optional(),
  scopes: z.array(z.enum(['basic', 'premier', 'barcode'])).min(1).max(3).default(['basic', 'barcode']),
  request_timeout_ms: z.number().int().min(500).max(10_000).default(4000),
  cache_ttl_seconds: z.number().int().min(0).max(86_400).default(3600),
  max_retries: z.number().int().min(0).max(1).default(0),
  search_max_results: z.number().int().min(1).max(50).default(20),
});
export type FatSecretConfig = z.infer<typeof fatSecretConfigSchema>;

// Units per the food.get v4 documentation. Vitamin/mineral fields other than
// sodium/potassium are left unmapped until their units are verified against
// a live response. Carbohydrate is the US "total carbohydrate" only for the
// US database; other regions may state available carbohydrate.
const BASE_RULES: NutrientFieldRule[] = [
  { field: 'calories', unit: 'kcal', nutrient_key: 'energy' },
  { field: 'protein', unit: 'g', nutrient_key: 'protein' },
  { field: 'fat', unit: 'g', nutrient_key: 'fat' },
  { field: 'fiber', unit: 'g', nutrient_key: 'fiber' },
  { field: 'sodium', unit: 'mg', nutrient_key: 'sodium' },
  { field: 'potassium', unit: 'mg', nutrient_key: 'potassium' },
  { field: 'saturated_fat', unit: 'g', unmapped_reason: 'no_canonical_key' },
  { field: 'polyunsaturated_fat', unit: 'g', unmapped_reason: 'no_canonical_key' },
  { field: 'monounsaturated_fat', unit: 'g', unmapped_reason: 'no_canonical_key' },
  { field: 'trans_fat', unit: 'g', unmapped_reason: 'no_canonical_key' },
  { field: 'cholesterol', unit: 'mg', unmapped_reason: 'no_canonical_key' },
  { field: 'sugar', unit: 'g', unmapped_reason: 'no_canonical_key' },
  { field: 'added_sugars', unit: 'g', unmapped_reason: 'no_canonical_key' },
  { field: 'vitamin_a', unit: 'unverified', unmapped_reason: 'unit_unverified' },
  { field: 'vitamin_c', unit: 'unverified', unmapped_reason: 'unit_unverified' },
  { field: 'vitamin_d', unit: 'unverified', unmapped_reason: 'unit_unverified' },
  { field: 'calcium', unit: 'unverified', unmapped_reason: 'unit_unverified' },
  { field: 'iron', unit: 'unverified', unmapped_reason: 'unit_unverified' },
];

export function fatSecretNutrientRules(region: string): NutrientFieldRule[] {
  const carbohydrate: NutrientFieldRule =
    region === 'US'
      ? { field: 'carbohydrate', unit: 'g', nutrient_key: 'carbohydrate' }
      : { field: 'carbohydrate', unit: 'g', unmapped_reason: 'carbohydrate_definition_unverified' };
  return [BASE_RULES[0] as NutrientFieldRule, BASE_RULES[1] as NutrientFieldRule, carbohydrate, ...BASE_RULES.slice(2)];
}

/** FatSecret application error code -> internal outcome. */
export function fatSecretErrorOutcome(code: number): 'not_found' | 'invalid_token' | IntegrationFailure {
  if (code === 106 || code === 211) return 'not_found';
  if (code === 13) return 'invalid_token';
  if (code === 14) return new IntegrationFailure('capability_not_supported');
  if (code === 21 || (code >= 2 && code <= 9)) return new IntegrationFailure('authentication_failed');
  if (code === 11 || code === 12) return new IntegrationFailure('rate_limited');
  if (code === 24) return new IntegrationFailure('timeout');
  if (code === 1 || code === 20 || code === 23) return new IntegrationFailure('provider_unavailable');
  return new IntegrationFailure('invalid_provider_response');
}

/** GTIN-14 -> the GTIN-13 request form FatSecret documents (UPC-A, EAN-13
 * and EAN-8 zero-padded). A GTIN-14 with a packaging indicator has no
 * GTIN-13 form. */
export function fatSecretBarcode(gtin: string): string | null {
  return /^0[0-9]{13}$/.test(gtin) ? gtin.slice(1) : null;
}

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);

interface Token {
  value: string;
  expiresAt: number;
}

export function createFatSecretDefinition(deps: { fetch: Transport; now: () => Date }): AdapterDefinition<FatSecretConfig> {
  const cache = new CandidateCache(deps.now);
  const tokens = new Map<string, Token>();
  const inflight = new Map<string, Promise<Token>>();

  async function token(ctx: AdapterContext<FatSecretConfig>): Promise<string> {
    const clientId = await ctx.secret('client_id');
    const scope = [...new Set(ctx.configuration.scopes)].sort().join(' ');
    const key = `${clientId}|${scope}`;
    const current = tokens.get(key);
    if (current && current.expiresAt - 60_000 > deps.now().getTime()) return current.value;
    let pending = inflight.get(key);
    if (!pending) {
      pending = (async () => {
        const secret = await ctx.secret();
        const { status, body } = await providerRequest(ctx, deps.fetch, FATSECRET_TOKEN_URL, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ grant_type: 'client_credentials', scope }).toString(),
        });
        if (status === 400 || (isRecord(body) && typeof body.error === 'string')) throw new IntegrationFailure('authentication_failed');
        if (!isRecord(body) || typeof body.access_token !== 'string' || !body.access_token) throw new IntegrationFailure('invalid_provider_response');
        const lifetime = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600;
        const fresh = { value: body.access_token, expiresAt: deps.now().getTime() + lifetime * 1000 };
        tokens.set(key, fresh);
        return fresh;
      })().finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    return (await pending).value;
  }

  /** GET one API path; null = the provider says "no such food". */
  async function api(ctx: AdapterContext<FatSecretConfig>, path: string, params: Record<string, string>): Promise<Record<string, unknown> | null> {
    const query = new URLSearchParams({ ...params, format: 'json' });
    if (ctx.configuration.region !== 'US') query.set('region', ctx.configuration.region);
    if (ctx.configuration.language) query.set('language', ctx.configuration.language);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const bearer = await token(ctx);
      const dropToken = () => {
        for (const [k, t] of tokens) if (t.value === bearer) tokens.delete(k);
      };
      let body: unknown;
      try {
        ({ body } = await providerRequest(ctx, deps.fetch, `${FATSECRET_API_BASE}/${path}?${query.toString()}`, {
          headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' },
        }));
      } catch (err) {
        // An HTTP 401 on an API call means the token was refused: one fresh token.
        if (err instanceof IntegrationFailure && err.code === 'authentication_failed' && attempt === 0) {
          dropToken();
          continue;
        }
        throw err;
      }
      if (!isRecord(body)) throw new IntegrationFailure('invalid_provider_response');
      if (isRecord(body.error)) {
        const outcome = fatSecretErrorOutcome(Number(body.error.code));
        if (outcome === 'not_found') return null;
        if (outcome === 'invalid_token') {
          dropToken();
          if (attempt === 0) continue;
          throw new IntegrationFailure('authentication_failed');
        }
        throw outcome;
      }
      return body;
    }
    throw new IntegrationFailure('authentication_failed');
  }

  function toCandidate(ctx: AdapterContext<FatSecretConfig>, food: unknown, gtin: string | null): ExternalProductCandidate {
    if (!isRecord(food)) throw new IntegrationFailure('invalid_provider_response');
    const id = typeof food.food_id === 'string' || typeof food.food_id === 'number' ? String(food.food_id) : null;
    if (!id || !/^[0-9]+$/.test(id)) throw new IntegrationFailure('invalid_provider_response');
    const warnings: string[] = [];
    if (food.food_type === 'Generic') warnings.push('generic_food_not_a_branded_product');
    const rules = fatSecretNutrientRules(ctx.configuration.region);
    const servings: CandidateServing[] = [];
    const nutrition: CandidateNutritionBasis[] = [];
    const servingIds: string[] = [];
    const rawServings = isRecord(food.servings) ? asList(food.servings.serving) : [];
    for (const s of rawServings) {
      if (!isRecord(s)) throw new IntegrationFailure('invalid_provider_response');
      const servingId = s.serving_id === undefined ? null : String(s.serving_id);
      if (servingId) servingIds.push(servingId);
      const unit = text(s.metric_serving_unit);
      const metricUnit = unit === 'g' || unit === 'ml' ? unit : null;
      if (unit && !metricUnit) warnings.push(`serving_${servingId ?? 'unknown'}_metric_unit_unresolved`);
      const metricQuantity = metricUnit ? providerDecimal(s.metric_serving_amount) : null;
      servings.push({
        external_serving_id: servingId,
        description: text(s.serving_description),
        metric_quantity: metricQuantity,
        metric_unit: metricUnit,
        number_of_units: providerDecimal(s.number_of_units),
        measurement_description: text(s.measurement_description),
        is_default: s.is_default === undefined ? null : String(s.is_default) === '1',
      });
      nutrition.push({ basis: { kind: 'per_serving', external_serving_id: servingId, metric_quantity: metricQuantity, metric_unit: metricUnit }, ...mapNutrients(s, rules) });
    }
    return buildCandidate({
      provider_key: ctx.provider_key,
      external_product_id: id,
      retrieved_at: deps.now().toISOString(),
      barcode: gtin ? { canonical_gtin: gtin, provider_code: fatSecretBarcode(gtin) } : null,
      brand_name: text(food.brand_name),
      product_name: text(food.food_name),
      variant_name: null,
      markets: [ctx.configuration.region],
      package: null,
      servings,
      nutrition,
      ingredients_text: null,
      warnings,
      unresolved_fields: ['variant_name', 'ingredients_text'],
      classification: 'commercial_nutrition_database',
      provider_record_url: text(food.food_url),
      policy: FATSECRET_STORAGE_POLICY,
      storable: { food_id: id, serving_id: servingIds },
    });
  }

  async function getFood(ctx: AdapterContext<FatSecretConfig>, foodId: string, gtin: string | null): Promise<ExternalProductCandidate | null> {
    const body = await api(ctx, 'food/v4', { food_id: foodId });
    if (!body) return null;
    return toCandidate(ctx, body.food, gtin);
  }

  const locale = (c: FatSecretConfig) => `${c.region}:${c.language ?? ''}`;

  const adapter: ProductDataAdapter<FatSecretConfig> = {
    family: 'product_data',
    storagePolicy: FATSECRET_STORAGE_POLICY,

    async lookupBarcode(ctx, gtin) {
      const code = fatSecretBarcode(gtin);
      if (!code) return null;
      return cached(cache, CandidateCache.key(ctx.provider_key, 'barcode', gtin, locale(ctx.configuration)), ctx.configuration.cache_ttl_seconds, FATSECRET_STORAGE_POLICY, async () => {
        const body = await api(ctx, 'food/barcode/find-by-id/v1', { barcode: code });
        if (!body) return null;
        const raw = isRecord(body.food_id) ? body.food_id.value : body.food_id;
        const foodId = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : null;
        if (foodId === null || !/^[0-9]+$/.test(foodId)) throw new IntegrationFailure('invalid_provider_response');
        if (foodId === '0') return null;
        return getFood(ctx, foodId, gtin);
      });
    },

    async fetchNutrition(ctx, externalId) {
      if (!/^[0-9]{1,20}$/.test(externalId)) return null;
      return cached(cache, CandidateCache.key(ctx.provider_key, 'food', externalId, locale(ctx.configuration)), ctx.configuration.cache_ttl_seconds, FATSECRET_STORAGE_POLICY, () =>
        getFood(ctx, externalId, null),
      );
    },

    async searchProducts(ctx, request: ProductSearchRequest) {
      const limit = Math.min(request.limit, ctx.configuration.search_max_results);
      return cached(cache, CandidateCache.key(ctx.provider_key, 'search', `${limit}:${request.query}`, locale(ctx.configuration)), ctx.configuration.cache_ttl_seconds, FATSECRET_STORAGE_POLICY, async () => {
        const body = await api(ctx, 'foods/search/v1', { search_expression: request.query, max_results: String(limit), page_number: '0' });
        if (!body) return [];
        if (body.foods !== undefined && !isRecord(body.foods)) throw new IntegrationFailure('invalid_provider_response');
        const foods = isRecord(body.foods) ? asList(body.foods.food) : [];
        return foods.map((food) => {
          const candidate = toCandidate(ctx, food, null);
          return { ...candidate, warnings: [...candidate.warnings, 'nutrition_requires_lookup'] };
        });
      });
    },
  };

  return {
    provider_key: FATSECRET_PROVIDER_KEY,
    capabilities: ['product_search', 'barcode_lookup', 'nutrition_lookup'],
    configSchema: fatSecretConfigSchema,
    credential: FATSECRET_CREDENTIAL,
    adapter,
    // Token + the smallest read the basic scope allows.
    async testConnection(ctx) {
      const body = await api(ctx, 'foods/search/v1', { search_expression: 'apple', max_results: '1', page_number: '0' });
      if (body && body.foods !== undefined && !isRecord(body.foods)) throw new IntegrationFailure('invalid_provider_response');
    },
  };
}
