import { useLocalSearchParams } from 'expo-router';

import { MealPlanScreen } from '../../features/plan/MealPlanScreen';
import { Screen, Text } from '../../ui';
import { t } from '../../i18n';

export default function MealPlan() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  if (!id) {
    return (
      <Screen>
        <Text variant="error">{t('error.not_found')}</Text>
      </Screen>
    );
  }
  return <MealPlanScreen planId={id} />;
}
