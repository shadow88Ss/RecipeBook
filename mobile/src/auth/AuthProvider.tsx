// Layer 12A §9–12, §20 — auth state for the UI.
//
// Session truth comes from Supabase (restore on launch, onAuthStateChange for
// sign-in/refresh/sign-out). Tokens are never put in React state that is
// rendered or logged; screens only see status, user id and email.

import type { Session } from '@supabase/supabase-js';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import type { OAuthProvider } from '../config';
import { useServices } from '../state/AppProviders';
import type { OAuthResult, SignInResult } from './authService';

export type AuthStatus = 'restoring' | 'signed_out' | 'signed_in';
export type AuthNotice = 'session_expired' | null;

export interface AuthContextValue {
  status: AuthStatus;
  userId: string | null;
  email: string | null;
  notice: AuthNotice;
  signInWithPassword(email: string, password: string): Promise<SignInResult>;
  signInWithOAuth(provider: OAuthProvider): Promise<OAuthResult>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}

interface AuthState {
  status: AuthStatus;
  userId: string | null;
  email: string | null;
}

const fromSession = (session: Session | null): AuthState =>
  session ? { status: 'signed_in', userId: session.user.id, email: session.user.email ?? null } : { status: 'signed_out', userId: null, email: null };

export function AuthProvider({ children }: { children: ReactNode }) {
  const { auth, authService, setUnauthorizedHandler } = useServices();
  const queryClient = useQueryClient();
  const [state, setState] = useState<AuthState>({ status: 'restoring', userId: null, email: null });
  const [notice, setNotice] = useState<AuthNotice>(null);
  const expiring = useRef(false);

  useEffect(() => {
    let active = true;
    authService.restoreSession().then((session) => {
      if (active) setState((prev) => (prev.status === 'restoring' ? fromSession(session) : prev));
    });
    const { data } = auth.onAuthStateChange((_event, session) => {
      if (active) setState(fromSession(session));
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, [auth, authService]);

  // Supabase refreshes tokens in the background only while the app is in the foreground.
  useEffect(() => {
    if (AppState.currentState === 'active') void auth.startAutoRefresh();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') void auth.startAutoRefresh();
      else void auth.stopAutoRefresh();
    });
    return () => {
      sub.remove();
      void auth.stopAutoRefresh();
    };
  }, [auth]);

  // §12, §16: the API rejected the token (revoked, expired beyond refresh,
  // deleted user). Clear the local session and cached data, then show sign-in.
  useEffect(() => {
    setUnauthorizedHandler(async () => {
      if (expiring.current) return;
      expiring.current = true;
      try {
        await authService.clearLocalSession();
        queryClient.clear();
        setNotice('session_expired');
        setState(fromSession(null));
      } finally {
        expiring.current = false;
      }
    });
    return () => setUnauthorizedHandler(() => undefined);
  }, [authService, queryClient, setUnauthorizedHandler]);

  const signInWithPassword = useCallback(
    async (email: string, password: string) => {
      const result = await authService.signInWithPassword(email, password);
      if (result.ok) setNotice(null);
      return result;
    },
    [authService],
  );

  const signInWithOAuth = useCallback(
    async (provider: OAuthProvider) => {
      const result = await authService.signInWithOAuth(provider);
      if (result.ok) setNotice(null);
      return result;
    },
    [authService],
  );

  const signOut = useCallback(async () => {
    await authService.signOut();
    queryClient.clear();
    setNotice(null);
    setState(fromSession(null));
  }, [authService, queryClient]);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, notice, signInWithPassword, signInWithOAuth, signOut }),
    [state, notice, signInWithPassword, signInWithOAuth, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
