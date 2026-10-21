import { useLocalSearchParams } from 'expo-router';

import { ShoppingScreen } from '../../features/grocery/ShoppingScreen';
import { Screen, Text } from '../../ui';
import { t } from '../../i18n';

export default function Shopping() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  if (!id) {
    return (
      <Screen>
        <Text variant="error">{t('error.not_found')}</Text>
      </Screen>
    );
  }
  return <ShoppingScreen listId={id} />;
}
