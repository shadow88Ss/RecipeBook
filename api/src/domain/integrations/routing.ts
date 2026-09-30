// Layer 11C — capability-based provider routing.
//
// Application code asks "which sources can do <capability> for <family>?",
// never "is FatSecret enabled?". The answer is computed from data and code
// only — no provider name appears here:
//   internal sources (code-registered, e.g. the Layer 11A Product catalog)
//   first, then enabled external providers whose capability row is enabled,
//   ordered by configured priority, then provider_key;
//   an external provider is routable only if an adapter of the SAME family
//   is registered, declares the capability, and its stored configuration
//   passes that adapter's schema.
// Nothing here calls a provider; callers decide the fallback policy.

import type { ScopedDbClient } from '../../lib/scopedDb';
import { AdapterRegistry, type AdapterDefinition } from './adapters';
import { isFamilyCapability, type ProviderEnvironment, type ProviderFamily } from './integration.model';

export interface ExternalRoute {
  kind: 'external';
  provider_key: string;
  priority: number;
  environment: ProviderEnvironment;
  configuration: unknown;
  secret_reference: string | null;
  definition: AdapterDefinition;
}
export type Route = { kind: 'internal'; key: string } | ExternalRoute;

export interface ExcludedRoute {
  provider_key: string;
  reason: 'adapter_not_available' | 'adapter_family_mismatch' | 'capability_not_supported_by_adapter' | 'invalid_configuration';
}

export interface RoutingPlan {
  family: ProviderFamily;
  capability: string;
  routes: Route[];
  excluded: ExcludedRoute[];
}

interface RouteRow {
  provider_key: string;
  priority: number;
  environment: ProviderEnvironment;
  configuration: unknown;
  secret_reference: string | null;
}

export class ProviderRouter {
  constructor(private readonly registry: AdapterRegistry) {}

  /** An unknown family/capability pair routes to nothing (never to another family). */
  async plan(db: ScopedDbClient, family: ProviderFamily, capability: string): Promise<RoutingPlan> {
    if (!isFamilyCapability(family, capability)) return { family, capability, routes: [], excluded: [] };
    const rows = await db.rpcRows<RouteRow>('enabled_provider_routes', { p_family: family, p_capability: capability });
    const routes: Route[] = this.registry.internalSources(family, capability).map((s) => ({ kind: 'internal' as const, key: s.key }));
    const excluded: ExcludedRoute[] = [];
    const ordered = [...rows].sort((a, b) => a.priority - b.priority || (a.provider_key < b.provider_key ? -1 : a.provider_key > b.provider_key ? 1 : 0));
    for (const row of ordered) {
      const definition = this.registry.get(row.provider_key);
      if (!definition) excluded.push({ provider_key: row.provider_key, reason: 'adapter_not_available' });
      else if (definition.adapter.family !== family) excluded.push({ provider_key: row.provider_key, reason: 'adapter_family_mismatch' });
      else if (!definition.capabilities.includes(capability)) excluded.push({ provider_key: row.provider_key, reason: 'capability_not_supported_by_adapter' });
      else if (!definition.configSchema.safeParse(row.configuration ?? {}).success) excluded.push({ provider_key: row.provider_key, reason: 'invalid_configuration' });
      else {
        routes.push({
          kind: 'external',
          provider_key: row.provider_key,
          priority: Number(row.priority),
          environment: row.environment,
          configuration: definition.configSchema.parse(row.configuration ?? {}),
          secret_reference: row.secret_reference,
          definition,
        });
      }
    }
    return { family, capability, routes, excluded };
  }
}
