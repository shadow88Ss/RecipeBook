// Layer 12B — Log: search generic Foods (Layer 5A) or branded Products
// (Layer 11A) through the API, or scan a barcode. Search results come from the
// server as-is; nothing is ranked, merged or created on the device. A Profile
// whose access scope cannot log meals (view_only, or a scope the app does not
// know) gets no logging UI — the server enforces this regardless.

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import type { FoodSearchResult, ProductSearchResult } from '../../api/contracts/catalog';
import { searchFoods, searchProducts } from '../../api/endpoints';
import { formatNumber, t } from '../../i18n';
import { useSelectedProfile } from '../../profile/ProfileProvider';
import { canLogMeals } from '../../profile/scope';
import { useServices } from '../../state/AppProviders';
import { queryKeys } from '../../state/queryClient';
import { Button, Choice, ChoiceRow, EmptyState, ErrorState, Input, LoadingState, Notice, Row, Screen, Text } from '../../ui';

export type SearchKind = 'food' | 'product';

export function LogScreen({
  onOpenFood,
  onOpenProduct,
  onScan,
}: {
  onOpenFood: (foodId: string) => void;
  onOpenProduct: (productId: string) => void;
  onScan: () => void;
}) {
  const profile = useSelectedProfile();
  const { api } = useServices();
  const [kind, setKind] = useState<SearchKind>('food');
  const [text, setText] = useState('');
  const [submitted, setSubmitted] = useState<{ kind: SearchKind; q: string } | null>(null);

  const foods = useQuery({
    queryKey: queryKeys.foodSearch(submitted?.q ?? ''),
    queryFn: ({ signal }) => searchFoods(api, submitted!.q, signal),
    enabled: submitted?.kind === 'food',
  });
  const products = useQuery({
    queryKey: queryKeys.productSearch(submitted?.q ?? ''),
    queryFn: ({ signal }) => searchProducts(api, submitted!.q, signal),
    enabled: submitted?.kind === 'product',
  });

  if (!canLogMeals(profile.access_scope)) {
    return (
      <Screen testID="log-screen">
        <Text variant="title">{t('log.title')}</Text>
        <Notice testID="log-read-only">{t('log.readOnly')}</Notice>
      </Screen>
    );
  }

  const q = text.trim();
  const search = () => {
    if (q.length) setSubmitted({ kind, q });
  };
  const active = submitted?.kind === 'food' ? foods : submitted?.kind === 'product' ? products : null;

  return (
    <Screen testID="log-screen">
      <Text variant="title">{t('log.title')}</Text>
      <Text variant="muted">{profile.display_name}</Text>
      <Button label={t('log.scan')} variant="secondary" onPress={onScan} testID="open-scanner" />
      <ChoiceRow>
        <Choice label={t('log.searchFoods')} selected={kind === 'food'} onPress={() => setKind('food')} testID="search-kind-food" />
        <Choice label={t('log.searchProducts')} selected={kind === 'product'} onPress={() => setKind('product')} testID="search-kind-product" />
      </ChoiceRow>
      <Input
        label={t(`log.searchLabel.${kind}`)}
        value={text}
        onChangeText={setText}
        onSubmitEditing={search}
        returnKeyType="search"
        autoCorrect={false}
        maxLength={100}
        testID="search-input"
      />
      <Button label={t('log.search')} onPress={search} disabled={!q.length} testID="search-submit" />
      {!submitted ? <Text variant="small">{t('log.searchHint')}</Text> : null}
      {active?.isPending ? <LoadingState /> : null}
      {active?.isError ? <ErrorState error={active.error} onRetry={() => void active.refetch()} /> : null}
      {submitted?.kind === 'food' && foods.data ? (
        foods.data.data.length ? (
          foods.data.data.map((food) => <FoodRow key={food.id} food={food} onPress={() => onOpenFood(food.id)} />)
        ) : (
          <EmptyState message={t('log.noFoods', { q: submitted.q })} testID="search-empty" />
        )
      ) : null}
      {submitted?.kind === 'product' && products.data ? (
        products.data.data.length ? (
          products.data.data.map((product) => <ProductRow key={product.id} product={product} onPress={() => onOpenProduct(product.id)} />)
        ) : (
          <EmptyState message={t('log.noProducts', { q: submitted.q })} testID="search-empty" />
        )
      ) : null}
    </Screen>
  );
}

export function foodName(food: { display_name: string | null; canonical_name: string }): string {
  return food.display_name ?? food.canonical_name;
}

function FoodRow({ food, onPress }: { food: FoodSearchResult; onPress: () => void }) {
  const name = foodName(food);
  return (
    <Row onPress={onPress} accessibilityLabel={`${name}. ${t('log.kind.food')}`} testID={`food-${food.id}`}>
      <Text variant="heading">{name}</Text>
      <Text variant="small">{[t('log.kind.food'), food.category].filter(Boolean).join(' · ')}</Text>
      {food.match.identity_confirmation_required ? <Text variant="small">{t('log.identityCheck')}</Text> : null}
    </Row>
  );
}

export function productLines(product: Pick<ProductSearchResult, 'market' | 'package' | 'status'> & { active_barcodes?: string[] }): string[] {
  return [
    product.status === 'discontinued' ? t('log.discontinued') : null,
    product.market ? t('log.market', { market: product.market }) : null,
    product.package ? t('log.package', { quantity: formatNumber(product.package.quantity, 3), unit: product.package.unit ?? '' }) : null,
    product.active_barcodes?.length ? t('log.barcodes', { codes: product.active_barcodes.join(', ') }) : null,
  ].filter((line): line is string => !!line);
}

function ProductRow({ product, onPress }: { product: ProductSearchResult; onPress: () => void }) {
  return (
    <Row onPress={onPress} accessibilityLabel={`${product.display_name}. ${t('log.kind.product')}`} testID={`product-${product.id}`}>
      <Text variant="heading">{product.display_name}</Text>
      <Text variant="small">{`${t('log.kind.product')} · ${product.brand_name}`}</Text>
      {productLines(product).map((line) => (
        <Text key={line} variant="small">
          {line}
        </Text>
      ))}
    </Row>
  );
}
