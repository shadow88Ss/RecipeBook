// Layer 11C — platform administration of external integrations.
//
// Authorization: Supabase Auth -> Account -> platform_role_assignment ->
// is_platform_admin(). Profile scopes (full_management, view_only,
// pediatric_weight_management) play no part here, and platform_admin
// grants nothing on Profile data (profile_access_scope is unchanged). Every
// query runs as the caller under RLS; the admin tables' policies require
// platform_admin, so this check is the UX layer and RLS is the final word.
//
// Secrets: only references are stored; values are resolved in-process for an
// adapter call and never returned, logged or persisted. Health/test results
// are mapped to the internal failure model — raw provider errors never
// reach a response or a log.

import { AppError } from '../../lib/errors';
import type { ScopedDbClient, ScopedDbFactory } from '../../lib/scopedDb';
import type { AuthContext } from '../../types/express';
import type { AdapterContext, AdapterDefinition, AdapterRegistry } from './adapters';
import {
  credentialRequired,
  FAMILY_CAPABILITIES,
  healthStatusForFailure,
  IntegrationFailure,
  isFamilyCapability,
  toIntegrationFailure,
  type ConnectionModel,
  type CredentialModel,
  type FailureCode,
  type HealthStatus,
  type ProviderEnvironment,
  type ProviderFamily,
} from './integration.model';
import type { ProviderPatchInput, ProviderRegisterInput, RoutingQuery } from './integration.schemas';
import { ProviderRouter } from './routing';
import type { SecretResolver } from './secrets';

export const DEFAULT_TEST_TIMEOUT_MS = 5000;

interface ProviderRow {
  id: string;
  provider_key: string;
  display_name: string;
  provider_family: ProviderFamily;
  connection_model: ConnectionModel;
  credential_model: CredentialModel;
  enabled: boolean;
  environment: ProviderEnvironment;
  configuration: Record<string, unknown>;
  secret_reference: string | null;
  wearable_provider: string | null;
  health_status: HealthStatus;
  health_failure_code: FailureCode | null;
  health_checked_at: string | null;
  last_successful_health_check_at: string | null;
  created_at: string;
  updated_at: string;
}
const PROVIDER_COLUMNS =
  'id, provider_key, display_name, provider_family, connection_model, credential_model, enabled, environment, configuration, secret_reference, ' +
  'wearable_provider, health_status, health_failure_code, health_checked_at, last_successful_health_check_at, created_at, updated_at';

interface CapabilityRow {
  provider_id: string;
  capability: string;
  enabled: boolean;
  priority: number;
}

/** Configuration keys that look like credentials are refused outright, even
 * if an adapter schema were to allow them. */
const SECRET_LIKE_KEY = /(secret|token|password|passwd|api[_-]?key|private[_-]?key|credential|authorization)/i;

function secretLikeKeys(value: unknown, path = ''): string[] {
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
    ...(SECRET_LIKE_KEY.test(k) ? [`${path}${k}`] : []),
    ...secretLikeKeys(v, `${path}${k}.`),
  ]);
}

export interface IntegrationServiceOptions {
  registry: AdapterRegistry;
  secrets: SecretResolver;
  deploymentEnvironment: string;
}

export class IntegrationService {
  private readonly router: ProviderRouter;

  constructor(
    private readonly dbFactory: ScopedDbFactory,
    private readonly options: IntegrationServiceOptions,
  ) {
    this.router = new ProviderRouter(options.registry);
  }

  async list(auth: AuthContext) {
    const db = await this.admin(auth);
    const [providers, capabilities] = await Promise.all([
      db.select<ProviderRow>('external_provider', { columns: PROVIDER_COLUMNS, order: { column: 'provider_key', ascending: true }, limit: 1000 }),
      db.select<CapabilityRow>('external_provider_capability', { columns: 'provider_id, capability, enabled, priority', limit: 10000 }),
    ]);
    return {
      deployment_environment: this.options.deploymentEnvironment,
      items: providers.map((p) => this.dto(p, capabilities.filter((c) => c.provider_id === p.id))),
    };
  }

  async get(auth: AuthContext, key: string) {
    const db = await this.admin(auth);
    const provider = await loadProvider(db, key);
    const capabilities = await loadCapabilities(db, provider.id);
    const counts = provider.wearable_provider
      ? (await db.rpcRows<{ wearable_provider: string; active_connections: number; failing_connections: number }>('external_provider_connection_counts', {})).find(
          (c) => c.wearable_provider === provider.wearable_provider,
        )
      : undefined;
    return {
      ...this.dto(provider, capabilities),
      user_connections: provider.wearable_provider
        ? {
            model: 'wearable_connection' as const,
            wearable_provider: provider.wearable_provider,
            // Aggregates only: no Profile, Account, token or health value.
            active_connections: Number(counts?.active_connections ?? 0),
            failing_connections: Number(counts?.failing_connections ?? 0),
          }
        : null,
    };
  }

  capabilityVocabulary() {
    return { families: FAMILY_CAPABILITIES };
  }

  async capabilities(auth: AuthContext) {
    await this.admin(auth);
    return this.capabilityVocabulary();
  }

  async register(auth: AuthContext, input: ProviderRegisterInput) {
    const db = await this.admin(auth);
    const issues = input.capabilities
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => !isFamilyCapability(input.provider_family, c.capability))
      .map(({ c, i }) => ({ path: `capabilities.${i}.capability`, message: `${c.capability} is not a ${input.provider_family} capability.` }));
    const definition = this.options.registry.get(input.provider_key);
    if (definition && definition.adapter.family !== input.provider_family) {
      issues.push({ path: 'provider_family', message: 'The registered adapter for this provider_key belongs to another family.' });
    }
    if (issues.length) throw AppError.validation('Invalid provider.', { issues });
    const existing = await db.select<{ id: string }>('external_provider', { columns: 'id', eq: { provider_key: input.provider_key }, limit: 1 });
    if (existing.length) throw AppError.conflict('A provider with this provider_key already exists.');
    await callWrite(() => db.rpc('admin_register_external_provider', { p_provider: input }));
    return this.get(auth, input.provider_key);
  }

  async update(auth: AuthContext, key: string, input: ProviderPatchInput) {
    const db = await this.admin(auth);
    const provider = await loadProvider(db, key);
    const current = await loadCapabilities(db, provider.id);
    const definition = this.options.registry.get(provider.provider_key);
    const issues: Array<{ path: string; message: string; reason?: string }> = [];

    let configuration = provider.configuration ?? {};
    if (input.configuration !== undefined) {
      const secretKeys = secretLikeKeys(input.configuration);
      if (secretKeys.length) {
        issues.push({ path: 'configuration', message: `Secrets are not configuration; use secret_reference (${secretKeys.join(', ')}).`, reason: 'secret_in_configuration' });
      } else if (!definition) {
        issues.push({ path: 'configuration', message: 'This provider has no adapter, so no configuration schema to validate against.', reason: 'no_configuration_schema' });
      } else {
        const parsed = definition.configSchema.safeParse(input.configuration);
        if (!parsed.success) {
          for (const issue of parsed.error.issues) issues.push({ path: ['configuration', ...issue.path.map(String)].join('.'), message: issue.message, reason: 'invalid_configuration' });
        } else configuration = parsed.data as Record<string, unknown>;
      }
    }
    if (input.secret_reference !== undefined && input.secret_reference !== null && !credentialRequired(provider.credential_model)) {
      issues.push({ path: 'secret_reference', message: `A ${provider.credential_model} provider takes no platform secret.` });
    }
    for (const [i, c] of (input.capabilities ?? []).entries()) {
      if (!isFamilyCapability(provider.provider_family, c.capability)) {
        issues.push({ path: `capabilities.${i}.capability`, message: `${c.capability} is not a ${provider.provider_family} capability.` });
      } else if (definition && !definition.capabilities.includes(c.capability) && c.enabled !== false) {
        issues.push({ path: `capabilities.${i}.capability`, message: `The ${provider.provider_key} adapter does not support ${c.capability}.`, reason: 'capability_not_supported_by_adapter' });
      }
    }
    if (issues.length) throw AppError.validation('Invalid provider change.', { issues, reason: issues.find((x) => x.reason)?.reason });

    const willBeEnabled = input.enabled ?? provider.enabled;
    if (willBeEnabled) {
      const secretReference = input.secret_reference !== undefined ? input.secret_reference : provider.secret_reference;
      const enabledCapabilities = new Set(current.filter((c) => c.enabled).map((c) => c.capability));
      for (const c of input.capabilities ?? []) {
        if (c.enabled === false) enabledCapabilities.delete(c.capability);
        else enabledCapabilities.add(c.capability);
      }
      const blockers = this.enableBlockers(provider, definition, configuration, secretReference, enabledCapabilities);
      if (blockers.length) throw AppError.conflict('This provider cannot be enabled yet.', { reason: 'provider_not_ready', blockers });
    }

    const change: Record<string, unknown> = {};
    for (const field of ['display_name', 'enabled', 'environment', 'capabilities'] as const) if (input[field] !== undefined) change[field] = input[field];
    if (input.configuration !== undefined) change.configuration = configuration;
    if (input.secret_reference !== undefined) change.secret_reference = input.secret_reference;
    await callWrite(() => db.rpc('admin_update_external_provider', { p_provider_key: provider.provider_key, p_change: change }));
    return this.get(auth, key);
  }

  async health(auth: AuthContext, key: string) {
    const db = await this.admin(auth);
    const provider = await loadProvider(db, key);
    return { provider_key: provider.provider_key, ...this.healthDto(provider) };
  }

  /** Runs the adapter's own probe (if it has one) and records the result. */
  async testConnection(auth: AuthContext, key: string) {
    const db = await this.admin(auth);
    const provider = await loadProvider(db, key);
    const definition = this.options.registry.get(provider.provider_key);
    if (provider.connection_model === 'device_native' || provider.connection_model === 'supabase_auth') {
      throw AppError.conflict('This provider has no server-side connection to test.', { reason: 'no_server_connection' });
    }
    if (!definition || definition.adapter.family !== provider.provider_family) {
      throw AppError.conflict('No adapter is implemented for this provider.', { reason: 'adapter_not_available' });
    }
    if (!definition.testConnection) throw AppError.conflict('This adapter has no connection test.', { reason: 'test_not_supported' });
    if (credentialRequired(provider.credential_model) && !this.credentialConfigured(provider.secret_reference)) {
      throw AppError.conflict('The platform credential is not configured.', { reason: 'credential_not_configured' });
    }
    const parsed = definition.configSchema.safeParse(provider.configuration ?? {});
    if (!parsed.success) throw AppError.conflict('The stored configuration is not valid for this adapter.', { reason: 'invalid_configuration' });

    const ctx = this.context(provider.provider_key, provider.environment, parsed.data, provider.secret_reference);
    let failure: IntegrationFailure | null = null;
    try {
      await withTimeout(definition.testConnection(ctx), ctx.timeoutMs);
    } catch (err) {
      failure = toIntegrationFailure(err);
    }
    const checkedAt = new Date().toISOString();
    const values: Record<string, unknown> = failure
      ? { health_status: healthStatusForFailure(failure.code), health_failure_code: failure.code, health_checked_at: checkedAt }
      : { health_status: 'healthy', health_failure_code: null, health_checked_at: checkedAt, last_successful_health_check_at: checkedAt };
    const updated = await db.update<ProviderRow>('external_provider', { id: provider.id }, values, PROVIDER_COLUMNS);
    if (!updated) throw AppError.forbidden('platform_admin required.');
    return {
      provider_key: provider.provider_key,
      result: failure ? ('failed' as const) : ('succeeded' as const),
      failure: failure ? { code: failure.code, retryable: failure.retryable, retry_after_seconds: failure.retryAfterSeconds } : null,
      ...this.healthDto(updated),
    };
  }

  async audit(auth: AuthContext, key: string) {
    const db = await this.admin(auth);
    const provider = await loadProvider(db, key);
    const events = await db.rpcRows<{ id: string; event_type: string; actor_account_id: string | null; actor_type: string; event_payload: unknown; occurred_at: string }>(
      'external_provider_audit_history',
      { p_provider_id: provider.id },
    );
    return { provider_key: provider.provider_key, items: events };
  }

  /** The routing plan for a capability, as the application would see it. */
  async routing(auth: AuthContext, query: RoutingQuery) {
    const db = await this.admin(auth);
    const plan = await this.router.plan(db, query.family, query.capability);
    return {
      family: plan.family,
      capability: plan.capability,
      capability_defined: isFamilyCapability(query.family, query.capability),
      routes: plan.routes.map((r, position) => (r.kind === 'internal' ? { position, kind: r.kind, key: r.key } : { position, kind: r.kind, provider_key: r.provider_key, priority: r.priority })),
      excluded: plan.excluded,
    };
  }

  // ------------------------------------------------------------------

  private async admin(auth: AuthContext): Promise<ScopedDbClient> {
    const db = this.dbFactory.forUser(auth);
    const isAdmin = await db.rpc<boolean>('is_platform_admin', {});
    if (isAdmin !== true) throw AppError.forbidden('Platform administration requires the platform_admin role.');
    return db;
  }

  private credentialConfigured(reference: string | null): boolean {
    return reference !== null && this.options.secrets.isConfigured(reference);
  }

  private enableBlockers(provider: ProviderRow, definition: AdapterDefinition | undefined, configuration: unknown, secretReference: string | null, capabilities: Set<string>): string[] {
    const blockers: string[] = [];
    if (provider.provider_family === 'identity') blockers.push('identity_managed_by_supabase_auth');
    if (!definition) blockers.push('adapter_not_available');
    else {
      if (definition.adapter.family !== provider.provider_family) blockers.push('adapter_family_mismatch');
      if (!definition.configSchema.safeParse(configuration ?? {}).success) blockers.push('invalid_configuration');
      if (![...capabilities].some((c) => definition.capabilities.includes(c))) blockers.push('no_supported_capability_enabled');
    }
    if (credentialRequired(provider.credential_model) && !this.credentialConfigured(secretReference)) blockers.push('credential_not_configured');
    return blockers;
  }

  private context(providerKey: string, environment: ProviderEnvironment, configuration: unknown, reference: string | null): AdapterContext {
    const configured = configuration as { request_timeout_ms?: unknown };
    const timeoutMs = typeof configured?.request_timeout_ms === 'number' ? Math.min(Math.max(configured.request_timeout_ms, 1), 30_000) : DEFAULT_TEST_TIMEOUT_MS;
    const secrets = this.options.secrets;
    return {
      provider_key: providerKey,
      environment,
      configuration,
      timeoutMs,
      secret: async () => {
        const value = reference ? secrets.resolve(reference) : null;
        if (value === null) throw new IntegrationFailure('authentication_failed');
        return value;
      },
    };
  }

  private healthDto(p: ProviderRow) {
    return {
      enabled: p.enabled,
      credential_configured: credentialRequired(p.credential_model) ? this.credentialConfigured(p.secret_reference) : null,
      health: {
        status: p.health_status,
        failure_code: p.health_failure_code,
        checked_at: p.health_checked_at,
        last_successful_check_at: p.last_successful_health_check_at,
      },
    };
  }

  private dto(p: ProviderRow, capabilities: readonly CapabilityRow[]) {
    const definition = this.options.registry.get(p.provider_key);
    const adapterMatches = !!definition && definition.adapter.family === p.provider_family;
    return {
      provider_key: p.provider_key,
      display_name: p.display_name,
      provider_family: p.provider_family,
      connection_model: p.connection_model,
      credential_model: p.credential_model,
      enabled: p.enabled,
      environment: p.environment,
      deployment_environment: this.options.deploymentEnvironment,
      capabilities: [...capabilities]
        .sort((a, b) => (a.capability < b.capability ? -1 : a.capability > b.capability ? 1 : 0))
        .map((c) => ({
          capability: c.capability,
          enabled: c.enabled,
          priority: Number(c.priority),
          supported_by_adapter: adapterMatches ? (definition as AdapterDefinition).capabilities.includes(c.capability) : false,
        })),
      credential: {
        required: credentialRequired(p.credential_model),
        // The reference NAME only (e.g. env:FATSECRET_CLIENT_SECRET) — never its value.
        secret_reference: p.secret_reference,
        configured: credentialRequired(p.credential_model) ? this.credentialConfigured(p.secret_reference) : null,
      },
      adapter: {
        available: adapterMatches,
        test_connection_supported: adapterMatches && typeof definition?.testConnection === 'function',
      },
      configuration: p.configuration ?? {},
      wearable_provider: p.wearable_provider,
      health: this.healthDto(p).health,
      created_at: p.created_at,
      updated_at: p.updated_at,
    };
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new IntegrationFailure('timeout')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function loadProvider(db: ScopedDbClient, key: string): Promise<ProviderRow> {
  const [row] = await db.select<ProviderRow>('external_provider', { columns: PROVIDER_COLUMNS, eq: { provider_key: key }, limit: 1 });
  if (!row) throw AppError.notFound('Integration not found.');
  return row;
}

async function loadCapabilities(db: ScopedDbClient, providerId: string): Promise<CapabilityRow[]> {
  return db.select<CapabilityRow>('external_provider_capability', { columns: 'provider_id, capability, enabled, priority', eq: { provider_id: providerId }, limit: 1000 });
}

/** Database refusals -> safe API errors (never SQL text). */
async function callWrite<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === 'P0002') throw AppError.notFound('Integration not found.');
    if (code === '23505') throw AppError.conflict('This provider or capability already exists.');
    if (code === '23514' || code === '23503' || code === '22P02' || code === '23502' || code === '55000') {
      throw AppError.validation('The change violates an integration registry rule.');
    }
    if (code === '42501') throw AppError.forbidden('Platform administration requires the platform_admin role.');
    throw err;
  }
}
