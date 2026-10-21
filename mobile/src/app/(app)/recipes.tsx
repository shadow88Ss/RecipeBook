import { useRouter } from 'expo-router';

import { RecipesScreen } from '../../features/recipes/RecipesScreen';

export default function Recipes() {
  const router = useRouter();
  return <RecipesScreen onOpen={(id) => router.push({ pathname: '/recipe', params: { id } })} onNew={() => router.push('/recipe-edit')} />;
}
