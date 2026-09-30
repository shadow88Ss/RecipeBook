// Layer 12A §22 — Profile selection (shown only when there is more than one).

import { View } from 'react-native';

import { useAuth } from '../../auth/AuthProvider';
import { t } from '../../i18n';
import { useProfiles } from '../../profile/ProfileProvider';
import { scopeLabel } from '../../profile/scope';
import { Button, Card, EmptyState, ErrorState, LoadingState, Screen, Text } from '../../ui';

export function SelectProfileScreen() {
  const { status, profiles, error, select, refetch } = useProfiles();
  const { signOut } = useAuth();

  return (
    <Screen testID="select-profile-screen">
      <Text variant="title">{t('profiles.title')}</Text>
      <Text variant="muted">{t('profiles.subtitle')}</Text>
      {status === 'loading' || status === 'idle' ? <LoadingState /> : null}
      {status === 'error' ? <ErrorState error={error} onRetry={refetch} /> : null}
      {status === 'ready' && profiles.length === 0 ? <EmptyState message={t('profiles.empty')} /> : null}
      {status === 'ready'
        ? profiles.map((profile) => (
            <Card key={profile.id} testID={`profile-${profile.id}`}>
              <Text variant="heading">{profile.display_name}</Text>
              <Text variant="small">{scopeLabel(profile.access_scope)}</Text>
              {profile.is_child ? <Text variant="small">{t('profiles.child')}</Text> : null}
              <View>
                <Button label={profile.display_name} accessibilityHint={t('profiles.title')} onPress={() => select(profile.id)} testID={`select-${profile.id}`} />
              </View>
            </Card>
          ))
        : null}
      <Button label={t('auth.signOut')} onPress={() => void signOut()} variant="secondary" />
    </Screen>
  );
}
