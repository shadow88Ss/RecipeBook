// Layer 11C — family-specific provider adapter contracts and the adapter
// registry.
//
// There is no universal provider interface. Each family has its own small
// contract whose operations are optional and tied to capabilities: an
// adapter must implement the operation of every capability it declares
// (checked when it is registered), and may declare only capabilities of its
// own family. Operations return provider CANDIDATE data only — nothing here
// writes Food, Product, nutrition, meals, plans, groceries or wearable data;
// turning external data into reference/user data is a later, reviewed
// ingestion step owned by those domains.
//
// Adding a provider = implement one family contract + register it here
// (code), register/configure/enable its ExternalProvider row (platform
// administration). No core domain changes.

import type { z } from 'zod';
import { FAMILY_CAPABILITIES, type FamilyCapability, type ProviderEnvironment, type ProviderFamily } from './integration.model';
import type { ExternalProductCandidate, ProviderStoragePolicy } from './productData';
import { createFatSecretDefinition } from './providers/fatsecret';
import { createOpenFoodFactsDefinition } from './providers/openFoodFacts';

/** What an adapter receives for one call. The secret is resolved lazily,
 * server-side, and must never be logged or returned. */
export interface AdapterContext<C = unknown> {
  provider_key: string;
  environment: ProviderEnvironment;
  configuration: C;
  /** Resolves the platform credential, or one named part of it (e.g.
   * `client_id`), from the adapter's declared references. Throws
   * authentication_failed when it is not configured. */
  secret(part?: string): Promise<string>;
  timeoutMs: number;
  /** Aborted when the call times out; adapters pass it to every request. */
  signal: AbortSignal;
  /** The MyRecipeBook request id, for provider-safe correlation logging. */
  requestId: string | null;
}

// ---------------- product_data ----------------
// Candidates only (Layer 11D, productData.ts): never Product/Food rows.
export interface ProductSearchRequest {
  query: string;
  limit: number;
}
export interface ProductDataAdapter<C = unknown> {
  family: 'product_data';
  /** The provider's storage/caching/attribution boundary. */
  storagePolicy?: ProviderStoragePolicy;
  searchFoods?(ctx: AdapterContext<C>, request: ProductSearchRequest): Promise<ExternalProductCandidate[]>;
  searchProducts?(ctx: AdapterContext<C>, request: ProductSearchRequest): Promise<ExternalProductCandidate[]>;
  /** `gtin` is the canonical GTIN-14 from Layer 11A normalization; null
   * means the provider has no product for it. */
  lookupBarcode?(ctx: AdapterContext<C>, gtin: string): Promise<ExternalProductCandidate | null>;
  /** Full candidate (servings + nutrition) for the provider's own id. */
  fetchNutrition?(ctx: AdapterContext<C>, externalId: string): Promise<ExternalProductCandidate | null>;
}

// ---------------- wearable (user-authorized) ----------------
/** A user's connection is the EXISTING WearableConnection row; the adapter
 * never owns or stores it. User tokens are user-connection secrets. */
export interface WearableConnectionRef {
  wearable_connection_id: string;
  provider_account_reference: string;
}
export interface WearableSyncResult {
  records: number;
  next_cursor: string | null;
}
export interface WearableAdapter<C = unknown> {
  family: 'wearable';
  connect?(ctx: AdapterContext<C>, request: { redirect_uri: string; state: string }): Promise<{ authorization_url: string }>;
  refreshAuthorization?(ctx: AdapterContext<C>, connection: WearableConnectionRef): Promise<void>;
  disconnect?(ctx: AdapterContext<C>, connection: WearableConnectionRef): Promise<void>;
  syncActivity?(ctx: AdapterContext<C>, connection: WearableConnectionRef, cursor: string | null): Promise<WearableSyncResult>;
  syncWorkout?(ctx: AdapterContext<C>, connection: WearableConnectionRef, cursor: string | null): Promise<WearableSyncResult>;
  syncSleep?(ctx: AdapterContext<C>, connection: WearableConnectionRef, cursor: string | null): Promise<WearableSyncResult>;
  syncRecovery?(ctx: AdapterContext<C>, connection: WearableConnectionRef, cursor: string | null): Promise<WearableSyncResult>;
}

// ---------------- commerce ----------------
export interface CommerceItemRef {
  name: string;
  quantity: number | null;
  unit: string | null;
}
export interface CommerceAdapter<C = unknown> {
  family: 'commerce';
  searchProducts?(ctx: AdapterContext<C>, query: string): Promise<Array<{ external_id: string; name: string }>>;
  getPrice?(ctx: AdapterContext<C>, externalId: string): Promise<{ amount: string; currency: string } | null>;
  getAvailability?(ctx: AdapterContext<C>, externalId: string): Promise<{ available: boolean } | null>;
  createShoppingList?(ctx: AdapterContext<C>, items: CommerceItemRef[]): Promise<{ external_list_id: string; url: string | null }>;
  createBasket?(ctx: AdapterContext<C>, items: CommerceItemRef[]): Promise<{ external_basket_id: string }>;
  checkout?(ctx: AdapterContext<C>, externalBasketId: string): Promise<{ checkout_url: string }>;
  getOrderStatus?(ctx: AdapterContext<C>, externalOrderId: string): Promise<{ status: string }>;
}

// ---------------- device_health (on-device) ----------------
/** Apple Health / Health Connect run in the mobile app through the OS
 * framework and its consent screens; the server makes no provider call and
 * holds no credential. The definition describes the native framework and
 * the OS permissions each capability needs. */
export interface DeviceHealthAdapter {
  family: 'device_health';
  execution: 'device_native';
  native_framework: string;
  permissions: Partial<Record<FamilyCapability<'device_health'>, readonly string[]>>;
}

type FamilyAdapter = ProductDataAdapter | WearableAdapter | CommerceAdapter | DeviceHealthAdapter;

/** Operation required for each capability (identity has none: Supabase Auth). */
export const CAPABILITY_OPERATION: { [F in Exclude<ProviderFamily, 'identity' | 'device_health'>]: Record<FamilyCapability<F>, string> } = {
  product_data: { food_search: 'searchFoods', product_search: 'searchProducts', barcode_lookup: 'lookupBarcode', nutrition_lookup: 'fetchNutrition' },
  wearable: { activity_sync: 'syncActivity', workout_sync: 'syncWorkout', sleep_sync: 'syncSleep', recovery_sync: 'syncRecovery' },
  commerce: {
    product_search: 'searchProducts',
    price: 'getPrice',
    availability: 'getAvailability',
    shopping_list: 'createShoppingList',
    basket: 'createBasket',
    checkout: 'checkout',
    order_status: 'getOrderStatus',
  },
};

export interface AdapterDefinition<C = unknown> {
  provider_key: string;
  capabilities: readonly string[];
  /** Strict schema for the provider's NON-SECRET configuration. */
  configSchema: z.ZodType<C>;
  adapter: FamilyAdapter;
  /**
   * Where the platform credential lives, declared by the adapter (deployment
   * configuration, Layer 11D). The registry row's secret_reference must equal
   * `reference`; runtime resolution uses this declaration, so the reference
   * name never has to travel through a database function that ordinary
   * users can call. `parts` names companion values (e.g. an OAuth client id).
   */
  credential?: { reference: string; parts?: Readonly<Record<string, string>> };
  /** Cheap authenticated probe, if the provider has one. */
  testConnection?(ctx: AdapterContext<C>): Promise<void>;
}

/** A source inside MyRecipeBook (e.g. the Layer 11A Product catalog). It is
 * not an ExternalProvider row; the routing policy places internal sources
 * before external providers. */
export interface InternalSource {
  key: string;
  family: ProviderFamily;
  capabilities: readonly string[];
}

export class AdapterRegistry {
  private readonly definitions = new Map<string, AdapterDefinition>();
  private readonly internal: InternalSource[] = [];

  register<C>(definition: AdapterDefinition<C>): this {
    const { provider_key, adapter, capabilities } = definition;
    if (this.definitions.has(provider_key)) throw new Error(`Adapter ${provider_key} is already registered.`);
    const family = adapter.family;
    for (const capability of capabilities) {
      if (!(FAMILY_CAPABILITIES[family] as readonly string[]).includes(capability)) {
        throw new Error(`Adapter ${provider_key} (${family}) cannot declare capability ${capability}.`);
      }
      if (family === 'device_health') {
        if (!(adapter as DeviceHealthAdapter).permissions[capability as FamilyCapability<'device_health'>]) {
          throw new Error(`Device adapter ${provider_key} declares ${capability} without its native permissions.`);
        }
        continue;
      }
      const operation = (CAPABILITY_OPERATION[family] as Record<string, string>)[capability] as string;
      if (typeof (adapter as unknown as Record<string, unknown>)[operation] !== 'function') {
        throw new Error(`Adapter ${provider_key} declares ${capability} but does not implement ${operation}().`);
      }
    }
    this.definitions.set(provider_key, definition as AdapterDefinition);
    return this;
  }

  registerInternal(source: InternalSource): this {
    this.internal.push(source);
    return this;
  }

  get(providerKey: string): AdapterDefinition | undefined {
    return this.definitions.get(providerKey);
  }

  internalSources(family: ProviderFamily, capability: string): InternalSource[] {
    return this.internal.filter((s) => s.family === family && s.capabilities.includes(capability));
  }
}

export interface DefaultRegistryOptions {
  /** HTTP transport for provider calls (tests inject deterministic fixtures). */
  fetch?: typeof fetch;
  now?: () => Date;
}

/** Production registry: the internal Product catalog plus the Layer 11D
 * product-data adapters (FatSecret, Open Food Facts). An adapter being
 * registered makes nothing callable: its registry row must still be
 * configured and enabled by a platform_admin. */
export function createDefaultAdapterRegistry(options: DefaultRegistryOptions = {}): AdapterRegistry {
  const transport = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => new Date());
  return new AdapterRegistry()
    .registerInternal({ key: 'internal_product_catalog', family: 'product_data', capabilities: ['product_search', 'barcode_lookup', 'nutrition_lookup'] })
    .register(createFatSecretDefinition({ fetch: transport, now }))
    .register(createOpenFoodFactsDefinition({ fetch: transport, now }));
}
