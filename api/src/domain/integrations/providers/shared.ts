// Layer 11D — transport, rate-limit and temporary-cache helpers shared by
// the product-data adapters. Nothing here persists anything: the cache and
// the rate limiter are in-process memory, bounded, and lost on restart.

import type { AdapterContext } from '../adapters';
import { IntegrationFailure } from '../integration.model';
import type { ExternalProductCandidate, ProviderStoragePolicy } from '../productData';

export type Transport = typeof fetch;

export interface ProviderResponse {
  status: number;
  body: unknown;
}

/** One HTTP call to a provider, mapped into the Layer 11C failure model.
 * Response bodies are parsed but never logged or returned raw. */
export async function providerRequest(ctx: AdapterContext, transport: Transport, url: string, init: RequestInit = {}): Promise<ProviderResponse> {
  let response: Response;
  try {
    response = await transport(url, { ...init, signal: ctx.signal, redirect: 'error' });
  } catch (err) {
    if (ctx.signal.aborted || (err as { name?: unknown }).name === 'AbortError' || (err as { name?: unknown }).name === 'TimeoutError') {
      throw new IntegrationFailure('timeout');
    }
    throw new IntegrationFailure('provider_unavailable');
  }
  if (response.status === 429) {
    const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
    throw new IntegrationFailure('rate_limited', Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {});
  }
  if (response.status === 401 || response.status === 403) throw new IntegrationFailure('authentication_failed');
  if (response.status >= 500) throw new IntegrationFailure('provider_unavailable');
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (ctx.signal.aborted) throw new IntegrationFailure('timeout');
    throw new IntegrationFailure('invalid_provider_response');
  }
  return { status: response.status, body };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

/** Sliding one-minute window, per adapter instance (per API process). A
 * refused call never reaches the provider. */
export class MinuteRateLimiter {
  private readonly calls: number[] = [];

  constructor(private readonly now: () => Date) {}

  take(limitPerMinute: number): void {
    const t = this.now().getTime();
    while (this.calls.length && (this.calls[0] as number) <= t - 60_000) this.calls.shift();
    if (this.calls.length >= limitPerMinute) {
      const waitMs = (this.calls[0] as number) + 60_000 - t;
      throw new IntegrationFailure('rate_limited', { retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) });
    }
    this.calls.push(t);
  }
}

interface CacheEntry {
  value: ExternalProductCandidate | ExternalProductCandidate[] | null;
  expiresAt: number;
}

/** Temporary, in-memory cache of NORMALIZED candidates (never raw payloads).
 * The TTL is the provider's configured value, capped by its storage policy;
 * expired entries are never served. The key always carries provider,
 * operation, identifier/query and locale. */
export class CandidateCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly now: () => Date,
    private readonly maxEntries = 2000,
  ) {}

  static key(providerKey: string, operation: string, identifier: string, locale: string): string {
    return JSON.stringify([providerKey, operation, identifier, locale]);
  }

  get(key: string): CacheEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now().getTime()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  set(key: string, value: CacheEntry['value'], ttlSeconds: number): void {
    if (ttlSeconds <= 0) return;
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: this.now().getTime() + ttlSeconds * 1000 });
  }

  size(): number {
    return this.entries.size;
  }

  /** Test/ops visibility: the stored values (normalized candidates only). */
  values(): Array<CacheEntry['value']> {
    return [...this.entries.values()].map((e) => e.value);
  }
}

/** Serves from the cache (marking freshness) or calls through and stores. */
export async function cached<T extends ExternalProductCandidate | ExternalProductCandidate[] | null>(
  cache: CandidateCache,
  key: string,
  ttlSeconds: number,
  policy: ProviderStoragePolicy,
  load: () => Promise<T>,
): Promise<T> {
  const effectiveTtl = Math.min(ttlSeconds, policy.temporary_cache_max_seconds);
  const hit = cache.get(key);
  if (hit) {
    const expires = new Date(hit.expiresAt).toISOString();
    const mark = (c: ExternalProductCandidate): ExternalProductCandidate => ({ ...c, freshness: { served_from_cache: true, cache_expires_at: expires } });
    const value = hit.value;
    return (Array.isArray(value) ? value.map(mark) : value ? mark(value) : null) as T;
  }
  const value = await load();
  cache.set(key, value, effectiveTtl);
  return value;
}
