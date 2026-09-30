// Uses the real supabase-js client against a scripted Supabase Auth endpoint
// and an in-memory keychain, so restore/refresh/sign-out are Supabase's own.

import { createAuthService } from '../src/auth/authService';
import { createSecureSessionStorage } from '../src/auth/secureStorage';
import { AUTH_STORAGE_KEY, createAuthClient } from '../src/auth/supabaseAuth';
import { TEST_CONFIG } from './helpers/fixtures';
import { fakeFetch, json, sessionPayload, type Call } from './helpers/fakeServer';
import { memorySecureStore } from './helpers/memorySecureStore';

function setup(routes: Record<string, (call: Call) => Response | Promise<Response>> = {}, oauthProviders: ('google' | 'apple')[] = []) {
  const store = memorySecureStore();
  const storage = createSecureSessionStorage(store);
  const server = fakeFetch(routes);
  const auth = createAuthClient(TEST_CONFIG, storage, { fetch: server.fetch });
  const browser = { redirectUrl: () => 'myrecipebook-development://auth/callback', openAuthSession: jest.fn(async () => null) };
  const service = createAuthService(auth, storage, { oauthProviders, browser });
  return { store, storage, server, auth, service, browser };
}

const allStoredText = (store: ReturnType<typeof memorySecureStore>) => [...store.data.values()].join('');

describe('auth service over supabase-js (§9–12)', () => {
  it('restores a stored session from secure storage and returns its access token', async () => {
    const { storage, service, server } = setup();
    await storage.setItem(AUTH_STORAGE_KEY, JSON.stringify(sessionPayload({ accessToken: 'restored-token' })));
    const session = await service.restoreSession();
    expect(session?.user.email).toBe('owner@example.test');
    expect(await service.getAccessToken()).toBe('restored-token');
    expect(server.calls).toHaveLength(0);
  });

  it('has no session and no token when nothing is stored', async () => {
    const { service } = setup();
    expect(await service.restoreSession()).toBeNull();
    expect(await service.getAccessToken()).toBeNull();
  });

  it('signs in with email/password through Supabase and keeps the session only in secure storage', async () => {
    const { service, server, store } = setup({ 'POST /auth/v1/token': () => json(200, sessionPayload({ accessToken: 'fresh' })) });
    await expect(service.signInWithPassword(' owner@example.test ', 'correct horse')).resolves.toEqual({ ok: true });
    const call = server.calls[0]!;
    expect(call.url).toContain('/auth/v1/token?grant_type=password');
    expect(call.body).toMatchObject({ email: 'owner@example.test', password: 'correct horse' });
    expect(call.headers.apikey).toBe(TEST_CONFIG.supabaseAnonKey);
    expect(await service.getAccessToken()).toBe('fresh');
    expect(store.data.has(`${AUTH_STORAGE_KEY}.chunks`)).toBe(true);
    expect(allStoredText(store)).not.toContain('correct horse');
  });

  it('maps a rejected password to invalid_credentials and stores nothing', async () => {
    const { service, store } = setup({ 'POST /auth/v1/token': () => json(400, { code: 'invalid_credentials', error_code: 'invalid_credentials', msg: 'Invalid login credentials' }) });
    await expect(service.signInWithPassword('a@b.c', 'wrong')).resolves.toEqual({ ok: false, reason: 'invalid_credentials' });
    expect(store.data.size).toBe(0);
  });

  it('maps an unreachable auth service to network', async () => {
    const { service } = setup({
      'POST /auth/v1/token': () => {
        throw new TypeError('Network request failed');
      },
    });
    const result = await service.signInWithPassword('a@b.c', 'pw');
    expect(result).toEqual({ ok: false, reason: 'network' });
  });

  it('lets Supabase refresh an expired session (no second refresh implementation)', async () => {
    const { storage, service, server } = setup({ 'POST /auth/v1/token': () => json(200, sessionPayload({ accessToken: 'refreshed', refreshToken: 'refresh-2' })) });
    await storage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ ...sessionPayload({ accessToken: 'stale' }), expires_at: Math.floor(Date.now() / 1000) - 60 }));
    expect(await service.getAccessToken()).toBe('refreshed');
    expect(server.calls.map((c) => c.url.split('?')[1])).toEqual(['grant_type=refresh_token']);
  });

  it('sign-out revokes via Supabase and clears the secure session', async () => {
    const { storage, service, server, store } = setup({ 'POST /auth/v1/logout': () => new Response(null, { status: 204 }) });
    await storage.setItem(AUTH_STORAGE_KEY, JSON.stringify(sessionPayload()));
    await service.signOut();
    expect(server.calls.some((c) => c.url.includes('/auth/v1/logout'))).toBe(true);
    expect(store.data.size).toBe(0);
    expect(await service.getAccessToken()).toBeNull();
  });

  it('sign-out still clears the secure session when the network is down', async () => {
    const { storage, service, store } = setup({
      'POST /auth/v1/logout': () => {
        throw new TypeError('Network request failed');
      },
    });
    await storage.setItem(AUTH_STORAGE_KEY, JSON.stringify(sessionPayload()));
    await service.signOut();
    expect(store.data.size).toBe(0);
  });

  it('clearLocalSession (used after an API 401) wipes the secure session even if Supabase is unreachable', async () => {
    const { storage, service, store, server } = setup({
      'POST /auth/v1/logout': () => {
        throw new TypeError('Network request failed');
      },
    });
    await storage.setItem(AUTH_STORAGE_KEY, JSON.stringify(sessionPayload()));
    await service.clearLocalSession();
    expect(store.data.size).toBe(0);
    expect(server.calls.map((c) => c.url.split('?')[1])).toEqual(['scope=local']);
    expect(await service.getAccessToken()).toBeNull();
  });

  it('refuses Google/Apple until the environment declares them configured (§21)', async () => {
    const { service, server, browser } = setup();
    await expect(service.signInWithOAuth('google')).resolves.toEqual({ ok: false, reason: 'not_configured' });
    await expect(service.signInWithOAuth('apple')).resolves.toEqual({ ok: false, reason: 'not_configured' });
    expect(server.calls).toHaveLength(0);
    expect(browser.openAuthSession).not.toHaveBeenCalled();
  });

  it('runs the PKCE browser flow when a provider is configured, and reports cancel', async () => {
    const { service, browser } = setup({}, ['google']);
    await expect(service.signInWithOAuth('google')).resolves.toEqual({ ok: false, reason: 'cancelled' });
    const [url, redirect] = (browser.openAuthSession as jest.Mock).mock.calls[0] as [string, string];
    expect(url).toContain('/auth/v1/authorize?provider=google');
    expect(url).toContain('code_challenge=');
    expect(redirect).toBe('myrecipebook-development://auth/callback');
  });
});
