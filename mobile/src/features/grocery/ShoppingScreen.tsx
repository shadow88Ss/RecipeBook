// Layer 12C — shopping a grocery list (GET .../grocery-lists/{list}/shopping).
//
// Each item shows what the server derived: the amount the plan needs, what is
// still to buy, and its status in words. The app does no arithmetic: "Bought"
// sends the server's own remaining amount back as the purchase, "Check off"
// records a plain check-off for an item with no quantity, and "Undo" revokes
// the latest purchase (kept as history on the server). Every write returns
// the new shopping view, which replaces the cached one.
//
// Write buttons appear only when the server says the list can take state
// (`state_writable`: the current generation of an active or completed plan)
// AND the Profile's scope records shopping. The server decides regardless.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { View } from 'react-native';

import type { ManualShoppingItem, ShoppingAmount, ShoppingItem, ShoppingView } from '../../api/contracts/groceries';
import { getShoppingView, recordPurchase, revokePurchase, type ShoppingLine } from '../../api/endpoints';
import { en } from '../../i18n/en';
import { formatNumber, t, type MessageKey } from '../../i18n';
import { useSelectedProfile } from '../../profile/ProfileProvider';
import { canRecordShopping } from '../../profile/scope';
import { useServices } from '../../state/AppProviders';
import { queryKeys } from '../../state/queryClient';
import { Button, Card, ErrorState, LoadingState, Notice, Screen, Text, errorMessage } from '../../ui';
import { theme } from '../../ui/theme';
import { listTitle } from './GroceryListsScreen';

type Action = { kind: 'buy'; line: ShoppingLine; amount: ShoppingAmount | null } | { kind: 'undo'; purchaseId: string };

export function ShoppingScreen({ listId }: { listId: string }) {
  const profile = useSelectedProfile();
  const { api } = useServices();
  const client = useQueryClient();
  const key = queryKeys.shopping(profile.id, listId);
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => getShoppingView(api, profile.id, listId, signal) });
  const mutation = useMutation({
    mutationFn: (action: Action) =>
      action.kind === 'buy' ? recordPurchase(api, profile.id, listId, action.line, action.amount) : revokePurchase(api, profile.id, listId, action.purchaseId),
    onSuccess: (view) => client.setQueryData(key, view),
  });

  const view = query.data;
  const writable = !!view?.state_writable && canRecordShopping(profile.access_scope);
  const act = (action: Action) => {
    if (!mutation.isPending) mutation.mutate(action);
  };

  return (
    <Screen testID="shopping-screen">
      {query.isPending ? <LoadingState /> : null}
      {query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : null}
      {view ? (
        <>
          <Text variant="title">{listTitle(view.grocery_list)}</Text>
          <Text variant="small">{t('grocery.generation', { number: view.grocery_list.generation_number })}</Text>
          <ListNotices view={view} canWrite={canRecordShopping(profile.access_scope)} />
          {mutation.isError ? (
            <Text variant="error" testID="shopping-write-error">
              {errorMessage(mutation.error)}
            </Text>
          ) : null}
          {!view.items.length && !view.manual_items.length ? <Text variant="muted">{t('grocery.noItems')}</Text> : null}
          {view.items.map((item) => (
            <ItemCard key={item.grocery_list_item_id} item={item} writable={writable} busy={mutation.isPending} onAct={act} />
          ))}
          {view.manual_items.length ? <Text variant="heading">{t('grocery.manualTitle')}</Text> : null}
          {view.manual_items.map((item) => (
            <ManualCard key={item.grocery_manual_item_id} item={item} writable={writable} busy={mutation.isPending} onAct={act} />
          ))}
        </>
      ) : null}
    </Screen>
  );
}

function ListNotices({ view, canWrite }: { view: ShoppingView; canWrite: boolean }) {
  const list = view.grocery_list;
  return (
    <>
      {!list.is_current_generation ? <Notice testID="list-superseded">{t('grocery.supersededNote')}</Notice> : null}
      {list.is_current_generation && list.is_stale ? <Notice testID="list-stale">{t('grocery.staleNote')}</Notice> : null}
      {list.is_current_generation && !view.state_writable ? <Notice testID="list-read-only">{t('grocery.notWritable')}</Notice> : null}
      {view.state_writable && !canWrite ? <Notice testID="scope-read-only">{t('grocery.scopeReadOnly')}</Notice> : null}
    </>
  );
}

/** "300 g", "2" (count) — the server's number with display rounding only. */
export function amountText(amount: ShoppingAmount): string {
  const n = formatNumber(amount.quantity, 1);
  return amount.unit === 'count' ? t('grocery.count', { quantity: n }) : `${n} ${amount.unit}`;
}

export function shoppingStatusText(status: string): string {
  const key = `grocery.status.${status}`;
  return key in en ? t(key as MessageKey) : status;
}

type Progress = Pick<ShoppingItem, 'status' | 'purchase_mode' | 'remaining_to_purchase' | 'shopping_target' | 'over_purchased'>;

/** The latest purchase still in effect, for Undo. */
const latestActive = (purchases: ShoppingItem['history']['purchases']) =>
  [...purchases].filter((p) => p.revoked_at === null).sort((a, b) => (a.recorded_at < b.recorded_at ? 1 : a.recorded_at > b.recorded_at ? -1 : 0))[0] ?? null;

function ProgressLines({ progress, testID }: { progress: Progress; testID: string }) {
  return (
    <>
      <Text variant="small" testID={`${testID}-status`}>
        {shoppingStatusText(progress.status)}
      </Text>
      {progress.shopping_target ? <Text variant="small">{t('grocery.toBuy', { amount: amountText(progress.shopping_target) })}</Text> : null}
      {progress.remaining_to_purchase && progress.status === 'partially_purchased' ? (
        <Text variant="small" testID={`${testID}-remaining`}>
          {t('grocery.remaining', { amount: amountText(progress.remaining_to_purchase) })}
        </Text>
      ) : null}
      {progress.over_purchased ? <Text variant="small">{t('grocery.overBought', { amount: amountText(progress.over_purchased) })}</Text> : null}
    </>
  );
}

function Actions({ line, progress, purchases, busy, onAct, testID }: { line: ShoppingLine; progress: Progress; purchases: ShoppingItem['history']['purchases']; busy: boolean; onAct: (a: Action) => void; testID: string }) {
  const last = latestActive(purchases);
  const remaining = progress.remaining_to_purchase;
  const canBuy = progress.purchase_mode === 'check_off' ? progress.status !== 'purchased' : !!remaining && remaining.quantity > 0;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
      {canBuy ? (
        <Button
          label={progress.purchase_mode === 'check_off' ? t('grocery.checkOff') : t('grocery.bought', { amount: amountText(remaining!) })}
          onPress={() => onAct({ kind: 'buy', line, amount: progress.purchase_mode === 'check_off' ? null : remaining })}
          disabled={busy}
          testID={`${testID}-buy`}
        />
      ) : null}
      {last ? <Button label={t('grocery.undo')} variant="secondary" onPress={() => onAct({ kind: 'undo', purchaseId: last.id })} disabled={busy} testID={`${testID}-undo`} /> : null}
    </View>
  );
}

function ItemCard({ item, writable, busy, onAct }: { item: ShoppingItem; writable: boolean; busy: boolean; onAct: (a: Action) => void }) {
  const id = `shopping-item-${item.grocery_list_item_id}`;
  const fromPlan = item.generated_quantity ? t('grocery.fromPlan', { amount: amountText(item.generated_quantity) }) : t('grocery.fromPlanUnresolved');
  return (
    <Card testID={id} accessibilityLabel={`${item.display_name}. ${fromPlan}. ${shoppingStatusText(item.status)}`}>
      <Text variant="heading">{item.display_name}</Text>
      <Text variant="small" testID={`${id}-plan`}>
        {fromPlan}
      </Text>
      {item.already_have ? <Text variant="small">{t('grocery.alreadyHave', { amount: amountText(item.already_have.input) })}</Text> : null}
      <ProgressLines progress={item} testID={id} />
      {writable ? <Actions line={{ kind: 'item', id: item.grocery_list_item_id }} progress={item} purchases={item.history.purchases} busy={busy} onAct={onAct} testID={id} /> : null}
    </Card>
  );
}

function ManualCard({ item, writable, busy, onAct }: { item: ManualShoppingItem; writable: boolean; busy: boolean; onAct: (a: Action) => void }) {
  const id = `shopping-manual-${item.grocery_manual_item_id}`;
  return (
    <Card testID={id} accessibilityLabel={`${item.name}. ${t('grocery.manual')}. ${shoppingStatusText(item.status)}`}>
      <Text variant="heading">{item.name}</Text>
      <Text variant="small">{t('grocery.manual')}</Text>
      {item.notes ? <Text variant="small">{item.notes}</Text> : null}
      <ProgressLines progress={item} testID={id} />
      {writable ? <Actions line={{ kind: 'manual', id: item.grocery_manual_item_id }} progress={item} purchases={item.purchases} busy={busy} onAct={onAct} testID={id} /> : null}
    </Card>
  );
}
