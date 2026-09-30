// Layer 4A — production entrypoint. Wires the real, network-backed
// ProfileRepository (never the test harness, which lives under tests/ and
// is never imported from here).

import { createApp } from './app';
import { getEnv } from './config/env';
import { createAccessTokenVerifier } from './lib/accessTokenVerifier';
import { logger } from './lib/logger';
import { SupabaseRestProfileRepository } from './domain/profiles/supabaseRestProfileRepository';
import { SupabaseScopedDbFactory } from './lib/supabaseScopedDb';

const env = getEnv();

const tokenVerifier = createAccessTokenVerifier({
  mode: env.SUPABASE_JWT_VERIFICATION,
  issuer: env.SUPABASE_JWT_ISSUER,
  jwksUrl: env.SUPABASE_JWKS_URL,
  ...(env.SUPABASE_JWT_VERIFICATION !== 'jwks' && env.SUPABASE_JWT_SECRET ? { legacySecret: env.SUPABASE_JWT_SECRET } : {}),
});
if (env.SUPABASE_JWT_VERIFICATION !== 'jwks') {
  logger.warn({ mode: env.SUPABASE_JWT_VERIFICATION }, 'Legacy HS256 access-token verification is enabled; migrate the Supabase project to JWT signing keys and use SUPABASE_JWT_VERIFICATION=jwks');
}

const app = createApp({
  profileRepository: new SupabaseRestProfileRepository(env.SUPABASE_URL, env.SUPABASE_ANON_KEY),
  scopedDbFactory: new SupabaseScopedDbFactory(env.SUPABASE_URL, env.SUPABASE_ANON_KEY),
  tokenVerifier,
  logger,
});

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, nodeEnv: env.NODE_ENV, jwtVerification: env.SUPABASE_JWT_VERIFICATION }, 'API listening');
});
