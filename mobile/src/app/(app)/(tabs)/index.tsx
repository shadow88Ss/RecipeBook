import { useRouter } from 'expo-router';

import { TodayScreen } from '../../../features/today/TodayScreen';

export default function Today() {
  const router = useRouter();
  return <TodayScreen onLog={() => router.navigate('/log')} />;
}
