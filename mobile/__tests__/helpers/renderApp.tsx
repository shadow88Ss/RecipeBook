import { QueryClient } from '@tanstack/react-query';
import { render } from '@testing-library/react-native';
import type { ReactElement } from 'react';

import { useAuth } from '../../src/auth/AuthProvider';
import { AUTH_STORAGE_KEY } from '../../src/auth/supabaseAuth';
import { createSecureSessionStorage } from '../../src/auth/secureStorage';
import type { AppConfig } from '../../src/config';
import { SignInScreen } from '../../src/features/auth/SignInScreen';
import { SelectProfileScreen } from '../../src/features/profile/SelectProfileScreen';
import { useProfiles } from '../../src/profile/ProfileProvider';
import { AppProviders } from '../../src/state/AppProviders';
import { navigationGate } from '../../src/state/navigationGate';
import { createServices } from '../../src/state/services';
import { LoadingState } from '../../src/ui';
import { TEST_CONFIG } from './fixtures';
import { fakeFetch, sessionPayload, type Call } from './fakeServer';
import { memorySecureStore } from './memorySecureStore';

/** Mirrors the root layout's guards without the native navigator. */
function Gate({ app }: { app: ReactElement }) {
  const auth = useAuth();
  const { selected } = useProfiles();
  const gate = navigationGate(auth.status, !!selected);
  if (gate === 'restoring') return <LoadingState />;
  if (gate === 'auth') return <SignInScreen />;
  if (gate === 'select-profile') return <SelectProfileScreen />;
  return app;
}

export async function renderApp(
  app: ReactElement,
  opts: { routes?: Record<string, (call: Call) => Response | Promise<Response>>; signedIn?: boolean; config?: Partial<AppConfig> } = {},
) {
  const store = memorySecureStore();
  if (opts.signedIn !== false) {
    await createSecureSessionStorage(store).setItem(AUTH_STORAGE_KEY, JSON.stringify(sessionPayload()));
  }
  const server = fakeFetch(opts.routes ?? {});
  const services = createServices({ ...TEST_CONFIG, ...opts.config }, { secureStore: store, fetch: server.fetch, supabaseFetch: server.fetch });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const utils = await render(
    <AppProviders services={services} queryClient={queryClient}>
      <Gate app={app} />
    </AppProviders>,
  );
  return { ...utils, store, server, services, queryClient };
}
