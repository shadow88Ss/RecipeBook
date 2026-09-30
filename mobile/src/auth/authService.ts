// Layer 12A §9–12 — sign-in, sign-out, session restore and the access token.
//
// A thin layer over supabase-js: no custom password handling, no token
// minting and no second refresh implementation. The access token is read
// from Supabase on every API request (getSession refreshes when it must).

import { isAuthApiError, isAuthRetryableFetchError, type Session } from '@supabase/supabase-js';

import type { OAuthProvider } from '../config';
import type { SessionStorage } from './secureStorage';
import { SESSION_STORAGE_KEYS, type AuthClient } from './supabaseAuth';

export type SignInFailure = 'invalid_credentials' | 'email_not_confirmed' | 'network' | 'rate_limited' | 'unknown';
export type OAuthFailure = 'not_configured' | 'cancelled' | 'network' | 'unknown';

export type SignInResult = { ok: true } | { ok: false; reason: SignInFailure };
export type OAuthResult = { ok: true } | { ok: false; reason: OAuthFailure };

export interface OAuthBrowser {
  /** Opens the provider page and resolves with the redirect URL, or null if the user cancelled. */
  openAuthSession(url: string, redirectTo: string): Promise<string | null>;
  redirectUrl(): string;
}

export interface AuthService {
  restoreSession(): Promise<Session | null>;
  getAccessToken(): Promise<string | null>;
  signInWithPassword(email: string, password: string): Promise<SignInResult>;
  signInWithOAuth(provider: OAuthProvider): Promise<OAuthResult>;
  signOut(): Promise<void>;
  /** Local sign-out (scope: local) that always wipes secure storage; used when the API rejects the token. */
  clearLocalSession(): Promise<void>;
}

function mapSignInError(error: unknown): SignInFailure {
  if (isAuthRetryableFetchError(error)) return 'network';
  if (isAuthApiError(error)) {
    if (error.status === 429) return 'rate_limited';
    if (error.code === 'email_not_confirmed') return 'email_not_confirmed';
    if (error.code === 'invalid_credentials' || error.status === 400) return 'invalid_credentials';
  }
  return 'unknown';
}

export function createAuthService(
  auth: AuthClient,
  storage: SessionStorage,
  options: { oauthProviders: readonly OAuthProvider[]; browser?: OAuthBrowser },
): AuthService {
  async function wipeStorage() {
    for (const key of SESSION_STORAGE_KEYS) {
      try {
        await storage.removeItem(key);
      } catch {
        // Best effort: a keychain error must not keep the user signed in.
      }
    }
  }

  async function clearLocalSession() {
    try {
      await auth.signOut({ scope: 'local' });
    } catch {
      // ignored — storage is wiped below either way
    }
    await wipeStorage();
  }

  return {
    async restoreSession() {
      const { data, error } = await auth.getSession();
      if (error) return null;
      return data.session;
    },

    async getAccessToken() {
      const { data, error } = await auth.getSession();
      if (error || !data.session) return null;
      return data.session.access_token;
    },

    async signInWithPassword(email, password) {
      try {
        const { error } = await auth.signInWithPassword({ email: email.trim(), password });
        if (error) return { ok: false, reason: mapSignInError(error) };
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: mapSignInError(error) };
      }
    },

    async signInWithOAuth(provider) {
      // §21: Google/Apple need provider configuration in Supabase (external
      // config). Until an environment declares them, they are refused here.
      if (!options.oauthProviders.includes(provider) || !options.browser) {
        return { ok: false, reason: 'not_configured' };
      }
      try {
        const redirectTo = options.browser.redirectUrl();
        const { data, error } = await auth.signInWithOAuth({ provider, options: { redirectTo, skipBrowserRedirect: true } });
        if (error || !data.url) return { ok: false, reason: isAuthRetryableFetchError(error) ? 'network' : 'unknown' };
        const returned = await options.browser.openAuthSession(data.url, redirectTo);
        if (!returned) return { ok: false, reason: 'cancelled' };
        const code = new URL(returned).searchParams.get('code');
        if (!code) return { ok: false, reason: 'unknown' };
        const exchanged = await auth.exchangeCodeForSession(code);
        return exchanged.error ? { ok: false, reason: 'unknown' } : { ok: true };
      } catch {
        return { ok: false, reason: 'unknown' };
      }
    },

    async signOut() {
      try {
        // Revokes the refresh token server-side when reachable; supabase-js
        // removes the local session even if that call fails.
        await auth.signOut();
      } catch {
        // ignored — the local session is cleared below regardless
      }
      await clearLocalSession();
    },

    clearLocalSession,
  };
}
