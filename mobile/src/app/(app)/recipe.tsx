import { useLocalSearchParams, useRouter } from 'expo-router';

import { RecipeScreen } from '../../features/recipes/RecipeScreen';
import { Screen, Text } from '../../ui';
import { t } from '../../i18n';

export default function Recipe() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();
  if (!id) {
    return (
      <Screen>
        <Text variant="error">{t('error.not_found')}</Text>
      </Screen>
    );
  }
  return <RecipeScreen recipeId={id} onEdit={() => router.push({ pathname: '/recipe-edit', params: { id } })} />;
}
