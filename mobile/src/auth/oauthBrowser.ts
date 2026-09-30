// Layer 12A §21 — the in-app browser half of Google/Apple sign-in (PKCE).
// Wired up, but only used when the environment lists a provider that has been
// configured in Supabase — which is external configuration not yet done.

import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';

import type { OAuthBrowser } from './authService';

export const expoOAuthBrowser: OAuthBrowser = {
  redirectUrl: () => Linking.createURL('auth/callback'),
  async openAuthSession(url, redirectTo) {
    const result = await WebBrowser.openAuthSessionAsync(url, redirectTo);
    return result.type === 'success' ? result.url : null;
  },
};
