import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createAuthMiddleware } from '../../src/middleware/auth';
import { AppError } from '../../src/lib/errors';
import type { AccessTokenVerifier } from '../../src/lib/accessTokenVerifier';
import { signTestToken, TEST_JWT_SECRET } from '../helpers/jwt';

function fakeReq(headers: Record<string, string> = {}): Request {
  return {
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

async function run(middleware: ReturnType<typeof createAuthMiddleware>, req: Request) {
  const next = vi.fn();
  await middleware(req, {} as Response, next);
  return next;
}

const errorCode = (next: ReturnType<typeof vi.fn>) => (next.mock.calls[0]?.[0] as AppError).code;

describe('auth middleware (real JWT sign/verify, not simulated)', () => {
  const middleware = createAuthMiddleware({ jwtSecret: TEST_JWT_SECRET });

  it('A: rejects a request with no token', async () => {
    const next = await run(middleware, fakeReq());
    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    expect(errorCode(next)).toBe('UNAUTHENTICATED');
  });

  it('A: rejects a non-Bearer header and an empty Bearer token', async () => {
    expect(errorCode(await run(middleware, fakeReq({ authorization: 'Basic abc' })))).toBe('UNAUTHENTICATED');
    expect(errorCode(await run(middleware, fakeReq({ authorization: 'Bearer   ' })))).toBe('UNAUTHENTICATED');
  });

  it('B: rejects a syntactically invalid token', async () => {
    expect(errorCode(await run(middleware, fakeReq({ authorization: 'Bearer not-a-jwt' })))).toBe('UNAUTHENTICATED');
  });

  it('B: rejects a token signed with the wrong secret', async () => {
    const token = signTestToken('11111111-1111-1111-1111-111111111111', { secret: 'a-completely-different-secret' });
    const req = fakeReq({ authorization: `Bearer ${token}` });
    expect(errorCode(await run(middleware, req))).toBe('UNAUTHENTICATED');
    expect(req.auth).toBeUndefined();
  });

  it('B: rejects an expired token', async () => {
    const token = signTestToken('11111111-1111-1111-1111-111111111111', { expiresInSeconds: -60 });
    expect(errorCode(await run(middleware, fakeReq({ authorization: `Bearer ${token}` })))).toBe('UNAUTHENTICATED');
  });

  it('rejects a token with an unexpected audience', async () => {
    const token = signTestToken('11111111-1111-1111-1111-111111111111', { aud: 'some-other-audience' });
    expect(errorCode(await run(middleware, fakeReq({ authorization: `Bearer ${token}` })))).toBe('UNAUTHENTICATED');
  });

  it('accepts a valid token and derives accountId only from the verified sub claim, never from client input', async () => {
    const accountId = '22222222-2222-2222-2222-222222222222';
    const token = signTestToken(accountId);
    const req = fakeReq({ authorization: `Bearer ${token}`, 'x-account-id': '33333333-3333-3333-3333-333333333333' });
    const next = await run(middleware, req);
    expect(next).toHaveBeenCalledWith();
    expect(req.auth).toEqual({ accountId, accessToken: token });
  });

  it('answers 503 (not 401) when the verifier cannot reach the signing keys, so clients keep their session', async () => {
    const verifier: AccessTokenVerifier = { mode: 'jwks', verify: async () => ({ ok: false, reason: 'unavailable' }) };
    const next = await run(createAuthMiddleware({ verifier }), fakeReq({ authorization: 'Bearer x.y.z' }));
    expect(errorCode(next)).toBe('SERVICE_UNAVAILABLE');
  });
});
