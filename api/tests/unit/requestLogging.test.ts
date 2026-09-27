import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { EventEmitter } from 'node:events';
import { createRequestLogging } from '../../src/middleware/requestLogging';
import type { Logger } from '../../src/lib/logger';

describe('requestLogging middleware', () => {
  it('P: never passes the Authorization header or bearer token to the logger', () => {
    const info = vi.fn();
    const logger = { info, error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as Logger;
    const middleware = createRequestLogging(logger);

    const secretToken = 'super-secret-bearer-token-value';
    const emitter = new EventEmitter();
    const req = {
      requestId: 'req-1',
      method: 'GET',
      path: '/v1/profiles',
      header: (name: string) => (name.toLowerCase() === 'authorization' ? `Bearer ${secretToken}` : undefined),
      auth: { accountId: 'acct-1', accessToken: secretToken },
    } as unknown as Request;
    const res = Object.assign(emitter, { statusCode: 200 }) as unknown as Response;

    middleware(req, res, () => undefined);
    emitter.emit('finish');

    expect(info).toHaveBeenCalledTimes(1);
    const logged = info.mock.calls[0]?.[0];
    const serialized = JSON.stringify(logged);
    expect(serialized).not.toContain(secretToken);
    expect(serialized.toLowerCase()).not.toContain('authorization');
    expect(logged).toEqual({
      requestId: 'req-1',
      method: 'GET',
      path: '/v1/profiles',
      status: 200,
      durationMs: expect.any(Number),
      accountId: 'acct-1',
    });
  });
});
