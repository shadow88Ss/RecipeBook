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

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  // Used by the production ProfileRepository (@supabase/supabase-js),
  // talking to Supabase's PostgREST/RPC endpoints with the caller's own
  // bearer token — never a service-role key (Layer 4A spec §17).
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),

  // HS256 shared secret used to locally verify Supabase Auth access tokens
  // (Project Settings → API → JWT Secret in a real Supabase project). Local
  // verification avoids a network round trip per request; PostgREST
  // performs its own independent verification of the same token when the
  // request reaches Supabase, so this is one layer of defense-in-depth, not
  // the only one (Layer 4A spec §3, §4).
  SUPABASE_JWT_SECRET: z.string().min(16),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

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
