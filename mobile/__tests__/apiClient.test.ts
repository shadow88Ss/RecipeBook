import { z } from 'zod';

import { createApiClient } from '../src/api/client';
import { ApiError } from '../src/api/errors';
import { fakeFetch, json } from './helpers/fakeServer';

const schema = z.object({ ok: z.boolean() });

function setup(routes: Parameters<typeof fakeFetch>[0], opts: { token?: string | null; timeoutMs?: number } = {}) {
  const server = fakeFetch(routes);
  const onUnauthorized = jest.fn();
  const getAccessToken = jest.fn(async () => (opts.token === undefined ? 'tok-1' : opts.token));
  const api = createApiClient({ baseUrl: 'https://api.test.example', getAccessToken, onUnauthorized, fetch: server.fetch, timeoutMs: opts.timeoutMs, newRequestId: () => 'req-123' });
  return { api, server, onUnauthorized, getAccessToken };
}

async function failure(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error('expected failure');
}

describe('API client (§11, §13, §16)', () => {
  it('sends the Supabase access token as a Bearer header with a request id and JSON accept', async () => {
    const { api, server } = setup({ 'GET /v1/ping': () => json(200, { ok: true }) });
    await expect(api.request('/v1/ping', { schema, query: { a: 'x y', skip: undefined } })).resolves.toEqual({ ok: true });
    const call = server.calls[0]!;
    expect(call.url).toBe('https://api.test.example/v1/ping?a=x%20y');
    expect(call.headers.authorization).toBe('Bearer tok-1');
    expect(call.headers['x-request-id']).toBe('req-123');
    expect(call.headers.accept).toBe('application/json');
  });

  it('never sends an account id as authority', async () => {
    const { api, server } = setup({ 'POST /v1/thing': () => json(200, { ok: true }) });
    await api.request('/v1/thing', { method: 'POST', body: { name: 'n' }, schema });
    const call = server.calls[0]!;
    expect(JSON.stringify(call)).not.toMatch(/account_id/);
    expect(call.headers['content-type']).toBe('application/json');
  });

  it('reads the token from the auth layer on every request (no cached token)', async () => {
    const { api, getAccessToken } = setup({ 'GET /v1/ping': () => json(200, { ok: true }) });
    await api.request('/v1/ping', { schema });
    await api.request('/v1/ping', { schema });
    expect(getAccessToken).toHaveBeenCalledTimes(2);
  });

  it('does not call the API without a session', async () => {
    const { api, server } = setup({ 'GET /v1/ping': () => json(200, { ok: true }) }, { token: null });
    const err = await failure(api.request('/v1/ping', { schema }));
    expect(err.kind).toBe('unauthenticated');
    expect(server.calls).toHaveLength(0);
  });

  it('on 401 notifies the auth layer once and throws unauthenticated', async () => {
    const { api, onUnauthorized } = setup({ 'GET /v1/ping': () => json(401, { error: { code: 'UNAUTHENTICATED', message: 'Invalid token', requestId: 'r-401' } }) });
    const err = await failure(api.request('/v1/ping', { schema }));
    expect(err.kind).toBe('unauthenticated');
    expect(err.requestId).toBe('r-401');
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it.each([
    [400, 'validation'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [409, 'conflict'],
    [429, 'rate_limited'],
    [500, 'server'],
    [503, 'unavailable'],
    [502, 'server'],
  ])('maps HTTP %i to %s without keeping server text', async (status, kind) => {
    const { api, onUnauthorized } = setup({
      'GET /v1/ping': () => json(status, { error: { code: 'X', message: 'relation "meal_item" does not exist at /srv/app.js:12', requestId: 'r1', details: { issues: [{ path: 'date', message: 'bad' }] } } }, { 'retry-after': '7' }),
    });
    const err = await failure(api.request('/v1/ping', { schema }));
    expect(err.kind).toBe(kind);
    expect(err.status).toBe(status);
    expect(err.message).toBe(`api_error:${kind}`);
    expect(JSON.stringify(err)).not.toMatch(/meal_item|srv/);
    expect(onUnauthorized).not.toHaveBeenCalled();
    if (status === 429) expect(err.retryAfterSeconds).toBe(7);
    if (status === 400) expect(err.issues).toEqual([{ path: 'date' }]);
  });

  it('maps a network failure to offline', async () => {
    const { api } = setup({
      'GET /v1/ping': () => {
        throw new TypeError('Network request failed');
      },
    });
    expect((await failure(api.request('/v1/ping', { schema }))).kind).toBe('offline');
  });

  it('times out a request that never answers', async () => {
    const hanging = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const api = createApiClient({ baseUrl: 'https://api.test.example', getAccessToken: async () => 't', onUnauthorized: jest.fn(), fetch: hanging as unknown as typeof fetch, timeoutMs: 20 });
    expect((await failure(api.request('/v1/ping', { schema }))).kind).toBe('timeout');
  });

  it('rejects a body that does not match the contract', async () => {
    const { api } = setup({ 'GET /v1/ping': () => json(200, { ok: 'yes' }) });
    expect((await failure(api.request('/v1/ping', { schema }))).kind).toBe('invalid_response');
  });

  it('refuses Platform Admin and non-/v1 paths before any network call (§39, §41 E)', async () => {
    const { api, server } = setup({});
    await expect(api.request('/v1/admin/integrations', { schema })).rejects.toThrow(/not a consumer/);
    await expect(api.request('/v1/admin', { schema })).rejects.toThrow(/not a consumer/);
    await expect(api.request('/health', { schema })).rejects.toThrow(/not a consumer/);
    expect(server.calls).toHaveLength(0);
  });
});
