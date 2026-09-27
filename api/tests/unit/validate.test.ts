import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { validate } from '../../src/middleware/validate';
import { AppError } from '../../src/lib/errors';

function fakeReq(overrides: Partial<Request> = {}): Request {
  return { params: {}, query: {}, body: {}, ...overrides } as unknown as Request;
}

describe('validate middleware', () => {
  it('L: rejects a malformed UUID path parameter with VALIDATION_ERROR', () => {
    const middleware = validate({ params: z.object({ profile_id: z.uuid() }) });
    const next = vi.fn();
    middleware(fakeReq({ params: { profile_id: 'not-a-uuid' } as never }), {} as Response, next);
    const err = next.mock.calls[0]?.[0] as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.httpStatus).toBe(400);
  });

  it('passes a valid UUID path parameter through unchanged', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const middleware = validate({ params: z.object({ profile_id: z.uuid() }) });
    const next = vi.fn();
    const req = fakeReq({ params: { profile_id: id } as never });
    middleware(req, {} as Response, next);
    expect(next).toHaveBeenCalledWith();
    expect(req.params).toEqual({ profile_id: id });
  });

  it('M: strips unknown/unexpected body fields rather than rejecting the request', () => {
    const schema = z.object({ display_name: z.string() });
    const middleware = validate({ body: schema });
    const next = vi.fn();
    const req = fakeReq({ body: { display_name: 'Ada', unexpected_future_field: 'x', another: 123 } as never });
    middleware(req, {} as Response, next);
    expect(next).toHaveBeenCalledWith();
    expect(req.body).toEqual({ display_name: 'Ada' });
  });

  it('rejects a body missing a required field', () => {
    const schema = z.object({ display_name: z.string() });
    const middleware = validate({ body: schema });
    const next = vi.fn();
    middleware(fakeReq({ body: {} as never }), {} as Response, next);
    expect((next.mock.calls[0]?.[0] as AppError).code).toBe('VALIDATION_ERROR');
  });
});
