// Layer 11C — integration vocabulary, failure model and retry policy.
//
// Mirrors the database enums and provider_capability_definition in
// migration 20261012120000 (a test keeps them identical). Capabilities are
// scoped by FAMILY: `product_search` of a commerce provider is a different
// capability from `product_search` of a product-data provider, and a
// capability of one family can never be registered for, or routed to, a
// provider of another family.

export const PROVIDER_FAMILIES = ['product_data', 'wearable', 'device_health', 'commerce', 'identity'] as const;
export type ProviderFamily = (typeof PROVIDER_FAMILIES)[number];

export const FAMILY_CAPABILITIES = {
  product_data: ['food_search', 'product_search', 'barcode_lookup', 'nutrition_lookup'],
  wearable: ['activity_sync', 'workout_sync', 'sleep_sync', 'recovery_sync'],
  device_health: ['activity_read', 'workout_read', 'sleep_read', 'health_metrics_read'],
  commerce: ['product_search', 'price', 'availability', 'shopping_list', 'basket', 'checkout', 'order_status'],
  identity: ['authentication'],
} as const satisfies Record<ProviderFamily, readonly string[]>;
export type FamilyCapability<F extends ProviderFamily> = (typeof FAMILY_CAPABILITIES)[F][number];

export function isFamilyCapability(family: ProviderFamily, capability: string): boolean {
  return (FAMILY_CAPABILITIES[family] as readonly string[]).includes(capability);
}

/** How an integration is used (not how it authenticates). */
export const CONNECTION_MODELS = ['platform', 'user_authorized', 'device_native', 'supabase_auth'] as const;
export type ConnectionModel = (typeof CONNECTION_MODELS)[number];

/** The PLATFORM credential. User OAuth tokens (the conceptual `oauth_user`
 * model) belong to the user's own connection, never to the provider row. */
export const CREDENTIAL_MODELS = ['none', 'api_key', 'oauth_client', 'service_account', 'device_native'] as const;
export type CredentialModel = (typeof CREDENTIAL_MODELS)[number];

/** Credential models that need a server-side secret reference to work. */
export function credentialRequired(model: CredentialModel): boolean {
  return model === 'api_key' || model === 'oauth_client' || model === 'service_account';
}

export const PROVIDER_ENVIRONMENTS = ['sandbox', 'production'] as const;
export type ProviderEnvironment = (typeof PROVIDER_ENVIRONMENTS)[number];

export const HEALTH_STATUSES = ['unknown', 'healthy', 'degraded', 'unavailable', 'authentication_failed', 'rate_limited'] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export const FAILURE_CODES = [
  'authentication_failed',
  'rate_limited',
  'timeout',
  'provider_unavailable',
  'invalid_provider_response',
  'capability_not_supported',
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

/**
 * Retry policy by failure code. Authentication failures and unsupported
 * capabilities are never retried as if temporary; rate limits and timeouts
 * may be retried (with a provider-specific delay, e.g. Retry-After); an
 * unavailable provider may be retried later; an invalid response is a
 * contract problem, not a transient one. There is no automatic retry loop
 * in this layer — callers read `retryable`.
 */
export const RETRY_POLICY: Record<FailureCode, { retryable: boolean }> = {
  authentication_failed: { retryable: false },
  rate_limited: { retryable: true },
  timeout: { retryable: true },
  provider_unavailable: { retryable: true },
  invalid_provider_response: { retryable: false },
  capability_not_supported: { retryable: false },
};

/** The one error shape adapters may surface. The message is ours and safe;
 * provider payloads, raw exceptions and secrets are never carried. */
export class IntegrationFailure extends Error {
  readonly code: FailureCode;
  readonly retryable: boolean;
  /** Provider-advised delay for a retryable failure, when known. */
  readonly retryAfterSeconds: number | null;

  constructor(code: FailureCode, options: { retryAfterSeconds?: number } = {}) {
    super(`integration failure: ${code}`);
    this.name = 'IntegrationFailure';
    this.code = code;
    this.retryable = RETRY_POLICY[code].retryable;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

/** Maps anything an adapter throws into the internal failure model. An
 * unrecognized error is `provider_unavailable`; its message is dropped. */
export function toIntegrationFailure(err: unknown): IntegrationFailure {
  return err instanceof IntegrationFailure ? err : new IntegrationFailure('provider_unavailable');
}

/** Health state recorded after a failed check. */
export function healthStatusForFailure(code: FailureCode): Exclude<HealthStatus, 'unknown' | 'healthy'> {
  switch (code) {
    case 'authentication_failed':
      return 'authentication_failed';
    case 'rate_limited':
      return 'rate_limited';
    case 'invalid_provider_response':
    case 'capability_not_supported':
      return 'degraded';
    default:
      return 'unavailable';
  }
}
