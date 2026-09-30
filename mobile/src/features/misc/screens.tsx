// Layer 12A §19, §27 — shells for areas built in later layers, plus the
// Profile/Settings and configuration-error screens.

import { useAuth } from '../../auth/AuthProvider';
import { t, type MessageKey } from '../../i18n';
import { useProfiles, useSelectedProfile } from '../../profile/ProfileProvider';
import { scopeLabel } from '../../profile/scope';
import { useServices } from '../../state/AppProviders';
import { Button, Card, Screen, Text } from '../../ui';

export function PlaceholderScreen({ titleKey, testID }: { titleKey: MessageKey; testID?: string }) {
  return (
    <Screen testID={testID}>
      <Text variant="title">{t(titleKey)}</Text>
      <Text variant="muted">{t('common.comingSoon')}</Text>
    </Screen>
  );
}

/** §27: the Log area is a shell in 12A; logging and the scanner are Layer 12B. */
export function LogScreen() {
  return (
    <Screen testID="log-screen">
      <Text variant="title">{t('log.title')}</Text>
      <Text variant="muted">{t('log.body')}</Text>
    </Screen>
  );
}

export function MoreScreen({ onOpen }: { onOpen: (area: 'recipes' | 'plan' | 'grocery') => void }) {
  return (
    <Screen testID="more-screen">
      <Text variant="title">{t('more.title')}</Text>
      <Button label={t('more.recipes')} variant="secondary" onPress={() => onOpen('recipes')} />
      <Button label={t('more.plan')} variant="secondary" onPress={() => onOpen('plan')} />
      <Button label={t('more.grocery')} variant="secondary" onPress={() => onOpen('grocery')} />
    </Screen>
  );
}

export function ProfileSettingsScreen() {
  const { email, signOut } = useAuth();
  const { profiles, clearSelection } = useProfiles();
  const profile = useSelectedProfile();
  const { config } = useServices();
  return (
    <Screen testID="profile-screen">
      <Text variant="title">{t('profile.title')}</Text>
      {email ? <Text variant="muted">{t('profile.signedInAs', { email })}</Text> : null}
      <Card>
        <Text variant="small">{t('profile.current')}</Text>
        <Text variant="heading">{profile.display_name}</Text>
        <Text variant="small" testID="current-scope">
          {scopeLabel(profile.access_scope)}
        </Text>
      </Card>
      {profiles.length > 1 ? <Button label={t('profiles.switch')} variant="secondary" onPress={clearSelection} testID="switch-profile" /> : null}
      <Button label={t('auth.signOut')} onPress={() => void signOut()} testID="sign-out" />
      <Text variant="small">{t('profile.environment', { env: config.environment })}</Text>
    </Screen>
  );
}

/** §7: shown instead of the app when the build's environment is invalid. */
export function ConfigErrorScreen({ issues, showDetails }: { issues: string[]; showDetails: boolean }) {
  return (
    <Screen testID="config-error-screen">
      <Text variant="title">{t('config.title')}</Text>
      <Text>{t('config.body')}</Text>
      {showDetails
        ? issues.map((issue) => (
            <Text key={issue} variant="error">
              {`• ${issue}`}
            </Text>
          ))
        : null}
    </Screen>
  );
}
