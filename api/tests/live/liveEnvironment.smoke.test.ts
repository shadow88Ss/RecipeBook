// Layer 12A.1 — OPT-IN live smoke tests against a REAL development Supabase
// project and a DEPLOYED development API. Skipped unless LIVE_ENV_SMOKE=1.
// Run with `npm run test:live-env` (see docs/40_Development_Environment.md).
//
// Required:  LIVE_API_BASE_URL (https, without /v1), LIVE_SUPABASE_URL,
//            LIVE_SUPABASE_ANON_KEY (anon or sb_publishable_ key),
//            LIVE_USER_A_EMAIL, LIVE_USER_A_PASSWORD
// Optional:  LIVE_USER_B_EMAIL, LIVE_USER_B_PASSWORD (an unrelated second
//            account, for the cross-account RLS checks)
//            LIVE_EXPIRED_TOKEN (a real access token from this project that
//            has since expired, for the expired-token check)
//            LIVE_ALLOW_HTTP=1 (only for an API on a trusted LAN)
//
// Tokens, passwords and keys are never printed. Nothing here uses a
// service-role key: users sign in through normal Supabase Auth.

import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const live = process.env.LIVE_ENV_SMOKE === '1';
const env = (name: string) => process.env[name] ?? '';
const API = env('LIVE_API_BASE_URL').replace(/\/+$/, '');
const TZ = 'UTC';

function newClient(): SupabaseClient {
  return createClient(env('LIVE_SUPABASE_URL'), env('LIVE_SUPABASE_ANON_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function signIn(client: SupabaseClient, email: string, password: string): Promise<Session> {
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`sign-in failed for ${email.replace(/(.).*@/, '$1***@')}: ${error?.code ?? 'no session'}`);
  return data.session;
}

async function api(path: string, token?: string | null) {
  const res = await fetch(`${API}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body: body as Record<string, unknown> };
}

const header = (token: string) => JSON.parse(Buffer.from(token.split('.')[0] ?? '', 'base64url').toString()) as { alg?: string; kid?: string };
const payload = (token: string) => JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as Record<string, unknown>;
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

describe.skipIf(!live)('live development environment (12A.1)', () => {
  let clientA: SupabaseClient;
  let sessionA: Session;
  let firstProfileId: string;

  beforeAll(async () => {
    for (const name of ['LIVE_API_BASE_URL', 'LIVE_SUPABASE_URL', 'LIVE_SUPABASE_ANON_KEY', 'LIVE_USER_A_EMAIL', 'LIVE_USER_A_PASSWORD']) {
      if (!env(name)) throw new Error(`${name} is required`);
    }
    if (!API.startsWith('https://') && process.env.LIVE_ALLOW_HTTP !== '1') throw new Error('LIVE_API_BASE_URL must be https');
    if (/^sb_secret_/.test(env('LIVE_SUPABASE_ANON_KEY'))) throw new Error('Use the anon/publishable key, never a secret key');
    clientA = newClient();
    sessionA = await signIn(clientA, env('LIVE_USER_A_EMAIL'), env('LIVE_USER_A_PASSWORD'));
  });

  afterAll(async () => {
    await clientA?.auth.signOut().catch(() => undefined);
  });

  it('§11 GET /health answers 200 without a token', async () => {
    expect((await api('/health')).status).toBe(200);
  });

  it('reports the project signing algorithm (informational)', () => {
    const h = header(sessionA.access_token);
    const p = payload(sessionA.access_token);
    console.info(`[live] access token alg=${h.alg} kid=${h.kid ? 'present' : 'absent'} iss=${String(p.iss)} aud=${String(p.aud)}`);
    expect(['ES256', 'RS256', 'HS256']).toContain(h.alg);
    expect(p.iss).toBe(`${env('LIVE_SUPABASE_URL').replace(/\/+$/, '')}/auth/v1`);
  });

  it('§11 GET /v1/profiles with a REAL Supabase token: API and Auth agree on identity', async () => {
    const res = await api('/v1/profiles', sessionA.access_token);
    expect(res.status).toBe(200);
    const profiles = res.body.data as Array<{ id: string; account_id?: string; access_scope: string }>;
    expect(profiles.length).toBeGreaterThan(0);
    const own = profiles.filter((p) => p.access_scope === 'full_management' && p.account_id === sessionA.user.id);
    expect(own.length).toBeGreaterThan(0); // §9: Account = auth.users.id, default Profile provisioned
    firstProfileId = own[0]!.id;
  });

  it.each([
    ['no token', () => null],
    ['malformed token', () => 'not.a.jwt'],
    [
      'tampered signature',
      () => {
        const [h, p, s] = sessionA.access_token.split('.') as [string, string, string];
        return `${h}.${p}.${s.slice(0, -4)}${s.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'}`;
      },
    ],
    [
      'alg none',
      () => `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${sessionA.access_token.split('.')[1]}.`,
    ],
  ])('§12 %s -> 401', async (_label, make) => {
    const res = await api('/v1/profiles', make());
    expect(res.status).toBe(401);
    expect((res.body.error as { code: string }).code).toBe('UNAUTHENTICATED');
  });

  it.skipIf(!process.env.LIVE_EXPIRED_TOKEN)('§12 expired real token -> 401', async () => {
    expect((await api('/v1/profiles', env('LIVE_EXPIRED_TOKEN'))).status).toBe(401);
  });

  it('§16 Daily Tracker for the real Profile: missing values are null, never invented', async () => {
    const res = await api(`/v1/profiles/${firstProfileId}/daily-tracker?date=${today()}&timezone=${TZ}`, sessionA.access_token);
    expect(res.status).toBe(200);
    const actual = res.body.actual as { basis: string; summary: Record<string, { value: number | null; coverage: string; is_zero: boolean }> };
    expect(['recorded_snapshots', 'no_consumption']).toContain(actual.basis);
    for (const entry of Object.values(actual.summary)) {
      if (entry.coverage === 'unavailable') expect(entry.value).toBeNull();
      if (entry.value === 0) expect(entry.is_zero).toBe(true);
    }
  });

  it('§17 Progress for the real Profile: three factual sections, no combined score', async () => {
    const res = await api(`/v1/profiles/${firstProfileId}/progress?from=${daysAgo(6)}&to=${today()}&timezone=${TZ}`, sessionA.access_token);
    expect(res.status).toBe(200);
    expect(res.body.combined_score).toBeNull();
    expect(res.body).toHaveProperty('plan_fulfillment');
    expect(res.body).toHaveProperty('nutrition_adherence');
    expect(res.body).toHaveProperty('goal_progress');
  });

  it('§26 normal SDK refresh yields a new access token that the API accepts', async () => {
    const { data, error } = await clientA.auth.refreshSession();
    expect(error).toBeNull();
    expect(data.session?.access_token).toBeTruthy();
    expect(data.session!.access_token).not.toBe(sessionA.access_token);
    expect((await api('/v1/profiles', data.session!.access_token)).status).toBe(200);
    sessionA = data.session!;
  });

  describe.skipIf(!process.env.LIVE_USER_B_EMAIL)('§28 real-project RLS with a second, unrelated account', () => {
    let clientB: SupabaseClient;
    let sessionB: Session;
    let profileB: string;

    beforeAll(async () => {
      clientB = newClient();
      sessionB = await signIn(clientB, env('LIVE_USER_B_EMAIL'), env('LIVE_USER_B_PASSWORD'));
      const res = await api('/v1/profiles', sessionB.access_token);
      profileB = (res.body.data as Array<{ id: string; account_id?: string }>).find((p) => p.account_id === sessionB.user.id)!.id;
    });

    afterAll(async () => {
      await clientB?.auth.signOut().catch(() => undefined);
    });

    it('each account sees its own Profile and not the other one', async () => {
      const a = (await api('/v1/profiles', sessionA.access_token)).body.data as Array<{ id: string }>;
      const b = (await api('/v1/profiles', sessionB.access_token)).body.data as Array<{ id: string }>;
      expect(a.map((p) => p.id)).not.toContain(profileB);
      expect(b.map((p) => p.id)).not.toContain(firstProfileId);
    });

    it('an unrelated Profile is not found through the API (RLS + scope)', async () => {
      expect((await api(`/v1/profiles/${profileB}/daily-tracker?date=${today()}&timezone=${TZ}`, sessionA.access_token)).status).toBe(404);
      expect((await api(`/v1/profiles/${firstProfileId}/progress?from=${daysAgo(6)}&to=${today()}&timezone=${TZ}`, sessionB.access_token)).status).toBe(404);
    });

    it('Supabase PostgREST itself (RLS, anon key + user token) hides the other account’s Profile', async () => {
      const { data, error } = await clientB.from('profile').select('id').eq('id', firstProfileId);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });
  });

  it('§14 sign-out revokes the refresh token (the old refresh token no longer works)', async () => {
    const refreshToken = sessionA.refresh_token;
    await clientA.auth.signOut();
    const fresh = newClient();
    const { error } = await fresh.auth.refreshSession({ refresh_token: refreshToken });
    expect(error).not.toBeNull();
  });
});
