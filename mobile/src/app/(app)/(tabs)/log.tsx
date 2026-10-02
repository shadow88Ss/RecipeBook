import { useRouter } from 'expo-router';

import { LogScreen } from '../../../features/log/LogScreen';

export default function Log() {
  const router = useRouter();
  return (
    <LogScreen
      onOpenFood={(id) => router.push({ pathname: '/log-item', params: { kind: 'food', id } })}
      onOpenProduct={(id) => router.push({ pathname: '/log-item', params: { kind: 'product', id } })}
      onScan={() => router.push('/scan')}
    />
  );
}
