// Layer 11D — invoking routed providers: adapter context, bounded timeout,
// bounded retry, per-provider cooldown, safe logging and the aggregate
// outcome. Provider order comes only from the routing plan (configured
// priority); nothing here names a provider.
//
// Fallback policy (deterministic, sequential — never a parallel fan-out):
//   found                      -> stop (mode 'first') or continue ('all')
//   not_found                  -> next provider
//   timeout/provider_unavailable -> retried at most `max_retries` (0..1)
//                                   times, then next provider
//   rate_limited               -> never retried now; provider cools down for
//                                   Retry-After (default 60 s); next provider
//   authentication_failed /
//   capability_not_supported   -> provider cools down 5 min; next provider
//   invalid_provider_response  -> the answer is discarded; next provider
// Cooldowns are per API process (ordinary users cannot write provider
// health; the admin test-connection records it).

import type { Logger } from '../../lib/logger';
import type { AdapterContext, AdapterDefinition } from './adapters';
import { IntegrationFailure, toIntegrationFailure, type FailureCode, type ProviderEnvironment } from './integration.model';
import { CANDIDATE_CONTRACT_VERSION, type ExternalProductCandidate } from './productData';
import type { ExternalRoute, RoutingPlan } from './routing';
import type { SecretResolver } from './secrets';

export const DEFAULT_CALL_TIMEOUT_MS = 5000;
export const MAX_CALL_TIMEOUT_MS = 30_000;
const COOLDOWN_SECONDS: Partial<Record<FailureCode, number>> = { authentication_failed: 300, capability_not_supported: 300, rate_limited: 60 };

/** References the adapter declares, resolved only when the row says a
 * credential is attached. */
export function credentialConfigured(definition: AdapterDefinition | undefined, attached: boolean, secrets: SecretResolver): boolean {
  const credential = definition?.credential;
  if (!attached || !credential) return false;
  return secrets.isConfigured(credential.reference) && Object.values(credential.parts ?? {}).every((ref) => secrets.isConfigured(ref));
}

export function createAdapterContext(args: {
  definition: AdapterDefinition;
  providerKey: string;
  environment: ProviderEnvironment;
  configuration: unknown;
  credentialAttached: boolean;
  secrets: SecretResolver;
  signal: AbortSignal;
  requestId: string | null;
}): AdapterContext {
  const configured = args.configuration as { request_timeout_ms?: unknown };
  const timeoutMs = typeof configured?.request_timeout_ms === 'number' ? Math.min(Math.max(configured.request_timeout_ms, 1), MAX_CALL_TIMEOUT_MS) : DEFAULT_CALL_TIMEOUT_MS;
  return {
    provider_key: args.providerKey,
    environment: args.environment,
    configuration: args.configuration,
    timeoutMs,
    signal: args.signal,
    requestId: args.requestId,
    secret: async (part?: string) => {
      const credential = args.definition.credential;
      const reference = !args.credentialAttached || !credential ? null : part === undefined ? credential.reference : credential.parts?.[part] ?? null;
      const value = reference ? args.secrets.resolve(reference) : null;
      if (value === null) throw new IntegrationFailure('authentication_failed');
      return value;
    },
  };
}

/** Runs `call` with a hard timeout; the context's signal is aborted when it
 * fires so the adapter's HTTP request is cancelled too. */
export async function callWithTimeout<T>(ctxFactory: (signal: AbortSignal) => AdapterContext, call: (ctx: AdapterContext) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const ctx = ctxFactory(controller.signal);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      call(ctx),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new IntegrationFailure('timeout'));
        }, ctx.timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type AttemptOutcome = 'found' | 'not_found' | FailureCode;
export interface ProviderAttempt {
  provider_key: string;
  outcome: AttemptOutcome;
  retries: number;
  skipped_for_cooldown: boolean;
  duration_ms: number;
}
export type AggregateStatus = 'found' | 'not_found' | 'unavailable' | 'no_provider';
export interface ExecutionResult<T> {
  results: Array<{ provider_key: string; value: T }>;
  attempts: ProviderAttempt[];
  status: AggregateStatus;
}

export class ProviderExecutor {
  private readonly cooldownUntil = new Map<string, number>();

  constructor(
    private readonly secrets: SecretResolver,
    private readonly logger: Logger | undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async run<T>(
    plan: RoutingPlan,
    call: (definition: AdapterDefinition, ctx: AdapterContext) => Promise<T | null>,
    options: { mode: 'first' | 'all'; requestId: string | null; isEmpty?: (value: T) => boolean; validate?: (value: T, route: ExternalRoute) => boolean },
  ): Promise<ExecutionResult<T>> {
    const routes = plan.routes.filter((r): r is ExternalRoute => r.kind === 'external');
    const results: ExecutionResult<T>['results'] = [];
    const attempts: ProviderAttempt[] = [];
    for (const route of routes) {
      const started = this.now().getTime();
      const cooling = this.cooldownUntil.get(route.provider_key);
      if (cooling !== undefined && cooling > started) {
        attempts.push({ provider_key: route.provider_key, outcome: 'provider_unavailable', retries: 0, skipped_for_cooldown: true, duration_ms: 0 });
        this.log(plan, route.provider_key, 'skipped_for_cooldown', 0, 0, options.requestId);
        continue;
      }
      const maxRetries = retriesFor(route.configuration);
      let retries = 0;
      let outcome: AttemptOutcome;
      for (;;) {
        try {
          const value = await callWithTimeout(
            (signal) =>
              createAdapterContext({
                definition: route.definition,
                providerKey: route.provider_key,
                environment: route.environment,
                configuration: route.configuration,
                credentialAttached: route.credential_attached,
                secrets: this.secrets,
                signal,
                requestId: options.requestId,
              }),
            (ctx) => call(route.definition, ctx),
          );
          if (value === null || (options.isEmpty && options.isEmpty(value))) outcome = 'not_found';
          else if (options.validate && !options.validate(value, route)) outcome = 'invalid_provider_response';
          else {
            outcome = 'found';
            results.push({ provider_key: route.provider_key, value });
          }
        } catch (err) {
          const failure = toIntegrationFailure(err);
          outcome = failure.code;
          if (failure.retryable && failure.code !== 'rate_limited' && retries < maxRetries) {
            retries += 1;
            continue;
          }
          const cooldown = failure.code === 'rate_limited' ? (failure.retryAfterSeconds ?? COOLDOWN_SECONDS.rate_limited) : COOLDOWN_SECONDS[failure.code];
          if (cooldown) this.cooldownUntil.set(route.provider_key, this.now().getTime() + (cooldown as number) * 1000);
        }
        break;
      }
      const duration = this.now().getTime() - started;
      attempts.push({ provider_key: route.provider_key, outcome, retries, skipped_for_cooldown: false, duration_ms: duration });
      this.log(plan, route.provider_key, outcome, duration, retries, options.requestId);
      if (outcome === 'found' && options.mode === 'first') break;
    }
    const status: AggregateStatus = results.length
      ? 'found'
      : !routes.length
        ? 'no_provider'
        : attempts.every((a) => a.outcome === 'not_found')
          ? 'not_found'
          : 'unavailable';
    return { results, attempts, status };
  }

  private log(plan: RoutingPlan, providerKey: string, outcome: string, durationMs: number, retries: number, requestId: string | null): void {
    // Identifiers and outcomes only: never payloads, tokens, secrets or queries.
    this.logger?.info({ event: 'integration_call', provider_key: providerKey, family: plan.family, capability: plan.capability, outcome, duration_ms: durationMs, retries, request_id: requestId }, 'integration call');
  }
}

function retriesFor(configuration: unknown): number {
  const value = (configuration as { max_retries?: unknown } | null)?.max_retries;
  return typeof value === 'number' && value >= 1 ? 1 : 0;
}

/** Rejects anything that is not this route's own candidate. */
export function isOwnCandidate(candidate: ExternalProductCandidate, route: ExternalRoute): boolean {
  return candidate.contract_version === CANDIDATE_CONTRACT_VERSION && candidate.provider_key === route.provider_key && candidate.loggable === false && typeof candidate.external_product_id === 'string';
}
