import { useLocalSearchParams, useRouter } from 'expo-router';

import { LogItemScreen, type LogTarget } from '../../features/log/LogItemScreen';
import { Screen, Text } from '../../ui';
import { t } from '../../i18n';

export default function LogItem() {
  const router = useRouter();
  const params = useLocalSearchParams<{ kind?: string; id?: string; barcode?: string }>();
  const target: LogTarget | null =
    params.kind === 'food' && params.id
      ? { kind: 'food', id: params.id }
      : params.kind === 'product' && params.id
        ? { kind: 'product', id: params.id, barcode: params.barcode ?? null }
        : null;
  if (!target) {
    return (
      <Screen>
        <Text variant="error">{t('error.not_found')}</Text>
      </Screen>
    );
  }
  // After logging, return to Today, which re-reads the Daily Tracker from the API.
  return <LogItemScreen target={target} onLogged={() => router.navigate('/')} />;
}
