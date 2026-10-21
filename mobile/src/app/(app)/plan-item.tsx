import { useLocalSearchParams, useRouter } from 'expo-router';

import { PlanItemScreen } from '../../features/plan/PlanItemScreen';
import { Screen, Text } from '../../ui';
import { t } from '../../i18n';

export default function PlanItem() {
  const router = useRouter();
  const { planId, mealId } = useLocalSearchParams<{ planId?: string; mealId?: string }>();
  if (!planId || !mealId) {
    return (
      <Screen>
        <Text variant="error">{t('error.not_found')}</Text>
      </Screen>
    );
  }
  // The plan screen underneath already holds the updated plan.
  return <PlanItemScreen planId={planId} mealId={mealId} onDone={() => router.back()} />;
}
