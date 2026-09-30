// A scripted fetch for the MyRecipeBook API and Supabase Auth endpoints.

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Responder = (call: Call) => Response | Promise<Response>;

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export function fakeFetch(routes: Record<string, Responder>) {
  const calls: Call[] = [];
  const fn = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init.headers ?? {}).forEach((value, key) => {
      headers[key] = value;
    });
    const call: Call = { url, method: (init.method ?? 'GET').toUpperCase(), headers, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const path = new URL(url).pathname;
    const key = Object.keys(routes).find((k) => {
      const [method, pattern] = k.split(' ') as [string, string];
      return method === call.method && new RegExp(`^${pattern}$`).test(path);
    });
    if (!key) return json(404, { error: { code: 'NOT_FOUND', message: `no fake for ${call.method} ${path}`, requestId: 'fake' } });
    return routes[key]!(call);
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}

export function sessionPayload(opts: { accessToken?: string; refreshToken?: string; expiresInSeconds?: number; userId?: string; email?: string } = {}) {
  const expiresIn = opts.expiresInSeconds ?? 3600;
  return {
    access_token: opts.accessToken ?? 'access-token-1',
    refresh_token: opts.refreshToken ?? 'refresh-token-1',
    token_type: 'bearer',
    expires_in: expiresIn,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    user: { id: opts.userId ?? '11111111-1111-4111-8111-111111111111', aud: 'authenticated', role: 'authenticated', email: opts.email ?? 'owner@example.test', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' },
  };
}
