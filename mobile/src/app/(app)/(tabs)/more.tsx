import { useRouter } from 'expo-router';

import { MoreScreen } from '../../../features/misc/screens';

export default function More() {
  const router = useRouter();
  return <MoreScreen onOpen={(area) => router.push(`/${area}`)} />;
}
