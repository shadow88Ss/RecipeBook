import { useRouter } from 'expo-router';

import { ScanScreen } from '../../features/log/ScanScreen';

export default function Scan() {
  const router = useRouter();
  return (
    <ScanScreen
      onLogProduct={(id, barcode) => router.push({ pathname: '/log-item', params: { kind: 'product', id, ...(barcode ? { barcode } : {}) } })}
    />
  );
}
