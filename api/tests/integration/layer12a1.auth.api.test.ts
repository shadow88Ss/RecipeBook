// Layer 12A.1 — the HTTP API with the production verifier in `jwks` mode:
// ES256 tokens signed by a local key, published through a real local JWKS
// HTTP endpoint, against the migrated schema with real RLS. This is the
// strongest local check; it is NOT a live Supabase verification.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import request from 'supertest';
import { exportJWK, generateKeyPair, SignJWT, type KeyLike } from 'jose';
import { createApp } from '../../src/app';
import { createAccessTokenVerifier } from '../../src/lib/accessTokenVerifier';
import { logger } from '../../src/lib/logger';
import { PgHarnessProfileRepository } from '../helpers/pgHarnessProfileRepository';
import { PgHarnessScopedDbFactory } from '../helpers/pgHarnessScopedDb';
import { rebuildTestDatabase } from '../helpers/testDb';
import { seedScenario, SEED } from '../helpers/seed';
import { signTestToken } from '../helpers/jwt';

const ISSUER = 'https://devref.supabase.co/auth/v1';
let pool: Pool;
let server: Server;
let app: ReturnType<typeof createApp>;
let privateKey: KeyLike;
let jwksUp = true;

async function token(sub: string, overrides: { iss?: string; aud?: string; exp?: number; role?: string } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ role: overrides.role ?? 'authenticated', is_anonymous: false })
    .setProtectedHeader({ alg: 'ES256', kid: 'dev-key-1', typ: 'JWT' })
    .setIssuer(overrides.iss ?? ISSUER)
    .setAudience(overrides.aud ?? 'authenticated')
    .setSubject(sub)
    .setIssuedAt(now)
    .setExpirationTime(overrides.exp ?? now + 3600)
    .sign(privateKey);
}

beforeAll(async () => {
  pool = await rebuildTestDatabase('recipebook_api_test_layer12a1');
  await seedScenario(pool);
  const pair = await generateKeyPair('ES256', { extractable: true });
  privateKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'dev-key-1', alg: 'ES256', use: 'sig' };
  server = createServer((_req, res) => {
    if (!jwksUp) {
      res.statusCode = 503;
      res.end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const jwksUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/v1/.well-known/jwks.json`;
  app = createApp({
    profileRepository: new PgHarnessProfileRepository(pool),
    scopedDbFactory: new PgHarnessScopedDbFactory(pool),
    tokenVerifier: createAccessTokenVerifier({ mode: 'jwks', issuer: ISSUER, jwksUrl, jwksOptions: { cooldownMs: 0, cacheMaxAgeMs: 1 } }),
    logger,
  });
}, 60_000);

afterAll(async () => {
  await pool?.end();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('GET /v1/profiles with JWKS verification (12A.1 §11–12)', () => {
  it('accepts a valid ES256 token and returns only the caller’s own Profiles (identity from sub)', async () => {
    const res = await request(app).get('/v1/profiles').set('Authorization', `Bearer ${await token(SEED.accountA)}`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((p: { id: string }) => p.id)).toEqual([SEED.profileA]);
  });

  it.each([
    ['no token', async () => null],
    ['malformed token', async () => 'garbage.not.a.jwt'],
    ['expired token', async () => token(SEED.accountA, { exp: Math.floor(Date.now() / 1000) - 120 })],
    ['wrong issuer', async () => token(SEED.accountA, { iss: 'https://evil.example/auth/v1' })],
    ['wrong audience', async () => token(SEED.accountA, { aud: 'anon' })],
    ['legacy HS256 token', async () => signTestToken(SEED.accountA)],
  ])('%s -> 401 with a generic body', async (_label, make) => {
    const t = await make();
    const req = request(app).get('/v1/profiles');
    const res = await (t ? req.set('Authorization', `Bearer ${t}`) : req);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(res.body.error.message).toBe('Authentication is required.');
    expect(JSON.stringify(res.body)).not.toMatch(/jwks|kid|issuer|audience|expired|signature/i);
  });

  it('JWKS unreachable -> 503, not 401, so the app keeps the user signed in', async () => {
    jwksUp = false;
    try {
      const res = await request(app).get('/v1/profiles').set('Authorization', `Bearer ${await token(SEED.accountA)}`);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    } finally {
      jwksUp = true;
    }
  });

  it('GET /health needs no token', async () => {
    expect((await request(app).get('/health')).status).toBe(200);
  });
});
