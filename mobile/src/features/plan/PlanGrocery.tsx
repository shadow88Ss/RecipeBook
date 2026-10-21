// Layer 12F — a plan's grocery list. The preview
// (GET …/meal-plans/{plan}/grocery-preview) is what the server derives from
// the plan now; nothing is stored. A draft plan previews its unconfirmed
// items. An active plan previews exactly what a new list would hold; scopes
// that can plan make the list (POST …/grocery-lists, no body) and then shop
// it on the existing shopping screen. Quantities are the server's; an amount
// it could not work out says so.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { View } from 'react-native';

import type { GroceryRequirement } from '../../api/contracts/groceries';
import { generateGroceryList, getGroceryPreview } from '../../api/endpoints';
import { t, tp } from '../../i18n';
import { useSelectedProfile } from '../../profile/ProfileProvider';
import { canPlanMeals } from '../../profile/scope';
import { useServices } from '../../state/AppProviders';
import { queryKeys } from '../../state/queryClient';
import { Button, Card, ErrorState, LoadingState, Notice, Text, errorMessage } from '../../ui';
import { theme } from '../../ui/theme';
import { amountText } from '../grocery/ShoppingScreen';

export function requirementText(item: GroceryRequirement): string {
  return item.quantity !== null && item.unit ? amountText({ quantity: item.quantity, unit: item.unit }) : t('grocery.fromPlanUnresolved');
}

export function PlanGrocery({ planId, status, onOpenList }: { planId: string; status: string; onOpenList: (listId: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: theme.space.sm }} testID="plan-grocery">
      <Text variant="heading">{t('planGrocery.title')}</Text>
      <Button label={open ? t('planGrocery.hide') : t('planGrocery.show')} variant="secondary" onPress={() => setOpen(!open)} testID="plan-grocery-toggle" />
      {open ? <GroceryPreviewView planId={planId} status={status} onOpenList={onOpenList} /> : null}
    </View>
  );
}

function GroceryPreviewView({ planId, status, onOpenList }: { planId: string; status: string; onOpenList: (listId: string) => void }) {
  const profile = useSelectedProfile();
  const { api } = useServices();
  const client = useQueryClient();
  const preview = useQuery({
    queryKey: queryKeys.groceryPreview(profile.id, planId),
    queryFn: ({ signal }) => getGroceryPreview(api, profile.id, planId, signal),
  });
  const generate = useMutation({
    mutationFn: () => generateGroceryList(api, profile.id, planId),
    onSuccess: async (list) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: queryKeys.groceryPreview(profile.id, planId) }),
        client.invalidateQueries({ queryKey: queryKeys.groceryLists(profile.id) }),
      ]);
      onOpenList(list.id);
    },
  });

  if (preview.isPending) return <LoadingState />;
  if (preview.isError) return <ErrorState error={preview.error} onRetry={() => void preview.refetch()} />;
  const data = preview.data;
  const canMake = status === 'active' && canPlanMeals(profile.access_scope);
  const current = data.current_grocery_list;
  const left = data.excluded_unconfirmed_sources.length;

  return (
    <View style={{ gap: theme.space.sm }}>
      {status === 'draft' ? <Notice testID="grocery-draft-note">{t('planGrocery.draftNote')}</Notice> : null}
      {status === 'active' && left ? (
        <Text variant="small" testID="grocery-excluded">
          {tp('planGrocery.excluded', left, { count: left })}
        </Text>
      ) : null}
      {current ? (
        <Card testID="grocery-current">
          <Text>{t('grocery.generation', { number: current.generation_number })}</Text>
          {current.is_stale ? <Notice testID="grocery-current-stale">{t('grocery.staleNote')}</Notice> : null}
          <Button label={t('planGrocery.open')} onPress={() => onOpenList(current.id)} testID="grocery-open" />
        </Card>
      ) : null}
      {canMake && (!current || current.is_stale) ? (
        <Button
          label={current ? t('planGrocery.remake') : t('planGrocery.make')}
          variant={current ? 'secondary' : 'primary'}
          onPress={() => !generate.isPending && generate.mutate()}
          disabled={generate.isPending || !data.items.length}
          testID="grocery-generate"
        />
      ) : null}
      {generate.isError ? (
        <Text variant="error" testID="grocery-generate-error">
          {errorMessage(generate.error)}
        </Text>
      ) : null}
      <Text variant="small">{status === 'draft' ? t('planGrocery.previewDraft') : t('planGrocery.previewActive')}</Text>
      {!data.items.length ? (
        <Text variant="muted" testID="grocery-preview-empty">
          {t('planGrocery.empty')}
        </Text>
      ) : null}
      {data.items.map((item, index) => (
        <View key={index} accessible accessibilityLabel={`${item.display_name}. ${requirementText(item)}`} testID={`grocery-req-${index}`}>
          <Text>{item.display_name}</Text>
          <Text variant="small">{requirementText(item)}</Text>
        </View>
      ))}
    </View>
  );
}
