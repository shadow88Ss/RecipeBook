// Layer 4A — production entrypoint. Wires the real, network-backed
// ProfileRepository (never the test harness, which lives under tests/ and
// is never imported from here).

import { createApp } from './app';
import { getEnv } from './config/env';
import { logger } from './lib/logger';
import { SupabaseRestProfileRepository } from './domain/profiles/supabaseRestProfileRepository';
import { SupabaseScopedDbFactory } from './lib/supabaseScopedDb';

const env = getEnv();

const app = createApp({
  profileRepository: new SupabaseRestProfileRepository(env.SUPABASE_URL, env.SUPABASE_ANON_KEY),
  scopedDbFactory: new SupabaseScopedDbFactory(env.SUPABASE_URL, env.SUPABASE_ANON_KEY),
  jwtSecret: env.SUPABASE_JWT_SECRET,
  logger,
});

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, nodeEnv: env.NODE_ENV }, 'API listening');
});
