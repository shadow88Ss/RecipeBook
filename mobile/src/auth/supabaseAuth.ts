// Layer 12A §5, §9 — Supabase Auth is the only auth authority.
//
// The official supabase-js client is created here and ONLY its `auth` module
// leaves this file: the app never uses Supabase for data (every data read and
// write goes through the MyRecipeBook /v1 API).

import 'react-native-url-polyfill/auto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { AppConfig } from '../config';
import type { SessionStorage } from './secureStorage';

export type AuthClient = SupabaseClient['auth'];

export const AUTH_STORAGE_KEY = 'myrecipebook-auth';

/** Every key supabase-js may write for this app's session. Cleared on sign-out. */
export const SESSION_STORAGE_KEYS = [AUTH_STORAGE_KEY, `${AUTH_STORAGE_KEY}-code-verifier`, `${AUTH_STORAGE_KEY}-user`] as const;

export function createAuthClient(
  config: Pick<AppConfig, 'supabaseUrl' | 'supabaseAnonKey'>,
  storage: SessionStorage,
  options: { fetch?: typeof fetch } = {},
): AuthClient {
  const client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      storage,
      storageKey: AUTH_STORAGE_KEY,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      flowType: 'pkce',
    },
    ...(options.fetch ? { global: { fetch: options.fetch } } : {}),
  });
  return client.auth;
}
