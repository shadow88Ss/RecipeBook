// Layer 4A — startup environment validation.
//
// Fails loudly and immediately at boot if required configuration is
// missing, rather than allowing a partially-configured server to accept
// traffic. Note what is deliberately NOT here: no direct Postgres
// connection string. The production code path never opens a raw database
// connection at all — it only ever holds the Supabase anon key plus, per
// request, the caller's own verified access token (see
// src/domain/profiles/profile.repository.ts) — so there is no elevated
// database credential for the app to misuse or leak.

import { z } from 'zod';
import { JWT_VERIFICATION_MODES } from '../lib/accessTokenVerifier';

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  // Used by the production ProfileRepository (@supabase/supabase-js),
  // talking to Supabase's PostgREST/RPC endpoints with the caller's own
  // bearer token — never a service-role key (Layer 4A spec §17).
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),

  // Layer 12A.1 — how Supabase access tokens are verified (no default: the
  // deployment must choose). See src/lib/accessTokenVerifier.ts and
  // docs/37_Authentication_and_Login.md §16.
  //   jwks                    current Supabase JWT signing keys (ES256/RS256)
  //   legacy_hs256            legacy shared secret only (local stack / tests)
  //   jwks_with_legacy_hs256  migration window between the two
  SUPABASE_JWT_VERIFICATION: z.enum(JWT_VERIFICATION_MODES),

  // Legacy HS256 shared secret (Project Settings -> JWT Keys -> Legacy JWT
  // Secret). Required only by the legacy modes; never used by `jwks`.
  SUPABASE_JWT_SECRET: z.string().min(16).optional(),

  // Defaults: `${SUPABASE_URL}/auth/v1` and its /.well-known/jwks.json.
  SUPABASE_JWT_ISSUER: z.string().url().optional(),
  SUPABASE_JWKS_URL: z.string().url().optional(),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

const envSchema = baseSchema
  .superRefine((env, ctx) => {
    if (env.SUPABASE_JWT_VERIFICATION !== 'jwks' && !env.SUPABASE_JWT_SECRET) {
      ctx.addIssue({ code: 'custom', path: ['SUPABASE_JWT_SECRET'], message: `required when SUPABASE_JWT_VERIFICATION=${env.SUPABASE_JWT_VERIFICATION}` });
    }
    const jwks = env.SUPABASE_JWKS_URL ?? `${jwtIssuer(env)}/.well-known/jwks.json`;
    if (env.NODE_ENV === 'production' && env.SUPABASE_JWT_VERIFICATION !== 'legacy_hs256' && !jwks.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['SUPABASE_JWKS_URL'], message: 'must use https in production' });
    }
  })
  .transform((env) => {
    const issuer = jwtIssuer(env);
    return { ...env, SUPABASE_JWT_ISSUER: issuer, SUPABASE_JWKS_URL: env.SUPABASE_JWKS_URL ?? `${issuer}/.well-known/jwks.json` };
  });

function jwtIssuer(env: { SUPABASE_URL: string; SUPABASE_JWT_ISSUER?: string | undefined }): string {
  return (env.SUPABASE_JWT_ISSUER ?? `${env.SUPABASE_URL.replace(/\/+$/, '')}/auth/v1`).replace(/\/+$/, '');
}

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return result.data;
}

let cached: Env | undefined;

/** Memoized: parses process.env once per process. */
export function getEnv(): Env {
  if (!cached) {
    cached = parseEnv(process.env);
  }
  return cached;
}
