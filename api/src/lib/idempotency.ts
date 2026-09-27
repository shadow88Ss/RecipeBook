// Layer 4A §12 — reusable idempotency foundation.
//
// This is infrastructure only: no route in Layer 4A requires an
// Idempotency-Key yet (import endpoints, which are the first real caller,
// are explicitly out of scope here — 30_API.md §7 and Layer 4A spec §12).
// A future write endpoint that needs retry-safety opts in by adding the
// `idempotency(store)` middleware to its route and reading
// `req.idempotency` if present.
//
// This is deliberately a different mechanism from ImportJob's own
// idempotency_key/canonical_url/content_fingerprint model (30_API.md §7):
// that is *domain* idempotency (never create two Recipes for the same
// import), keyed on durable business fields. This module is *transport*
// idempotency (never double-apply the same HTTP write if a client retries
// after a dropped response), keyed on a client-supplied opaque header. A
// future import endpoint may reasonably use both, for different purposes.

import type { NextFunction, Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { AppError } from './errors';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

export interface IdempotencyRecord {
  requestFingerprint: string;
  status: number;
  body: unknown;
}

export interface IdempotencyStore {
  get(key: string): Promise<IdempotencyRecord | undefined>;
  set(key: string, record: IdempotencyRecord): Promise<void>;
}

/** Reference implementation for local dev/tests. A real deployment behind
 * more than one process/instance needs a shared durable store (e.g. a
 * dedicated table) — swapping the store is the only change required,
 * because routes depend only on the IdempotencyStore interface. */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  async get(key: string): Promise<IdempotencyRecord | undefined> {
    return this.records.get(key);
  }

  async set(key: string, record: IdempotencyRecord): Promise<void> {
    this.records.set(key, record);
  }
}

export function fingerprintRequest(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

function compositeKey(accountId: string, route: string, idempotencyKey: string): string {
  return `${accountId}::${route}::${idempotencyKey}`;
}

/**
 * Must be mounted after the auth middleware (it requires `req.auth`) and
 * after body parsing/validation (it fingerprints the parsed body).
 * Idempotency is scoped per (Account, route, key) — one Account can never
 * collide with, inspect, or replay another Account's idempotency record.
 */
export function idempotency(store: IdempotencyStore) {
  return async function idempotencyMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    const headerValue = req.header(IDEMPOTENCY_KEY_HEADER);
    if (!headerValue) {
      next();
      return;
    }
    if (!req.auth) {
      next(AppError.unauthenticated());
      return;
    }

    const key = compositeKey(req.auth.accountId, `${req.method} ${req.baseUrl}${req.route?.path ?? req.path}`, headerValue);
    const fingerprint = fingerprintRequest(req.body);
    const existing = await store.get(key);

    if (existing) {
      if (existing.requestFingerprint !== fingerprint) {
        next(
          AppError.conflict('This Idempotency-Key was already used with a different request body.', {
            idempotencyKey: headerValue,
          }),
        );
        return;
      }
      res.status(existing.status).json(existing.body);
      return;
    }

    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (res.statusCode < 500) {
        void store.set(key, { requestFingerprint: fingerprint, status: res.statusCode, body });
      }
      return originalJson(body);
    }) as Response['json'];

    next();
  };
}
