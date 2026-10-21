import { useLocalSearchParams, useRouter } from 'expo-router';

import { MealPlanScreen } from '../../features/plan/MealPlanScreen';
import { Screen, Text } from '../../ui';
import { t } from '../../i18n';

export default function MealPlan() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();
  if (!id) {
    return (
      <Screen>
        <Text variant="error">{t('error.not_found')}</Text>
      </Screen>
    );
  }
  return (
    <MealPlanScreen
      planId={id}
      onAddItem={(mealId) => router.push({ pathname: '/plan-item', params: { planId: id, mealId } })}
      onOpenList={(listId) => router.push({ pathname: '/shopping', params: { id: listId } })}
    />
  );
}
