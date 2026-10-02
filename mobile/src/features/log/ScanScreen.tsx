// Layer 12B — scan (or type) a barcode and look it up through
// GET /v1/products/barcode/{code}/lookup (internal Product first, then the
// routed external providers, all server-side).
//
//   internal            -> the canonical Product; normal Product logging.
//   external_candidate  -> shown as UNCONFIRMED provider information with the
//                          provider's attribution. It is never logged: there is
//                          no approved candidate -> Product confirmation
//                          workflow, and the API marks it `loggable: false`.
//   none                -> nothing found (and whether outside sources could be
//                          checked).

import { useQuery } from '@tanstack/react-query';
import { useState, type ComponentType } from 'react';

import { isApiError } from '../../api/errors';
import { lookupBarcode, type BarcodeLookup, type ExternalCandidate } from '../../barcode/barcode';
import { t } from '../../i18n';
import { useSelectedProfile } from '../../profile/ProfileProvider';
import { canLogMeals } from '../../profile/scope';
import { useServices } from '../../state/AppProviders';
import { queryKeys } from '../../state/queryClient';
import { Button, Card, ErrorState, Input, LoadingState, Notice, Screen, Text } from '../../ui';
import { CameraScanner, type ScannerProps } from './CameraScanner';
import { productLines } from './LogScreen';

export function ScanScreen({
  onLogProduct,
  Scanner = CameraScanner,
}: {
  onLogProduct: (productId: string, barcode: string | null) => void;
  /** Injectable for tests and devices without a camera. */
  Scanner?: ComponentType<ScannerProps>;
}) {
  const profile = useSelectedProfile();
  const { api } = useServices();
  const [code, setCode] = useState<string | null>(null);
  const [manual, setManual] = useState('');

  const lookup = useQuery({
    queryKey: queryKeys.barcode(code ?? ''),
    queryFn: ({ signal }) => lookupBarcode(api, code!, { signal }),
    enabled: code !== null,
    // A not-found or invalid code is an answer, not a transient failure.
    retry: false,
  });

  const reset = () => {
    setCode(null);
    setManual('');
  };

  return (
    <Screen testID="scan-screen">
      <Text variant="title">{t('scan.title')}</Text>
      <Scanner active={code === null} onScanned={setCode} />
      <Input label={t('scan.manual')} value={manual} onChangeText={setManual} keyboardType="number-pad" maxLength={64} testID="barcode-input" />
      <Button label={t('scan.lookup')} variant="secondary" disabled={!manual.trim().length} onPress={() => setCode(manual)} testID="barcode-submit" />

      {code !== null ? (
        <Text variant="small" testID="scanned-code">
          {t('scan.code', { code: code.trim() })}
        </Text>
      ) : null}
      {code !== null && lookup.isPending ? <LoadingState /> : null}
      {lookup.isError ? (
        isApiError(lookup.error) && lookup.error.kind === 'validation' ? (
          <Notice testID="barcode-invalid">{t('scan.invalid')}</Notice>
        ) : (
          <ErrorState error={lookup.error} onRetry={() => void lookup.refetch()} />
        )
      ) : null}
      {code !== null && lookup.data ? <LookupResult result={lookup.data} canLog={canLogMeals(profile.access_scope)} onLogProduct={onLogProduct} /> : null}
      {code !== null && !lookup.isPending ? <Button label={t('scan.again')} variant="secondary" onPress={reset} testID="scan-again" /> : null}
    </Screen>
  );
}

function LookupResult({ result, canLog, onLogProduct }: { result: BarcodeLookup; canLog: boolean; onLogProduct: (productId: string, barcode: string | null) => void }) {
  if (result.source === 'internal' && result.product) {
    const product = result.product;
    return (
      <Card testID="barcode-product">
        <Text variant="small">{`${t('scan.found')} · ${t('log.kind.product')}`}</Text>
        <Text variant="heading">{product.display_name}</Text>
        <Text variant="small">{product.brand_name}</Text>
        {productLines(product).map((line) => (
          <Text key={line} variant="small">
            {line}
          </Text>
        ))}
        {canLog ? (
          <Button label={t('scan.logProduct')} onPress={() => onLogProduct(product.id, result.submitted?.canonical_gtin ?? null)} testID="barcode-log-product" />
        ) : (
          <Notice>{t('log.readOnly')}</Notice>
        )}
      </Card>
    );
  }
  if (result.source === 'external_candidate' && result.candidates.length) {
    return (
      <>
        {result.candidates.map((candidate) => (
          <CandidateCard key={`${candidate.provider_key}:${candidate.external_product_id}`} candidate={candidate} />
        ))}
      </>
    );
  }
  return (
    <Card testID="barcode-none">
      <Text>{t('scan.none')}</Text>
      {result.external_lookup && result.external_lookup.status === 'temporarily_unavailable' ? <Text variant="small">{t('scan.sourcesUnavailable')}</Text> : null}
    </Card>
  );
}

/** Unconfirmed provider data: clearly labelled, attributed, and with no log action. */
function CandidateCard({ candidate }: { candidate: ExternalCandidate }) {
  const name = [candidate.brand_name, candidate.product_name, candidate.variant_name].filter(Boolean).join(' · ') || t('scan.candidate.unnamed');
  const { attribution, provider_record_url } = candidate.provenance;
  const link = attribution.link ?? provider_record_url;
  return (
    <Card testID="barcode-candidate">
      <Text variant="heading">{t('scan.candidate.title')}</Text>
      <Text testID="candidate-name">{name}</Text>
      <Notice testID="candidate-unconfirmed">{t('scan.candidate.body', { provider: attribution.text ?? candidate.provider_key })}</Notice>
      {attribution.text ? <Text variant="small">{t('scan.candidate.attribution', { text: attribution.text })}</Text> : null}
      {attribution.licence ? <Text variant="small">{t('scan.candidate.licence', { licence: attribution.licence })}</Text> : null}
      {link ? <Text variant="small">{t('scan.candidate.link', { link })}</Text> : null}
    </Card>
  );
}
