import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createAuthMiddleware } from '../../src/middleware/auth';
import { AppError } from '../../src/lib/errors';
import { signTestToken, TEST_JWT_SECRET } from '../helpers/jwt';

function fakeReq(headers: Record<string, string> = {}): Request {
  return {
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

describe('auth middleware (real JWT sign/verify, not simulated)', () => {
  const middleware = createAuthMiddleware({ jwtSecret: TEST_JWT_SECRET });

  it('A: rejects a request with no token', () => {
    const next = vi.fn();
    middleware(fakeReq(), {} as Response, next);
    expect(next).toHaveBeenCalledWith(expect.any(AppError));
    expect((next.mock.calls[0]?.[0] as AppError).code).toBe('UNAUTHENTICATED');
  });

  it('B: rejects a syntactically invalid token', () => {
    const next = vi.fn();
    middleware(fakeReq({ authorization: 'Bearer not-a-jwt' }), {} as Response, next);
    expect((next.mock.calls[0]?.[0] as AppError).code).toBe('UNAUTHENTICATED');
  });

  it('B: rejects a token signed with the wrong secret', () => {
    const token = signTestToken('11111111-1111-1111-1111-111111111111', { secret: 'a-completely-different-secret' });
    const next = vi.fn();
    const req = fakeReq({ authorization: `Bearer ${token}` });
    middleware(req, {} as Response, next);
    expect((next.mock.calls[0]?.[0] as AppError).code).toBe('UNAUTHENTICATED');
    expect(req.auth).toBeUndefined();
  });

  it('B: rejects an expired token', () => {
    const token = signTestToken('11111111-1111-1111-1111-111111111111', { expiresInSeconds: -60 });
    const next = vi.fn();
    middleware(fakeReq({ authorization: `Bearer ${token}` }), {} as Response, next);
    expect((next.mock.calls[0]?.[0] as AppError).code).toBe('UNAUTHENTICATED');
  });

  it('rejects a token with an unexpected audience', () => {
    const token = signTestToken('11111111-1111-1111-1111-111111111111', { aud: 'some-other-audience' });
    const next = vi.fn();
    middleware(fakeReq({ authorization: `Bearer ${token}` }), {} as Response, next);
    expect((next.mock.calls[0]?.[0] as AppError).code).toBe('UNAUTHENTICATED');
  });

  it('accepts a valid token and derives accountId only from the verified sub claim, never from client input', () => {
    const accountId = '22222222-2222-2222-2222-222222222222';
    const token = signTestToken(accountId);
    const next = vi.fn();
    const req = fakeReq({ authorization: `Bearer ${token}` });
    middleware(req, {} as Response, next);
    expect(next).toHaveBeenCalledWith();
    expect(req.auth).toEqual({ accountId, accessToken: token });
  });
});
