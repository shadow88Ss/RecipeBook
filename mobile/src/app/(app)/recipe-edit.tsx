import { useLocalSearchParams, useRouter } from 'expo-router';

import { RecipeEditScreen } from '../../features/recipes/RecipeEditScreen';

export default function RecipeEdit() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();
  // After saving, show the recipe the server returned (replacing this form).
  return <RecipeEditScreen recipeId={id || undefined} onSaved={(savedId) => router.replace({ pathname: '/recipe', params: { id: savedId } })} />;
}
