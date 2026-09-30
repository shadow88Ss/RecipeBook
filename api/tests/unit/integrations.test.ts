// Layer 11C — adapter registry rules, failure/retry model, secret
// references and capability routing (pure; fake adapters, fake database).

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AdapterRegistry, createDefaultAdapterRegistry } from '../../src/domain/integrations/adapters';
import {
  credentialRequired,
  FAILURE_CODES,
  healthStatusForFailure,
  IntegrationFailure,
  isFamilyCapability,
  RETRY_POLICY,
  toIntegrationFailure,
} from '../../src/domain/integrations/integration.model';
import { ProviderRouter } from '../../src/domain/integrations/routing';
import { EnvSecretResolver } from '../../src/domain/integrations/secrets';
import type { ScopedDbClient } from '../../src/lib/scopedDb';

const cfg = z.strictObject({});

describe('adapter registry', () => {
  it('an adapter must implement the operation of every capability it declares', () => {
    expect(() =>
      new AdapterRegistry().register({ provider_key: 'p', capabilities: ['barcode_lookup'], configSchema: cfg, adapter: { family: 'product_data', searchProducts: async () => [] } }),
    ).toThrow(/does not implement lookupBarcode/);
  });

  it('an adapter cannot declare a capability of another family', () => {
    expect(() =>
      new AdapterRegistry().register({ provider_key: 'shop', capabilities: ['barcode_lookup'], configSchema: cfg, adapter: { family: 'commerce', searchProducts: async () => [] } }),
    ).toThrow(/cannot declare capability barcode_lookup/);
    expect(() =>
      new AdapterRegistry().register({ provider_key: 'band', capabilities: ['product_search'], configSchema: cfg, adapter: { family: 'wearable', syncActivity: async () => ({ records: 0, next_cursor: null }) } }),
    ).toThrow(/cannot declare/);
  });

  it('device-native adapters declare OS permissions, not server operations', () => {
    expect(() =>
      new AdapterRegistry().register({ provider_key: 'd', capabilities: ['sleep_read'], configSchema: cfg, adapter: { family: 'device_health', execution: 'device_native', native_framework: 'x', permissions: {} } }),
    ).toThrow(/without its native permissions/);
  });

  it('a provider_key registers once', () => {
    const r = new AdapterRegistry().register({ provider_key: 'p', capabilities: [], configSchema: cfg, adapter: { family: 'product_data' } });
    expect(() => r.register({ provider_key: 'p', capabilities: [], configSchema: cfg, adapter: { family: 'product_data' } })).toThrow(/already registered/);
  });

  it('the production registry has no external adapter, only the internal Product catalog', () => {
    const r = createDefaultAdapterRegistry();
    for (const key of ['fatsecret', 'open_food_facts', 'usda', 'whoop', 'apple_health', 'health_connect', 'instacart']) expect(r.get(key)).toBeUndefined();
    expect(r.internalSources('product_data', 'barcode_lookup').map((s) => s.key)).toEqual(['internal_product_catalog']);
    expect(r.internalSources('commerce', 'product_search')).toEqual([]);
  });
});

describe('failure and retry model', () => {
  it('never retries authentication failures, invalid responses or unsupported capabilities', () => {
    expect(RETRY_POLICY.authentication_failed.retryable).toBe(false);
    expect(RETRY_POLICY.invalid_provider_response.retryable).toBe(false);
    expect(RETRY_POLICY.capability_not_supported.retryable).toBe(false);
    expect(RETRY_POLICY.rate_limited.retryable).toBe(true);
    expect(RETRY_POLICY.timeout.retryable).toBe(true);
    expect(Object.keys(RETRY_POLICY).sort()).toEqual([...FAILURE_CODES].sort());
  });

  it('maps unknown errors to provider_unavailable and drops their message', () => {
    const mapped = toIntegrationFailure(new Error('HTTP 500 body={"key":"sk_live_x"}'));
    expect(mapped.code).toBe('provider_unavailable');
    expect(mapped.message).not.toContain('sk_live_x');
    const known = new IntegrationFailure('rate_limited', { retryAfterSeconds: 10 });
    expect(toIntegrationFailure(known)).toBe(known);
  });

  it('maps failures to health states', () => {
    expect(healthStatusForFailure('authentication_failed')).toBe('authentication_failed');
    expect(healthStatusForFailure('rate_limited')).toBe('rate_limited');
    expect(healthStatusForFailure('timeout')).toBe('unavailable');
    expect(healthStatusForFailure('provider_unavailable')).toBe('unavailable');
    expect(healthStatusForFailure('invalid_provider_response')).toBe('degraded');
  });

  it('credential requirement by model', () => {
    expect(credentialRequired('api_key')).toBe(true);
    expect(credentialRequired('oauth_client')).toBe(true);
    expect(credentialRequired('service_account')).toBe(true);
    expect(credentialRequired('none')).toBe(false);
    expect(credentialRequired('device_native')).toBe(false);
    expect(isFamilyCapability('commerce', 'barcode_lookup')).toBe(false);
    expect(isFamilyCapability('commerce', 'product_search')).toBe(true);
  });
});

describe('secret references', () => {
  it('resolves only env: references to non-empty values', () => {
    const r = new EnvSecretResolver({ GOOD: 'value', EMPTY: '' });
    expect(r.resolve('env:GOOD')).toBe('value');
    expect(r.isConfigured('env:EMPTY')).toBe(false);
    expect(r.isConfigured('env:MISSING')).toBe(false);
    expect(r.resolve('GOOD')).toBeNull();
    expect(r.resolve('vault:GOOD')).toBeNull();
  });
});

describe('capability routing (no provider names in the router)', () => {
  const db = (rows: Array<{ provider_key: string; priority: number }>): ScopedDbClient =>
    ({
      rpcRows: async (fn: string, args: { p_family: string; p_capability: string }) => {
        expect(fn).toBe('enabled_provider_routes');
        return rows.map((r) => ({ ...r, environment: 'sandbox', configuration: {}, secret_reference: null, family: args.p_family }));
      },
    }) as unknown as ScopedDbClient;
  const adapter = { family: 'product_data' as const, lookupBarcode: async () => null };
  const registry = () =>
    createDefaultAdapterRegistry()
      .register({ provider_key: 'zeta', capabilities: ['barcode_lookup'], configSchema: cfg, adapter })
      .register({ provider_key: 'alpha', capabilities: ['barcode_lookup'], configSchema: cfg, adapter })
      .register({ provider_key: 'shop', capabilities: ['product_search'], configSchema: cfg, adapter: { family: 'commerce', searchProducts: async () => [] } });

  it('orders by priority then key, internal sources first', async () => {
    const plan = await new ProviderRouter(registry()).plan(db([{ provider_key: 'zeta', priority: 1 }, { provider_key: 'alpha', priority: 1 }]), 'product_data', 'barcode_lookup');
    expect(plan.routes.map((r) => (r.kind === 'internal' ? r.key : r.provider_key))).toEqual(['internal_product_catalog', 'alpha', 'zeta']);
  });

  it('excludes a row whose adapter is missing, of another family, or lacks the capability', async () => {
    const plan = await new ProviderRouter(registry()).plan(
      db([
        { provider_key: 'ghost', priority: 1 },
        { provider_key: 'shop', priority: 2 },
      ]),
      'product_data',
      'barcode_lookup',
    );
    expect(plan.excluded).toEqual([
      { provider_key: 'ghost', reason: 'adapter_not_available' },
      { provider_key: 'shop', reason: 'adapter_family_mismatch' },
    ]);
    expect(plan.routes.filter((r) => r.kind === 'external')).toEqual([]);
  });

  it('an undefined family/capability pair never queries or routes', async () => {
    const never = { rpcRows: async () => { throw new Error('should not query'); } } as unknown as ScopedDbClient;
    expect((await new ProviderRouter(registry()).plan(never, 'commerce', 'barcode_lookup')).routes).toEqual([]);
  });
});
