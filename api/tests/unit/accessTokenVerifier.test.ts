// Layer 12A.1 — real asymmetric (ES256/RS256) signing and a real local JWKS
// HTTP endpoint; no verification step is mocked.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose';
import { createAccessTokenVerifier } from '../../src/lib/accessTokenVerifier';
import { signTestToken, TEST_JWT_SECRET } from '../helpers/jwt';

const ISSUER = 'https://devref.supabase.co/auth/v1';
const SUB = '5b0d6a0e-8c1f-4d7e-9b7a-2a1c3e4f5a6b';

interface Key {
  kid: string;
  alg: 'ES256' | 'RS256';
  privateKey: KeyLike;
  jwk: JWK;
}

async function makeKey(kid: string, alg: 'ES256' | 'RS256'): Promise<Key> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg, use: 'sig' };
  return { kid, alg, privateKey, jwk };
}

async function sign(key: Key, claims: Record<string, unknown> = {}, opts: { expSeconds?: number; kid?: string } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ role: 'authenticated', aal: 'aal1', session_id: 's1', is_anonymous: false, ...claims })
    .setProtectedHeader({ alg: key.alg, kid: opts.kid ?? key.kid, typ: 'JWT' })
    .setIssuer((claims.iss as string) ?? ISSUER)
    .setAudience((claims.aud as string) ?? 'authenticated')
    .setSubject((claims.sub as string) ?? SUB)
    .setIssuedAt(now)
    .setExpirationTime(now + (opts.expSeconds ?? 3600))
    .sign(key.privateKey);
}

let server: Server;
let jwksUrl: string;
let served: JWK[] = [];
let fetches = 0;
let failJwks = false;
let es: Key;
let rs: Key;
let rotated: Key;
let foreign: Key;

beforeAll(async () => {
  [es, rs, rotated, foreign] = await Promise.all([makeKey('es-1', 'ES256'), makeKey('rs-1', 'RS256'), makeKey('es-2', 'ES256'), makeKey('es-1', 'ES256')]);
  served = [es.jwk, rs.jwk];
  server = createServer((_req, res) => {
    fetches += 1;
    if (failJwks) {
      res.statusCode = 500;
      res.end('down');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ keys: served }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  jwksUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/v1/.well-known/jwks.json`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const jwksVerifier = (opts: { cooldownMs?: number; cacheMaxAgeMs?: number } = {}) =>
  createAccessTokenVerifier({ mode: 'jwks', issuer: ISSUER, jwksUrl, jwksOptions: { cooldownMs: opts.cooldownMs ?? 0, cacheMaxAgeMs: opts.cacheMaxAgeMs ?? 600_000, timeoutMs: 2000 } });

describe('Supabase JWKS verification (ES256/RS256)', () => {
  it('accepts valid ES256 and RS256 tokens and derives the account id from sub only', async () => {
    const v = jwksVerifier();
    await expect(v.verify(await sign(es))).resolves.toEqual({ ok: true, accountId: SUB });
    await expect(v.verify(await sign(rs))).resolves.toEqual({ ok: true, accountId: SUB });
  });

  it.each([
    ['expired', async () => sign(es, {}, { expSeconds: -120 })],
    ['wrong issuer', async () => sign(es, { iss: 'https://other.supabase.co/auth/v1' })],
    ['wrong audience (anon)', async () => sign(es, { aud: 'anon' })],
    ['anon role', async () => sign(es, { role: 'anon' })],
    ['service_role role', async () => sign(es, { role: 'service_role' })],
    ['non-UUID subject', async () => sign(es, { sub: 'not-a-uuid' })],
    ['anonymous user', async () => sign(es, { is_anonymous: true })],
    ['signed by an unknown key with a known kid', async () => sign(foreign)],
  ])('rejects %s as invalid', async (_label, make) => {
    await expect(jwksVerifier().verify(await make())).resolves.toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a tampered payload', async () => {
    const [h, p, s] = (await sign(es)).split('.') as [string, string, string];
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    payload.sub = '00000000-0000-4000-8000-000000000000';
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
    await expect(jwksVerifier().verify(forged)).resolves.toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects malformed tokens and alg "none"', async () => {
    const v = jwksVerifier();
    await expect(v.verify('not-a-jwt')).resolves.toEqual({ ok: false, reason: 'invalid' });
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: SUB, role: 'authenticated', aud: 'authenticated', iss: ISSUER, exp: 9999999999 })).toString('base64url')}.`;
    await expect(v.verify(none)).resolves.toEqual({ ok: false, reason: 'invalid' });
  });

  it('never accepts an HS256 token in jwks mode (no downgrade to the shared secret)', async () => {
    await expect(jwksVerifier().verify(signTestToken(SUB))).resolves.toEqual({ ok: false, reason: 'invalid' });
  });

  it('caches the JWKS instead of fetching per request', async () => {
    const v = jwksVerifier({ cooldownMs: 30_000 });
    const before = fetches;
    for (let i = 0; i < 5; i++) expect((await v.verify(await sign(es))).ok).toBe(true);
    expect(fetches - before).toBe(1);
  });

  it('picks up a rotated key: an unknown kid triggers one refetch', async () => {
    const v = jwksVerifier({ cooldownMs: 0 });
    expect((await v.verify(await sign(es))).ok).toBe(true);
    served = [es.jwk, rs.jwk, rotated.jwk];
    const before = fetches;
    expect(await v.verify(await sign(rotated))).toEqual({ ok: true, accountId: SUB });
    expect(fetches - before).toBe(1);
    served = [es.jwk, rs.jwk];
  });

  it('stops trusting a revoked key once the cache expires (no permanent stale key)', async () => {
    const v = jwksVerifier({ cooldownMs: 0, cacheMaxAgeMs: 50 });
    expect((await v.verify(await sign(rs))).ok).toBe(true);
    served = [es.jwk];
    await new Promise((r) => setTimeout(r, 80));
    expect(await v.verify(await sign(rs))).toEqual({ ok: false, reason: 'invalid' });
    served = [es.jwk, rs.jwk];
  });

  it('reports "unavailable" (not "invalid") when the JWKS cannot be fetched', async () => {
    failJwks = true;
    try {
      await expect(jwksVerifier().verify(await sign(es))).resolves.toEqual({ ok: false, reason: 'unavailable' });
    } finally {
      failJwks = false;
    }
    const unreachable = createAccessTokenVerifier({ mode: 'jwks', issuer: ISSUER, jwksUrl: 'http://127.0.0.1:1/jwks.json', jwksOptions: { timeoutMs: 500 } });
    await expect(unreachable.verify(await sign(es))).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });
});

describe('legacy HS256 and the migration mode', () => {
  it('legacy_hs256 accepts only HS256 and enforces the issuer when configured', async () => {
    const v = createAccessTokenVerifier({ mode: 'legacy_hs256', legacySecret: TEST_JWT_SECRET, issuer: ISSUER });
    // signTestToken carries no iss, so with an issuer configured it is rejected.
    await expect(v.verify(signTestToken(SUB))).resolves.toEqual({ ok: false, reason: 'invalid' });
    const withIss = createAccessTokenVerifier({ mode: 'legacy_hs256', legacySecret: TEST_JWT_SECRET });
    await expect(withIss.verify(signTestToken(SUB))).resolves.toEqual({ ok: true, accountId: SUB });
    await expect(withIss.verify(await sign(es))).resolves.toEqual({ ok: false, reason: 'invalid' });
  });

  it('jwks_with_legacy_hs256 routes by algorithm with each path pinned', async () => {
    const v = createAccessTokenVerifier({ mode: 'jwks_with_legacy_hs256', issuer: ISSUER, jwksUrl, legacySecret: TEST_JWT_SECRET, jwksOptions: { cooldownMs: 0 } });
    await expect(v.verify(await sign(es))).resolves.toEqual({ ok: true, accountId: SUB });
    // HS256 token without the configured issuer: rejected.
    await expect(v.verify(signTestToken(SUB))).resolves.toEqual({ ok: false, reason: 'invalid' });
    // HS256 signed with a different secret: rejected.
    await expect(v.verify(signTestToken(SUB, { secret: 'another-secret-value-123' }))).resolves.toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses incomplete configuration', () => {
    expect(() => createAccessTokenVerifier({ mode: 'jwks', jwksUrl })).toThrow(/issuer/);
    expect(() => createAccessTokenVerifier({ mode: 'jwks', issuer: ISSUER })).toThrow(/JWKS URL/);
    expect(() => createAccessTokenVerifier({ mode: 'legacy_hs256' })).toThrow(/legacy JWT secret/);
    expect(() => createAccessTokenVerifier({ mode: 'jwks_with_legacy_hs256', issuer: ISSUER, jwksUrl })).toThrow(/legacy JWT secret/);
  });
});
