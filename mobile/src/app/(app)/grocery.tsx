import { useRouter } from 'expo-router';

import { GroceryListsScreen } from '../../features/grocery/GroceryListsScreen';

export default function Grocery() {
  const router = useRouter();
  return <GroceryListsScreen onOpen={(id) => router.push({ pathname: '/shopping', params: { id } })} />;
}
