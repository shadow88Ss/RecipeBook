// Layer 12A — wiring of the non-React services (built once per app start).

import { createApiClient, type ApiClient } from '../api/client';
import { createAuthService, type AuthService, type OAuthBrowser } from '../auth/authService';
import { createSecureSessionStorage, type SecureKeyValueStore, type SessionStorage } from '../auth/secureStorage';
import { createAuthClient, type AuthClient } from '../auth/supabaseAuth';
import type { AppConfig } from '../config';

export interface Services {
  config: AppConfig;
  auth: AuthClient;
  authService: AuthService;
  api: ApiClient;
  storage: SessionStorage;
  /** The auth layer registers what happens when the API answers 401. */
  setUnauthorizedHandler(handler: () => void | Promise<void>): void;
}

export function createServices(
  config: AppConfig,
  deps: { secureStore?: SecureKeyValueStore; fetch?: typeof fetch; supabaseFetch?: typeof fetch; browser?: OAuthBrowser } = {},
): Services {
  const storage = createSecureSessionStorage(deps.secureStore);
  const auth = createAuthClient(config, storage, deps.supabaseFetch ? { fetch: deps.supabaseFetch } : {});
  const authService = createAuthService(auth, storage, { oauthProviders: config.oauthProviders, browser: deps.browser });
  let unauthorized: () => void | Promise<void> = () => undefined;
  const api = createApiClient({
    baseUrl: config.apiBaseUrl,
    getAccessToken: () => authService.getAccessToken(),
    onUnauthorized: () => unauthorized(),
    fetch: deps.fetch,
  });
  return {
    config,
    auth,
    authService,
    api,
    storage,
    setUnauthorizedHandler(handler) {
      unauthorized = handler;
    },
  };
}
