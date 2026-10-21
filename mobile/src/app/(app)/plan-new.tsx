import { useRouter } from 'expo-router';

import { MealPlanCreateScreen } from '../../features/plan/MealPlanCreateScreen';

export default function PlanNew() {
  const router = useRouter();
  // After creating, show the plan the server returned (replacing this form).
  return <MealPlanCreateScreen onCreated={(id) => router.replace({ pathname: '/meal-plan', params: { id } })} />;
}
