import { useLocalSearchParams, useRouter } from 'expo-router';

import { ShoppingScreen } from '../../features/grocery/ShoppingScreen';
import { Screen, Text } from '../../ui';
import { t } from '../../i18n';

export default function Shopping() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();
  if (!id) {
    return (
      <Screen>
        <Text variant="error">{t('error.not_found')}</Text>
      </Screen>
    );
  }
  // A newer generation replaces this screen, so Back returns to where the list was opened.
  return <ShoppingScreen listId={id} onOpenList={(listId) => router.replace({ pathname: '/shopping', params: { id: listId } })} />;
}
