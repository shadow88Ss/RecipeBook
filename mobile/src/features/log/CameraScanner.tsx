// Layer 12B — the camera barcode reader (expo-camera, included in Expo Go
// SDK 57). It only captures the barcode's text and hands it on: no
// normalization, check-digit validation or type guessing happens here (the
// API owns those rules). Product barcode symbologies only; QR codes are not
// read. Nothing is recorded or stored — no photo, video or audio.

import { CameraView, useCameraPermissions } from 'expo-camera';
import { useEffect, useRef } from 'react';
import { View } from 'react-native';

import { t } from '../../i18n';
import { Button, Text } from '../../ui';
import { theme } from '../../ui/theme';

export interface ScannerProps {
  /** Called once per detected code while `active` is true. */
  onScanned: (rawCode: string) => void;
  active: boolean;
}

const PRODUCT_SYMBOLOGIES = ['ean13', 'ean8', 'upc_a', 'upc_e', 'itf14'] as const;

export function CameraScanner({ onScanned, active }: ScannerProps) {
  const [permission, requestPermission] = useCameraPermissions();
  // The camera reports the same code many times per second; pass on one.
  const lastCode = useRef<string | null>(null);
  useEffect(() => {
    if (active) lastCode.current = null;
  }, [active]);

  if (!permission) return null;
  if (!permission.granted) {
    return (
      <View style={{ gap: theme.space.sm }} testID="camera-permission">
        <Text>{permission.canAskAgain ? t('scan.permission') : t('scan.denied')}</Text>
        {permission.canAskAgain ? <Button label={t('scan.allow')} onPress={() => void requestPermission()} testID="camera-allow" /> : null}
      </View>
    );
  }
  return (
    <View style={{ height: 260, borderRadius: theme.radius.md, overflow: 'hidden' }} testID="camera-view">
      <CameraView
        style={{ flex: 1 }}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: [...PRODUCT_SYMBOLOGIES] }}
        onBarcodeScanned={
          active
            ? ({ data }) => {
                if (!data || data === lastCode.current) return;
                lastCode.current = data;
                onScanned(data);
              }
            : undefined
        }
      />
    </View>
  );
}
