// Layer 11D — the provider-neutral ExternalProductCandidate contract and the
// shared normalization rules every product_data adapter uses.
//
// A candidate is what an external product-data provider said about a product
// at `retrieved_at`. It is NOT a Product, ProductLabelVersion, ProductNutrient,
// ProductServing or Barcode, it is never written to those tables, and it can
// never be logged as a meal item (Layer 11B requires a canonical Product). A
// future, explicit confirmation/ingestion workflow decides whether a
// candidate becomes canonical reference data.
//
// Nutrient mapping (Layer 5C): a provider field maps to a canonical key only
// through an adapter's explicit field table whose semantics were checked
// against the key's definition — never by label/name matching. Everything
// else is kept as `unmapped` with a reason. Energy is taken only as the
// provider's stated kcal (no 4/4/9 and no kJ conversion). A value the
// provider states as 0 is a known zero; a field the provider omits is
// missing — never zero.

import { mul, parseDecimal, toDecimalString } from '../conversion/decimal';
import { convertNutrientAmount } from '../nutrition/nutrientUnits';
import { CANONICAL_NUTRIENT_BY_KEY } from '../nutrition/vocabulary';

export const CANDIDATE_CONTRACT_VERSION = 'external-product-candidate-11d.1';

/** The only nutrients whose absence makes a candidate's nutrition partial. */
export const CORE_NUTRIENT_KEYS = ['energy', 'protein', 'carbohydrate', 'fat'] as const;

export type ProviderClassification = 'commercial_nutrition_database' | 'community_product_database';

/** Per-provider storage/caching boundary (from the provider's own terms). */
export interface ProviderStoragePolicy {
  /** Terms reference the policy was taken from. */
  terms_reference: string;
  /** Candidate fields the provider allows to be kept indefinitely. */
  indefinitely_storable: readonly string[];
  /** Longest time any other returned data may be kept (temporary cache). */
  temporary_cache_max_seconds: number;
  /** Raw provider payloads are never retained. */
  raw_response_retention: 'none';
  /** Whether returned data may be persisted into MyRecipeBook at all in this
   * layer. Nothing is persisted in 11D; a future ingestion layer decides. */
  persistence: 'identifiers_only_after_ingestion_approval' | 'pending_licence_decision';
  attribution: { required: boolean; text: string | null; link: string | null; licence: string | null };
}

export interface CandidateServing {
  external_serving_id: string | null;
  description: string | null;
  /** Metric size of one serving as the provider states it. */
  metric_quantity: string | null;
  metric_unit: 'g' | 'ml' | null;
  number_of_units: string | null;
  measurement_description: string | null;
  is_default: boolean | null;
}

export interface MappedNutrient {
  nutrient_key: string;
  amount: string;
  unit: string;
  status: 'reported' | 'known_zero';
  provider_field: string;
  provider_amount: string;
  provider_unit: string;
}

export type UnmappedReason =
  | 'no_canonical_key'
  | 'unit_unverified'
  | 'kj_only_no_approved_conversion'
  | 'carbohydrate_definition_unverified'
  | 'may_be_derived_from_salt'
  | 'measure_requires_mapping_review'
  | 'invalid_value';

export interface UnmappedNutrient {
  provider_field: string;
  amount: string | null;
  unit: string | null;
  reason: UnmappedReason;
}

export interface CandidateNutritionBasis {
  basis:
    | { kind: 'per_serving'; external_serving_id: string | null; metric_quantity: string | null; metric_unit: 'g' | 'ml' | null }
    | { kind: 'per_100'; quantity: '100'; unit: 'g' | 'ml' | null };
  nutrients: MappedNutrient[];
  unmapped: UnmappedNutrient[];
  /** Core canonical nutrients the provider did not state (missing, NOT zero). */
  missing_core: string[];
}

export type NutrientMappingStatus = 'core_complete' | 'partial' | 'none' | 'not_retrieved';

export interface ExternalProductCandidate {
  contract_version: typeof CANDIDATE_CONTRACT_VERSION;
  status: 'unconfirmed_external_candidate';
  /** Never loggable: meal logging requires a canonical Product. */
  loggable: false;
  provider_key: string;
  external_product_id: string;
  retrieved_at: string;
  barcode: {
    canonical_gtin: string;
    /** The code in the form the provider was asked / answered with. */
    provider_code: string | null;
  } | null;
  brand_name: string | null;
  /** As the provider states it; null when it states none (never invented). */
  product_name: string | null;
  variant_name: string | null;
  /** Markets/regions the provider associates with the product, as stated. */
  markets: string[];
  package: { quantity: string | null; unit: string | null; text: string | null } | null;
  servings: CandidateServing[];
  nutrition: CandidateNutritionBasis[];
  nutrient_mapping_status: NutrientMappingStatus;
  ingredients_text: string | null;
  provenance: {
    source_type: 'external_provider';
    provider_key: string;
    provider_classification: ProviderClassification;
    /** Distinct from ProductLabelVersion's manufacturer_label authority. */
    authority: 'external_candidate';
    provider_record_url: string | null;
    attribution: ProviderStoragePolicy['attribution'];
  };
  completeness: {
    identity: boolean;
    barcode: boolean;
    package: boolean;
    servings: boolean;
    nutrition: NutrientMappingStatus;
    ingredients: boolean;
  };
  warnings: string[];
  unresolved_fields: string[];
  storage: {
    indefinitely_storable: Record<string, string | string[]>;
    temporary_cache_max_seconds: number;
    raw_response_retained: false;
    persisted: false;
  };
  /** Whether this answer came from the in-memory temporary cache. */
  freshness: { served_from_cache: boolean; cache_expires_at: string | null };
}

/** One adapter field-table entry: provider field -> canonical key. */
export interface NutrientFieldRule {
  field: string;
  /** Unit the provider documents for this field. */
  unit: string;
  nutrient_key?: string;
  /** Set when the field must stay unmapped, with why. */
  unmapped_reason?: UnmappedReason;
}

/** Provider numbers arrive as strings or numbers; anything else (negative,
 * NaN, text) is not a value. */
export function providerDecimal(raw: unknown): string | null {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? String(raw) : null;
  if (typeof raw === 'string' && /^\s*[0-9]+(\.[0-9]+)?\s*$/.test(raw)) return raw.trim();
  return null;
}

function normalizedDecimal(text: string): string {
  return toDecimalString(parseDecimal(text));
}

/** Applies an adapter's explicit field table to one nutrition basis. Fields
 * absent from `values` are missing, never zero. */
export function mapNutrients(values: Record<string, unknown>, rules: readonly NutrientFieldRule[]): Pick<CandidateNutritionBasis, 'nutrients' | 'unmapped' | 'missing_core'> {
  const nutrients: MappedNutrient[] = [];
  const unmapped: UnmappedNutrient[] = [];
  for (const rule of rules) {
    if (!(rule.field in values) || values[rule.field] === null || values[rule.field] === '') continue;
    const amount = providerDecimal(values[rule.field]);
    if (amount === null) {
      unmapped.push({ provider_field: rule.field, amount: null, unit: rule.unit, reason: 'invalid_value' });
      continue;
    }
    const canonical = rule.nutrient_key ? CANONICAL_NUTRIENT_BY_KEY.get(rule.nutrient_key) : undefined;
    if (!canonical || rule.unmapped_reason) {
      unmapped.push({ provider_field: rule.field, amount: normalizedDecimal(amount), unit: rule.unit, reason: rule.unmapped_reason ?? 'no_canonical_key' });
      continue;
    }
    const converted = convertNutrientAmount(parseDecimal(amount), rule.unit, canonical.unit);
    if (!converted) {
      unmapped.push({ provider_field: rule.field, amount: normalizedDecimal(amount), unit: rule.unit, reason: rule.unit.toLowerCase() === 'kj' ? 'kj_only_no_approved_conversion' : 'unit_unverified' });
      continue;
    }
    const canonicalAmount = toDecimalString(converted);
    nutrients.push({
      nutrient_key: canonical.key,
      amount: canonicalAmount,
      unit: canonical.unit,
      status: converted.n === 0n ? 'known_zero' : 'reported',
      provider_field: rule.field,
      provider_amount: normalizedDecimal(amount),
      provider_unit: rule.unit,
    });
  }
  const present = new Set(nutrients.map((n) => n.nutrient_key));
  return { nutrients, unmapped, missing_core: CORE_NUTRIENT_KEYS.filter((k) => !present.has(k)) };
}

export function mappingStatus(bases: readonly CandidateNutritionBasis[]): NutrientMappingStatus {
  if (!bases.length) return 'not_retrieved';
  if (bases.some((b) => b.missing_core.length === 0)) return 'core_complete';
  return bases.some((b) => b.nutrients.length > 0) ? 'partial' : 'none';
}

/** Multiplies a provider decimal by a power of ten (g -> mg etc.) exactly. */
export function scaleDecimal(text: string, factor: string): string {
  return toDecimalString(mul(parseDecimal(text), parseDecimal(factor)));
}

export function buildCandidate(
  input: Omit<ExternalProductCandidate, 'contract_version' | 'status' | 'loggable' | 'nutrient_mapping_status' | 'completeness' | 'provenance' | 'storage' | 'freshness'> & {
    classification: ProviderClassification;
    provider_record_url: string | null;
    policy: ProviderStoragePolicy;
    storable: Record<string, string | string[]>;
  },
): ExternalProductCandidate {
  const { classification, provider_record_url, policy, storable, ...candidate } = input;
  const status = mappingStatus(candidate.nutrition);
  const unresolved = [...candidate.unresolved_fields];
  if (!candidate.product_name) unresolved.push('product_name');
  if (!candidate.brand_name) unresolved.push('brand_name');
  if (!candidate.package) unresolved.push('package');
  if (!candidate.servings.length) unresolved.push('servings');
  if (status !== 'core_complete') unresolved.push('nutrition');
  return {
    contract_version: CANDIDATE_CONTRACT_VERSION,
    status: 'unconfirmed_external_candidate',
    loggable: false,
    ...candidate,
    nutrient_mapping_status: status,
    provenance: {
      source_type: 'external_provider',
      provider_key: candidate.provider_key,
      provider_classification: classification,
      authority: 'external_candidate',
      provider_record_url,
      attribution: policy.attribution,
    },
    completeness: {
      identity: !!candidate.product_name,
      barcode: !!candidate.barcode,
      package: !!candidate.package,
      servings: candidate.servings.length > 0,
      nutrition: status,
      ingredients: !!candidate.ingredients_text,
    },
    unresolved_fields: [...new Set(unresolved)],
    storage: {
      indefinitely_storable: storable,
      temporary_cache_max_seconds: policy.temporary_cache_max_seconds,
      raw_response_retained: false,
      persisted: false,
    },
    freshness: { served_from_cache: false, cache_expires_at: null },
  };
}

/** Fields compared across providers. Disagreement is reported, never
 * resolved: candidates are not merged or averaged. */
export function providerDisagreements(candidates: readonly ExternalProductCandidate[]): Array<{ field: string; values: Array<{ provider_key: string; value: unknown }> }> {
  if (candidates.length < 2) return [];
  const firstBasis = (c: ExternalProductCandidate, kind: 'per_100' | 'per_serving') => c.nutrition.find((b) => b.basis.kind === kind);
  const fields: Array<[string, (c: ExternalProductCandidate) => unknown]> = [
    ['brand_name', (c) => c.brand_name?.toLowerCase() ?? null],
    ['product_name', (c) => c.product_name?.toLowerCase() ?? null],
    ['package', (c) => (c.package ? `${c.package.quantity ?? ''} ${c.package.unit ?? ''}`.trim() || c.package.text : null)],
    ['serving', (c) => (c.servings[0] ? `${c.servings[0].metric_quantity ?? ''} ${c.servings[0].metric_unit ?? ''}`.trim() : null)],
  ];
  for (const key of CORE_NUTRIENT_KEYS) {
    fields.push([
      `nutrition.per_100.${key}`,
      (c) => firstBasis(c, 'per_100')?.nutrients.find((n) => n.nutrient_key === key)?.amount ?? null,
    ]);
  }
  const out: Array<{ field: string; values: Array<{ provider_key: string; value: unknown }> }> = [];
  for (const [field, read] of fields) {
    const values = candidates.map((c) => ({ provider_key: c.provider_key, value: read(c) }));
    const known = values.filter((v) => v.value !== null && v.value !== undefined && v.value !== '');
    if (known.length >= 2 && new Set(known.map((v) => String(v.value))).size > 1) out.push({ field, values });
  }
  return out;
}
