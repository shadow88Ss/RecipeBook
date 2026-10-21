import { useRouter } from 'expo-router';

import { MealPlansScreen } from '../../features/plan/MealPlansScreen';

export default function Plans() {
  const router = useRouter();
  return <MealPlansScreen onOpen={(id) => router.push({ pathname: '/meal-plan', params: { id } })} />;
}
