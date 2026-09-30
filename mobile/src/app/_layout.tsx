// Root layout: validates configuration, builds the services once and guards
// the two flows — Auth (signed out) and App (signed in with a Profile).

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';

import { expoOAuthBrowser } from '../auth/oauthBrowser';
import { useAuth } from '../auth/AuthProvider';
import { configResult } from '../config';
import { ConfigErrorScreen } from '../features/misc/screens';
import { t } from '../i18n';
import { useProfiles } from '../profile/ProfileProvider';
import { AppProviders } from '../state/AppProviders';
import { navigationGate } from '../state/navigationGate';
import { createServices } from '../state/services';
import { LoadingState } from '../ui';
import type { AppConfig } from '../config';

export default function RootLayout() {
  if (!configResult.ok) {
    return <ConfigErrorScreen issues={configResult.issues} showDetails={__DEV__} />;
  }
  return <ConfiguredApp config={configResult.config} />;
}

function ConfiguredApp({ config }: { config: AppConfig }) {
  const [services] = useState(() => createServices(config, { browser: expoOAuthBrowser }));
  return (
    <AppProviders services={services}>
      <StatusBar style="dark" />
      <RootNavigator />
    </AppProviders>
  );
}

function RootNavigator() {
  const auth = useAuth();
  const { selected } = useProfiles();
  const gate = navigationGate(auth.status, !!selected);
  if (gate === 'restoring') return <LoadingState label={t('auth.restoring')} />;
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={gate === 'auth'}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
      <Stack.Protected guard={gate === 'select-profile'}>
        <Stack.Screen name="select-profile" />
      </Stack.Protected>
      <Stack.Protected guard={gate === 'app'}>
        <Stack.Screen name="(app)" />
      </Stack.Protected>
    </Stack>
  );
}
