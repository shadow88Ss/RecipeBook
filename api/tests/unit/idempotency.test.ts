import { describe, expect, it } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { fingerprintRequest, idempotency, InMemoryIdempotencyStore } from '../../src/lib/idempotency';
import { AppError } from '../../src/lib/errors';

function fakeRes(): Response {
  const res = {
    statusCode: 200,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      (res as unknown as { lastBody: unknown }).lastBody = body;
      return res;
    },
  } as unknown as Response;
  return res;
}

function fakeReq(overrides: Partial<Request> = {}): Request {
  return {
    method: 'POST',
    baseUrl: '/v1/example',
    path: '/',
    route: { path: '/' },
    body: { a: 1 },
    auth: { accountId: 'acct-1', accessToken: 'token' },
    header: () => undefined,
    ...overrides,
  } as unknown as Request;
}

describe('idempotency middleware', () => {
  it('passes through untouched when no Idempotency-Key header is present', async () => {
    const store = new InMemoryIdempotencyStore();
    const middleware = idempotency(store);
    let called = false;
    const next: NextFunction = () => {
      called = true;
    };
    await middleware(fakeReq({ header: () => undefined } as never), fakeRes(), next);
    expect(called).toBe(true);
  });

  it('replays the stored response for a retried request with the same key and body', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.set('acct-1::POST /v1/example/::key-1', {
      requestFingerprint: fingerprintRequest({ a: 1 }),
      status: 201,
      body: { id: 'created-once' },
    });
    const middleware = idempotency(store);
    const res = fakeRes();
    const next = () => {
      throw new Error('handler should not run on replay');
    };
    await middleware(
      fakeReq({ header: (n: string) => (n.toLowerCase() === 'idempotency-key' ? 'key-1' : undefined) } as never),
      res,
      next,
    );
    expect(res.statusCode).toBe(201);
    expect((res as unknown as { lastBody: unknown }).lastBody).toEqual({ id: 'created-once' });
  });

  it('rejects reuse of the same key with a different request body as CONFLICT', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.set('acct-1::POST /v1/example/::key-1', {
      requestFingerprint: fingerprintRequest({ a: 999 }),
      status: 201,
      body: { id: 'created-once' },
    });
    const middleware = idempotency(store);
    let captured: unknown;
    const next = (err?: unknown) => {
      captured = err;
    };
    await middleware(
      fakeReq({ header: (n: string) => (n.toLowerCase() === 'idempotency-key' ? 'key-1' : undefined) } as never),
      fakeRes(),
      next,
    );
    expect(captured).toBeInstanceOf(AppError);
    expect((captured as AppError).code).toBe('CONFLICT');
  });
});
