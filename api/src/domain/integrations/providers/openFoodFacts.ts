// Layer 11D — Open Food Facts product_data adapter (read-only).
//
// Reads need no credential, only an identifying User-Agent
// "AppName/Version (ContactEmail)" (openfoodfacts.github.io/openfoodfacts-
// server/api). Documented limits are 15 product reads/min/IP and 10
// searches/min/IP, with IP bans on abuse; this adapter enforces a local
// per-process budget (<= 15/min) before calling and does not implement
// search at all — 10/min/IP is not safe for consumer search traffic.
//
// Licence: database ODbL 1.0, contents DbCL 1.0, images CC BY-SA (not used).
// Re-use requires attribution to Open Food Facts with a link; derivative
// databases are share-alike. Layer 11D therefore persists NOTHING from Open
// Food Facts (in-memory candidate cache only) and every candidate carries
// the attribution; whether ingestion may store OFF-derived rows is an open
// licence decision for the future ingestion layer.
//
// Nutrition: `*_100g` values are per 100 g, or per 100 ml for liquids; the
// basis unit is taken from the product quantity unit and left unresolved
// otherwise. Carbohydrate is not mapped (EU products state available
// carbohydrate, the canonical key is total carbohydrate); sodium is not
// mapped (Open Food Facts derives it from salt when only salt is stated).

import { z } from 'zod';
import type { AdapterContext, AdapterDefinition, ProductDataAdapter } from '../adapters';
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
import { CandidateCache, cached, isRecord, MinuteRateLimiter, providerRequest, text, type Transport } from './shared';

export const OPEN_FOOD_FACTS_PROVIDER_KEY = 'open_food_facts';
export const OPEN_FOOD_FACTS_HOSTS = {
  production: 'https://world.openfoodfacts.org',
  // The public staging server; its documented shared basic-auth pair
  // (off:off) is not a secret.
  sandbox: 'https://world.openfoodfacts.net',
} as const;
export const OPEN_FOOD_FACTS_DOCUMENTED_READS_PER_MINUTE = 15;

export const OPEN_FOOD_FACTS_STORAGE_POLICY: ProviderStoragePolicy = {
  terms_reference: 'https://world.openfoodfacts.org/terms-of-use',
  indefinitely_storable: [],
  temporary_cache_max_seconds: 86_400,
  raw_response_retention: 'none',
  persistence: 'pending_licence_decision',
  attribution: {
    required: true,
    text: 'Product data from Open Food Facts (openfoodfacts.org), available under the Open Database License (ODbL).',
    link: 'https://openfoodfacts.org',
    licence: 'ODbL-1.0 (database), DbCL-1.0 (contents)',
  },
};

export const openFoodFactsConfigSchema = z.strictObject({
  app_name: z.string().regex(/^[A-Za-z0-9._-]{1,60}$/).default('MyRecipeBook'),
  app_version: z.string().regex(/^[0-9A-Za-z._-]{1,20}$/).default('1.0'),
  /** Required by the Open Food Facts User-Agent policy. */
  contact_email: z.email(),
  request_timeout_ms: z.number().int().min(500).max(10_000).default(4000),
  cache_ttl_seconds: z.number().int().min(0).max(86_400).default(3600),
  max_retries: z.number().int().min(0).max(1).default(0),
  product_reads_per_minute: z.number().int().min(1).max(OPEN_FOOD_FACTS_DOCUMENTED_READS_PER_MINUTE).default(10),
  health_check_barcode: z.string().regex(/^[0-9]{8,14}$/).default('3017624010701'),
});
export type OpenFoodFactsConfig = z.infer<typeof openFoodFactsConfigSchema>;

const PRODUCT_FIELDS = [
  'code',
  'product_name',
  'generic_name',
  'brands',
  'quantity',
  'product_quantity',
  'product_quantity_unit',
  'serving_size',
  'serving_quantity',
  'serving_quantity_unit',
  'nutriments',
  'nutrition_data_per',
  'ingredients_text',
  'countries_tags',
].join(',');

const mass = (field: string, key: string, unit: 'g' = 'g'): NutrientFieldRule => ({ field, unit, nutrient_key: key });
const unmapped = (field: string, unit: string, reason: NonNullable<NutrientFieldRule['unmapped_reason']>): NutrientFieldRule => ({ field, unit, unmapped_reason: reason });

/** Explicit field table for one basis suffix (`_100g` or `_serving`). All
 * non-energy values are grams. */
export function openFoodFactsNutrientRules(suffix: '_100g' | '_serving'): NutrientFieldRule[] {
  const f = (name: string) => `${name}${suffix}`;
  return [
    { field: f('energy-kcal'), unit: 'kcal', nutrient_key: 'energy' },
    unmapped(f('energy-kj'), 'kJ', 'kj_only_no_approved_conversion'),
    unmapped(f('energy'), 'kJ', 'kj_only_no_approved_conversion'),
    mass(f('proteins'), 'protein'),
    mass(f('fat'), 'fat'),
    mass(f('fiber'), 'fiber'),
    unmapped(f('carbohydrates'), 'g', 'carbohydrate_definition_unverified'),
    unmapped(f('sugars'), 'g', 'no_canonical_key'),
    unmapped(f('saturated-fat'), 'g', 'no_canonical_key'),
    unmapped(f('salt'), 'g', 'no_canonical_key'),
    unmapped(f('sodium'), 'g', 'may_be_derived_from_salt'),
    mass(f('potassium'), 'potassium'),
    mass(f('calcium'), 'calcium'),
    mass(f('iron'), 'iron'),
    mass(f('magnesium'), 'magnesium'),
    mass(f('zinc'), 'zinc'),
    mass(f('vitamin-c'), 'vitamin_c'),
    mass(f('vitamin-b1'), 'thiamin'),
    mass(f('vitamin-b2'), 'riboflavin'),
    mass(f('vitamin-b6'), 'vitamin_b6'),
    mass(f('vitamin-b12'), 'vitamin_b12'),
    mass(f('vitamin-k'), 'vitamin_k'),
    unmapped(f('vitamin-a'), 'g', 'measure_requires_mapping_review'),
    unmapped(f('vitamin-d'), 'g', 'measure_requires_mapping_review'),
    unmapped(f('vitamin-e'), 'g', 'measure_requires_mapping_review'),
    unmapped(f('vitamin-pp'), 'g', 'measure_requires_mapping_review'),
    unmapped(f('folates'), 'g', 'measure_requires_mapping_review'),
  ];
}

/** GTIN-14 -> the code form Open Food Facts indexes (EAN-8, EAN-13 or
 * GTIN-14 without the padding zeros). */
export function openFoodFactsCode(gtin: string): string {
  if (gtin.startsWith('000000')) return gtin.slice(6);
  return gtin.startsWith('0') ? gtin.slice(1) : gtin;
}

function metricUnit(value: unknown): 'g' | 'ml' | null {
  const unit = text(value)?.toLowerCase();
  return unit === 'g' || unit === 'ml' ? unit : null;
}

export function createOpenFoodFactsDefinition(deps: { fetch: Transport; now: () => Date }): AdapterDefinition<OpenFoodFactsConfig> {
  const cache = new CandidateCache(deps.now);
  const limiter = new MinuteRateLimiter(deps.now);

  async function read(ctx: AdapterContext<OpenFoodFactsConfig>, code: string): Promise<Record<string, unknown> | null> {
    limiter.take(ctx.configuration.product_reads_per_minute);
    const host = OPEN_FOOD_FACTS_HOSTS[ctx.environment];
    const headers: Record<string, string> = {
      'User-Agent': `${ctx.configuration.app_name}/${ctx.configuration.app_version} (${ctx.configuration.contact_email})`,
      Accept: 'application/json',
    };
    if (ctx.environment === 'sandbox') headers.Authorization = `Basic ${Buffer.from('off:off').toString('base64')}`;
    const { status, body } = await providerRequest(ctx, deps.fetch, `${host}/api/v2/product/${code}?fields=${PRODUCT_FIELDS}`, { headers });
    if (!isRecord(body) || (body.status !== 0 && body.status !== 1)) throw new IntegrationFailure('invalid_provider_response');
    if (body.status === 0 || status === 404) return null;
    if (!isRecord(body.product)) throw new IntegrationFailure('invalid_provider_response');
    return body.product;
  }

  function toCandidate(product: Record<string, unknown>, requestedCode: string, gtin: string | null, providerKey: string): ExternalProductCandidate {
    const code = text(product.code) ?? requestedCode;
    if (!/^[0-9]{1,14}$/.test(code)) throw new IntegrationFailure('invalid_provider_response');
    if (product.nutriments !== undefined && !isRecord(product.nutriments)) throw new IntegrationFailure('invalid_provider_response');
    const warnings: string[] = [];
    const brands = (text(product.brands) ?? '').split(',').map((b) => b.trim()).filter(Boolean);
    if (brands.length > 1) warnings.push('multiple_brands_listed');

    const quantityUnit = metricUnit(product.product_quantity_unit);
    const quantity = providerDecimal(product.product_quantity);
    const pkgText = text(product.quantity);
    const pkg = quantity || pkgText ? { quantity: quantity && quantityUnit ? quantity : null, unit: quantity && quantityUnit ? quantityUnit : null, text: pkgText } : null;

    const servings: CandidateServing[] = [];
    const servingText = text(product.serving_size);
    const servingQuantity = providerDecimal(product.serving_quantity);
    const servingUnit = metricUnit(product.serving_quantity_unit);
    if (servingText || servingQuantity) {
      servings.push({
        external_serving_id: null,
        description: servingText,
        metric_quantity: servingQuantity && servingUnit ? servingQuantity : null,
        metric_unit: servingQuantity && servingUnit ? servingUnit : null,
        number_of_units: null,
        measurement_description: null,
        is_default: null,
      });
      if (servingQuantity && !servingUnit) warnings.push('serving_unit_unresolved');
    }

    const nutriments = isRecord(product.nutriments) ? product.nutriments : {};
    const nutrition: CandidateNutritionBasis[] = [];
    const statedPer = text(product.nutrition_data_per);
    const has = (suffix: string) => Object.keys(nutriments).some((k) => k.endsWith(suffix));
    if (has('_100g')) {
      nutrition.push({ basis: { kind: 'per_100', quantity: '100', unit: quantityUnit }, ...mapNutrients(nutriments, openFoodFactsNutrientRules('_100g')) });
      if (!quantityUnit) warnings.push('nutrition_basis_unit_unresolved');
      if (statedPer === 'serving') warnings.push('per_100_values_derived_by_provider');
    }
    if (has('_serving')) {
      nutrition.push({
        basis: { kind: 'per_serving', external_serving_id: null, metric_quantity: servings[0]?.metric_quantity ?? null, metric_unit: servings[0]?.metric_unit ?? null },
        ...mapNutrients(nutriments, openFoodFactsNutrientRules('_serving')),
      });
      if (statedPer !== 'serving') warnings.push('per_serving_values_derived_by_provider');
    }
    const markets = Array.isArray(product.countries_tags) ? product.countries_tags.filter((t): t is string => typeof t === 'string') : [];

    return buildCandidate({
      provider_key: providerKey,
      external_product_id: code,
      retrieved_at: deps.now().toISOString(),
      barcode: gtin ? { canonical_gtin: gtin, provider_code: code } : null,
      brand_name: brands[0] ?? null,
      product_name: text(product.product_name) ?? text(product.generic_name),
      variant_name: null,
      markets,
      package: pkg,
      servings,
      nutrition,
      ingredients_text: text(product.ingredients_text),
      warnings,
      unresolved_fields: ['variant_name'],
      classification: 'community_product_database',
      provider_record_url: `${OPEN_FOOD_FACTS_HOSTS.production}/product/${code}`,
      policy: OPEN_FOOD_FACTS_STORAGE_POLICY,
      storable: {},
    });
  }

  const adapter: ProductDataAdapter<OpenFoodFactsConfig> = {
    family: 'product_data',
    storagePolicy: OPEN_FOOD_FACTS_STORAGE_POLICY,

    async lookupBarcode(ctx, gtin) {
      const code = openFoodFactsCode(gtin);
      return cached(cache, CandidateCache.key(ctx.provider_key, 'barcode', gtin, ctx.environment), ctx.configuration.cache_ttl_seconds, OPEN_FOOD_FACTS_STORAGE_POLICY, async () => {
        const product = await read(ctx, code);
        return product ? toCandidate(product, code, gtin, ctx.provider_key) : null;
      });
    },

    async fetchNutrition(ctx, externalId) {
      if (!/^[0-9]{8,14}$/.test(externalId)) return null;
      return cached(cache, CandidateCache.key(ctx.provider_key, 'product', externalId, ctx.environment), ctx.configuration.cache_ttl_seconds, OPEN_FOOD_FACTS_STORAGE_POLICY, async () => {
        const product = await read(ctx, externalId);
        return product ? toCandidate(product, externalId, null, ctx.provider_key) : null;
      });
    },
  };

  return {
    provider_key: OPEN_FOOD_FACTS_PROVIDER_KEY,
    capabilities: ['barcode_lookup', 'nutrition_lookup'],
    configSchema: openFoodFactsConfigSchema,
    adapter,
    async testConnection(ctx) {
      await read(ctx, ctx.configuration.health_check_barcode);
    },
  };
}
