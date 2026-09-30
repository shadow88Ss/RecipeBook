import { Stack } from 'expo-router';

import { t } from '../../i18n';

export default function AppLayout() {
  return (
    <Stack>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="recipes" options={{ title: t('more.recipes') }} />
      <Stack.Screen name="plan" options={{ title: t('more.plan') }} />
      <Stack.Screen name="grocery" options={{ title: t('more.grocery') }} />
    </Stack>
  );
}
