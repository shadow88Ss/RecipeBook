import { useRouter } from 'expo-router';

import { RecipeImportScreen } from '../../features/recipes/RecipeImportScreen';

export default function RecipeImport() {
  const router = useRouter();
  // After saving (or for a recipe already imported), show the recipe in place of this screen.
  const open = (id: string) => router.replace({ pathname: '/recipe', params: { id } });
  return <RecipeImportScreen onSaved={open} onOpenRecipe={open} />;
}
