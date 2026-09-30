import { QueryClient } from '@tanstack/react-query';
import { act, render } from '@testing-library/react-native';
import { useEffect, type ReactElement } from 'react';
import * as ReactNative from 'react-native';

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

// React Native exposes its components through lazy getters: the first access
// compiles and loads each component's module tree. On a cold transform cache
// that costs seconds (ScrollView alone ~2.7 s), which used to land inside the
// FIRST rendering test's 5 s timeout and made it fail intermittently. Load the
// components the app renders once, when this helper is imported (outside any
// test's timeout), so every test measures the app rather than module loading.
for (const component of ['View', 'Text', 'ScrollView', 'Pressable', 'ActivityIndicator', 'TextInput', 'AppState'] as const) {
  if (!ReactNative[component]) throw new Error(`react-native does not export ${component}`);
}

/** Mirrors the root layout's guards without the native navigator, and reports
 * when AuthProvider has finished restoring the stored session. */
function Gate({ app, onAuthSettled }: { app: ReactElement; onAuthSettled: () => void }) {
  const auth = useAuth();
  const { selected } = useProfiles();
  useEffect(() => {
    if (auth.status !== 'restoring') onAuthSettled();
  }, [auth.status, onAuthSettled]);
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
  let settle!: () => void;
  const authSettled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const utils = await render(
    <AppProviders services={services} queryClient={queryClient}>
      <Gate app={app} onAuthSettled={settle} />
    </AppProviders>,
  );
  // Deterministic start state: return only once the session restore has
  // completed and the gate has left `restoring` (signed_in or signed_out),
  // instead of each test racing it with findBy* polling windows. If restore
  // never settles, the test fails at its own timeout — nothing is hidden.
  await act(async () => {
    await authSettled;
  });
  return { ...utils, store, server, services, queryClient };
}
