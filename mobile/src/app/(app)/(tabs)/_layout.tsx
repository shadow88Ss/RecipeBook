import Tabs from 'expo-router/js-tabs';

import { t } from '../../../i18n';

// Text-labelled tabs (no icon-only meaning); Today/Log/Progress/Profile first.
export default function TabsLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false, tabBarIcon: () => null, tabBarLabelStyle: { fontSize: 14 } }}>
      <Tabs.Screen name="index" options={{ title: t('tabs.today'), tabBarAccessibilityLabel: t('tabs.today') }} />
      <Tabs.Screen name="log" options={{ title: t('tabs.log'), tabBarAccessibilityLabel: t('tabs.log') }} />
      <Tabs.Screen name="progress" options={{ title: t('tabs.progress'), tabBarAccessibilityLabel: t('tabs.progress') }} />
      <Tabs.Screen name="more" options={{ title: t('tabs.more'), tabBarAccessibilityLabel: t('tabs.more') }} />
      <Tabs.Screen name="profile" options={{ title: t('tabs.profile'), tabBarAccessibilityLabel: t('tabs.profile') }} />
    </Tabs>
  );
}
