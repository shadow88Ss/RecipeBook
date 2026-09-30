import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../src/config/env';

const base = { SUPABASE_URL: 'https://devref.supabase.co/', SUPABASE_ANON_KEY: 'sb_publishable_x' };

describe('API environment — JWT verification mode (Layer 12A.1)', () => {
  it('requires an explicit verification mode', () => {
    expect(() => parseEnv({ ...base, SUPABASE_JWT_SECRET: 'x'.repeat(32) })).toThrow(/SUPABASE_JWT_VERIFICATION/);
  });

  it('derives the Supabase issuer and JWKS URL for jwks mode and needs no shared secret', () => {
    const env = parseEnv({ ...base, SUPABASE_JWT_VERIFICATION: 'jwks' });
    expect(env.SUPABASE_JWT_ISSUER).toBe('https://devref.supabase.co/auth/v1');
    expect(env.SUPABASE_JWKS_URL).toBe('https://devref.supabase.co/auth/v1/.well-known/jwks.json');
    expect(env.SUPABASE_JWT_SECRET).toBeUndefined();
  });

  it('requires the legacy secret for the legacy modes', () => {
    expect(() => parseEnv({ ...base, SUPABASE_JWT_VERIFICATION: 'legacy_hs256' })).toThrow(/SUPABASE_JWT_SECRET/);
    expect(() => parseEnv({ ...base, SUPABASE_JWT_VERIFICATION: 'jwks_with_legacy_hs256' })).toThrow(/SUPABASE_JWT_SECRET/);
    expect(parseEnv({ ...base, SUPABASE_JWT_VERIFICATION: 'legacy_hs256', SUPABASE_JWT_SECRET: 'x'.repeat(32) }).SUPABASE_JWT_VERIFICATION).toBe('legacy_hs256');
  });

  it('requires an https JWKS URL in production', () => {
    expect(() => parseEnv({ ...base, NODE_ENV: 'production', SUPABASE_JWT_VERIFICATION: 'jwks', SUPABASE_JWKS_URL: 'http://127.0.0.1:54321/auth/v1/.well-known/jwks.json' })).toThrow(/https/);
  });

  it('rejects an unknown mode', () => {
    expect(() => parseEnv({ ...base, SUPABASE_JWT_VERIFICATION: 'none' })).toThrow();
  });
});
