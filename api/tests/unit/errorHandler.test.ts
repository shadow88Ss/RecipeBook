import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createErrorHandler } from '../../src/middleware/errorHandler';
import { AppError } from '../../src/lib/errors';
import type { Logger } from '../../src/lib/logger';

function fakeLogger(): Logger {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function fakeRes(): Response {
  const res: Record<string, unknown> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as unknown as Response;
}

describe('errorHandler', () => {
  it('renders an AppError using its own code/status/message', () => {
    const logger = fakeLogger();
    const handler = createErrorHandler(logger);
    const res = fakeRes();
    const req = { requestId: 'req-1' } as Request;

    handler(AppError.notFound('Profile not found.'), req, res, () => undefined);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      error: { code: 'NOT_FOUND', message: 'Profile not found.', requestId: 'req-1' },
    });
  });

  it('N: converts an unexpected raw error (e.g. a driver/SQL-shaped error) to a generic INTERNAL_ERROR without leaking internals', () => {
    const logger = fakeLogger();
    const handler = createErrorHandler(logger);
    const res = fakeRes();
    const req = { requestId: 'req-2' } as Request;

    const rawDbError = Object.assign(new Error('duplicate key value violates unique constraint "account_email_key"'), {
      code: '23505',
      detail: 'Key (email)=(x@example.com) already exists.',
      table: 'account',
    });

    handler(rawDbError, req, res, () => undefined);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = (res.json as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', requestId: 'req-2' },
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('account_email_key');
    expect(serialized).not.toContain('23505');
    expect(serialized).not.toContain('x@example.com');
    // The real error IS logged server-side, in full, so it stays diagnosable.
    expect(logger.error).toHaveBeenCalled();
  });
});
