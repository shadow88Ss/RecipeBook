// Layer 11D — OPT-IN live smoke tests against the real providers. Skipped
// unless LIVE_PROVIDER_SMOKE=1. FatSecret additionally needs
// FATSECRET_CLIENT_ID / FATSECRET_CLIENT_SECRET (and an allow-listed IP);
// Open Food Facts needs OFF_CONTACT_EMAIL. Never part of the default suite:
// passing the default suite is mock-verified behaviour, not live verification.

import { describe, expect, it } from 'vitest';
import type { AdapterDefinition, ProductDataAdapter } from '../../src/domain/integrations/adapters';
import { createAdapterContext } from '../../src/domain/integrations/execution';
import { createFatSecretDefinition } from '../../src/domain/integrations/providers/fatsecret';
import { createOpenFoodFactsDefinition } from '../../src/domain/integrations/providers/openFoodFacts';
import { EnvSecretResolver } from '../../src/domain/integrations/secrets';

const live = process.env.LIVE_PROVIDER_SMOKE === '1';
const deps = { fetch: (input: string | URL | Request, init?: RequestInit) => fetch(input, init), now: () => new Date() };

function ctx(def: AdapterDefinition, config: Record<string, unknown>) {
  return createAdapterContext({
    definition: def,
    providerKey: def.provider_key,
    environment: 'production',
    configuration: def.configSchema.parse(config),
    credentialAttached: true,
    secrets: new EnvSecretResolver(),
    signal: AbortSignal.timeout(10_000),
    requestId: 'live-smoke',
  });
}

describe.skipIf(!live || !process.env.OFF_CONTACT_EMAIL)('live: Open Food Facts', () => {
  it('reads one known product into a candidate', async () => {
    const def = createOpenFoodFactsDefinition(deps);
    const c = await (def.adapter as ProductDataAdapter).lookupBarcode?.(ctx(def, { contact_email: process.env.OFF_CONTACT_EMAIL, cache_ttl_seconds: 0 }), '03017624010701');
    expect(c).toMatchObject({ provider_key: 'open_food_facts', external_product_id: '3017624010701', status: 'unconfirmed_external_candidate' });
  });
});

describe.skipIf(!live || !process.env.FATSECRET_CLIENT_ID)('live: FatSecret', () => {
  it('obtains a token and runs the connection test and a search', async () => {
    const def = createFatSecretDefinition(deps) as AdapterDefinition;
    await def.testConnection?.(ctx(def, { cache_ttl_seconds: 0 }));
    const items = await (def.adapter as ProductDataAdapter).searchProducts?.(ctx(def, { cache_ttl_seconds: 0 }), { query: 'apple', limit: 3 });
    expect(items?.length).toBeGreaterThan(0);
  });
});
