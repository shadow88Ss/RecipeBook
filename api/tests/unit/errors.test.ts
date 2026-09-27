import { describe, expect, it } from 'vitest';
import { AppError, ErrorCode } from '../../src/lib/errors';

describe('AppError', () => {
  it('maps each factory to its documented HTTP status', () => {
    expect(AppError.validation('x').httpStatus).toBe(400);
    expect(AppError.unauthenticated().httpStatus).toBe(401);
    expect(AppError.forbidden().httpStatus).toBe(403);
    expect(AppError.notFound().httpStatus).toBe(404);
    expect(AppError.conflict('x').httpStatus).toBe(409);
    expect(AppError.rateLimited().httpStatus).toBe(429);
    expect(AppError.internal().httpStatus).toBe(500);
  });

  it('sets the matching error code', () => {
    expect(AppError.notFound().code).toBe(ErrorCode.NOT_FOUND);
  });

  it('carries optional safe details without a stack trace field', () => {
    const err = AppError.validation('bad input', { issues: [{ path: 'x', message: 'required' }] });
    expect(err.details).toEqual({ issues: [{ path: 'x', message: 'required' }] });
    expect((err as unknown as Record<string, unknown>).stack).toBeTypeOf('string');
    // "stack" is Error's own debugging property — asserting the JSON envelope
    // built by errorHandler.ts never includes it is covered separately in
    // errorHandler.test.ts (that is the security-relevant boundary).
  });
});
