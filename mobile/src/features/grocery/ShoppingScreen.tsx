// Layer 12C — shopping a grocery list (GET .../grocery-lists/{list}/shopping).
//
// Each item shows what the server derived: the amount the plan needs, what is
// still to buy, and its status in words. The app does no arithmetic: "Bought"
// sends the server's own remaining amount back as the purchase, "Check off"
// records a plain check-off for an item with no quantity, and "Undo" revokes
// the latest purchase (kept as history on the server). Every write returns
// the new shopping view, which replaces the cached one.
//
// Layer 12F completes the workflow (docs/30_API.md §24): what you already
// have, the amount you intend to buy, a purchase of an amount you type, and
// manual items (add, buy, remove). These are user facts sent as typed; the
// server normalizes them, works out need, target and remaining, and says when
// amounts cannot be compared. A stale current list can be regenerated from an
// active plan: the new generation starts clean (the server carries nothing
// forward) and this one becomes read-only, which the app says before asking.
//
// Write buttons appear only when the server says the list can take state
// (`state_writable`: the current generation of an active or completed plan)
// AND the Profile's scope records shopping. The server decides regardless.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { View } from 'react-native';

import type { UnitList } from '../../api/contracts/catalog';
import type { ManualItemInput, ManualShoppingItem, ShoppingAmount, ShoppingItem, ShoppingView, UserQuantity } from '../../api/contracts/groceries';
import {
  addManualItem,
  clearItemQuantity,
  generateGroceryList,
  getShoppingView,
  listUnits,
  recordPurchase,
  removeManualItem,
  revokePurchase,
  setItemQuantity,
  type ShoppingLine,
  type UserQuantityKind,
} from '../../api/endpoints';
import { en } from '../../i18n/en';
import { formatNumber, t, type MessageKey } from '../../i18n';
import { useSelectedProfile } from '../../profile/ProfileProvider';
import { canRecordShopping } from '../../profile/scope';
import { useServices } from '../../state/AppProviders';
import { queryKeys } from '../../state/queryClient';
import { Button, Card, Choice, ChoiceRow, ErrorState, Input, LoadingState, Notice, Screen, Text, errorMessage } from '../../ui';
import { theme } from '../../ui/theme';
import { OFFERED_UNITS } from '../log/LogItemScreen';
import { listTitle } from './GroceryListsScreen';

type Action =
  | { kind: 'buy'; line: ShoppingLine; amount: ShoppingAmount | null }
  | { kind: 'undo'; purchaseId: string }
  | { kind: 'set'; itemId: string; which: UserQuantityKind; value: UserQuantity }
  | { kind: 'clear'; itemId: string; which: UserQuantityKind }
  | { kind: 'addManual'; input: ManualItemInput }
  | { kind: 'removeManual'; manualId: string };

type Act = (action: Action, onDone?: () => void) => void;

export function ShoppingScreen({ listId, onOpenList }: { listId: string; onOpenList?: (listId: string) => void }) {
  const profile = useSelectedProfile();
  const { api } = useServices();
  const client = useQueryClient();
  const key = queryKeys.shopping(profile.id, listId);
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => getShoppingView(api, profile.id, listId, signal) });
  const mutation = useMutation({
    mutationFn: (action: Action): Promise<ShoppingView> => {
      switch (action.kind) {
        case 'buy':
          return recordPurchase(api, profile.id, listId, action.line, action.amount);
        case 'undo':
          return revokePurchase(api, profile.id, listId, action.purchaseId);
        case 'set':
          return setItemQuantity(api, profile.id, listId, action.itemId, action.which, action.value);
        case 'clear':
          return clearItemQuantity(api, profile.id, listId, action.itemId, action.which);
        case 'addManual':
          return addManualItem(api, profile.id, listId, action.input);
        case 'removeManual':
          return removeManualItem(api, profile.id, listId, action.manualId);
      }
    },
    onSuccess: (view) => client.setQueryData(key, view),
  });

  const view = query.data;
  const canWrite = canRecordShopping(profile.access_scope);
  const writable = !!view?.state_writable && canWrite;
  const act: Act = (action, onDone) => {
    if (!mutation.isPending) mutation.mutate(action, { onSuccess: () => onDone?.() });
  };

  return (
    <Screen testID="shopping-screen">
      {query.isPending ? <LoadingState /> : null}
      {query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : null}
      {view ? (
        <>
          <Text variant="title">{listTitle(view.grocery_list)}</Text>
          <Text variant="small">{t('grocery.generation', { number: view.grocery_list.generation_number })}</Text>
          <ListNotices view={view} canWrite={canWrite} onOpenList={onOpenList} />
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
          {writable ? <AddManual busy={mutation.isPending} onAct={act} /> : null}
        </>
      ) : null}
    </Screen>
  );
}

function ListNotices({ view, canWrite, onOpenList }: { view: ShoppingView; canWrite: boolean; onOpenList?: (listId: string) => void }) {
  const list = view.grocery_list;
  const newer = list.superseded_by_grocery_list_id;
  return (
    <>
      {!list.is_current_generation ? <Notice testID="list-superseded">{t('grocery.supersededNote')}</Notice> : null}
      {!list.is_current_generation && newer && onOpenList ? (
        <Button label={t('grocery.openNewer')} variant="secondary" onPress={() => onOpenList(newer)} testID="list-open-newer" />
      ) : null}
      {list.is_current_generation && list.is_stale ? <Notice testID="list-stale">{t('grocery.staleNote')}</Notice> : null}
      {list.is_current_generation && list.is_stale && list.current_plan_status === 'active' && canWrite && onOpenList ? (
        <Regenerate planId={list.meal_plan_id} onOpenList={onOpenList} />
      ) : null}
      {list.is_current_generation && !view.state_writable ? <Notice testID="list-read-only">{t('grocery.notWritable')}</Notice> : null}
      {view.state_writable && !canWrite ? <Notice testID="scope-read-only">{t('grocery.scopeReadOnly')}</Notice> : null}
    </>
  );
}

/** A new generation from the plan as it is now; this list stays as it is, read-only. */
function Regenerate({ planId, onOpenList }: { planId: string; onOpenList: (listId: string) => void }) {
  const profile = useSelectedProfile();
  const { api } = useServices();
  const client = useQueryClient();
  const [asking, setAsking] = useState(false);
  const generate = useMutation({
    mutationFn: () => generateGroceryList(api, profile.id, planId),
    onSuccess: async (list) => {
      await Promise.all([
        client.invalidateQueries({ queryKey: ['shopping', profile.id] }),
        client.invalidateQueries({ queryKey: queryKeys.groceryLists(profile.id) }),
        client.invalidateQueries({ queryKey: queryKeys.groceryPreview(profile.id, planId) }),
      ]);
      onOpenList(list.id);
    },
  });
  return (
    <Card testID="list-regenerate">
      {asking ? (
        <>
          <Notice testID="list-regenerate-warning">{t('grocery.regenerateWarning')}</Notice>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
            <Button label={t('grocery.regenerateYes')} onPress={() => !generate.isPending && generate.mutate()} disabled={generate.isPending} testID="list-regenerate-yes" />
            <Button label={t('recipeEdit.cancel')} variant="secondary" onPress={() => setAsking(false)} testID="list-regenerate-no" />
          </View>
        </>
      ) : (
        <Button label={t('planGrocery.remake')} variant="secondary" onPress={() => setAsking(true)} testID="list-regenerate-start" />
      )}
      {generate.isError ? (
        <Text variant="error" testID="list-regenerate-error">
          {errorMessage(generate.error)}
        </Text>
      ) : null}
    </Card>
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

/**
 * Units offered for an amount typed against `base` (the server's unit for the
 * item): the registry's units of the same dimension, `count` for a count, and
 * every offered unit plus `count` when the item has no amount. Only which
 * units to offer is decided here; the server converts and compares.
 */
export function unitChoices(base: string | null, units: UnitList['data']): string[] {
  if (base === 'count') return ['count'];
  const offered = OFFERED_UNITS.filter((code) => units.some((u) => u.code === code));
  const dimension = base ? units.find((u) => u.code === base)?.dimension : undefined;
  if (base && !dimension) return [base];
  return dimension ? offered.filter((code) => units.find((u) => u.code === code)?.dimension === dimension) : [...offered, 'count'];
}

/** Reads a typed amount; `allowZero` for already-have and shopping quantity ("none"). Parsing only. */
export function parseAmount(text: string, allowZero: boolean): number | null {
  const value = Number(text.trim().replace(',', '.'));
  if (!text.trim().length || !Number.isFinite(value)) return null;
  return value > 0 || (allowZero && value === 0) ? value : null;
}

function AmountForm({
  title,
  base,
  allowZero,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
  testID,
}: {
  title: string;
  base: string | null;
  allowZero: boolean;
  submitLabel: string;
  busy: boolean;
  onSubmit: (value: UserQuantity) => void;
  onCancel: () => void;
  testID: string;
}) {
  const { api } = useServices();
  const units = useQuery({ queryKey: queryKeys.units(), queryFn: ({ signal }) => listUnits(api, signal), staleTime: Infinity, enabled: base !== 'count' });
  const choices = base === 'count' ? ['count'] : units.data ? unitChoices(base, units.data.data) : [];
  const [unit, setUnit] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [touched, setTouched] = useState(false);
  const chosen = unit ?? (base && choices.includes(base) ? base : (choices[0] ?? null));
  const quantity = parseAmount(text, allowZero);
  return (
    <Card testID={testID}>
      <Text variant="heading">{title}</Text>
      {base !== 'count' && units.isPending ? <LoadingState /> : null}
      {units.isError ? <ErrorState error={units.error} onRetry={() => void units.refetch()} /> : null}
      <ChoiceRow>
        {choices.map((code) => (
          <Choice key={code} label={code === 'count' ? t('grocery.unitCount') : code} selected={chosen === code} onPress={() => setUnit(code)} testID={`${testID}-unit-${code}`} />
        ))}
      </ChoiceRow>
      <Input label={t('grocery.amountLabel')} value={text} onChangeText={setText} keyboardType="decimal-pad" testID={`${testID}-quantity`} />
      {touched && (quantity === null || !chosen) ? <Text variant="error">{allowZero ? t('grocery.error.amountOrZero') : t('grocery.error.amount')}</Text> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
        <Button
          label={submitLabel}
          onPress={() => {
            setTouched(true);
            if (quantity !== null && chosen && !busy) onSubmit({ quantity, unit: chosen });
          }}
          disabled={busy}
          testID={`${testID}-save`}
        />
        <Button label={t('recipeEdit.cancel')} variant="secondary" onPress={onCancel} testID={`${testID}-cancel`} />
      </View>
    </Card>
  );
}

type Progress = Pick<ShoppingItem, 'status' | 'purchase_mode' | 'remaining_to_purchase' | 'shopping_target' | 'over_purchased'> & { shopping_target_source?: string | null };

/** The latest purchase still in effect, for Undo. */
const latestActive = (purchases: ShoppingItem['history']['purchases']) =>
  [...purchases].filter((p) => p.revoked_at === null).sort((a, b) => (a.recorded_at < b.recorded_at ? 1 : a.recorded_at > b.recorded_at ? -1 : 0))[0] ?? null;

function ProgressLines({ progress, testID }: { progress: Progress; testID: string }) {
  const adjusted = progress.shopping_target_source === 'user_adjusted';
  return (
    <>
      <Text variant="small" testID={`${testID}-status`}>
        {shoppingStatusText(progress.status)}
      </Text>
      {progress.shopping_target ? (
        <Text variant="small" testID={`${testID}-target`}>
          {t(adjusted ? 'grocery.toBuyAdjusted' : 'grocery.toBuy', { amount: amountText(progress.shopping_target) })}
        </Text>
      ) : null}
      {progress.remaining_to_purchase && progress.status === 'partially_purchased' ? (
        <Text variant="small" testID={`${testID}-remaining`}>
          {t('grocery.remaining', { amount: amountText(progress.remaining_to_purchase) })}
        </Text>
      ) : null}
      {progress.over_purchased ? <Text variant="small">{t('grocery.overBought', { amount: amountText(progress.over_purchased) })}</Text> : null}
    </>
  );
}

type Editing = 'have' | 'target' | 'buy' | null;

function Actions({
  line,
  progress,
  purchases,
  busy,
  onAct,
  onBuyAmount,
  testID,
}: {
  line: ShoppingLine;
  progress: Progress;
  purchases: ShoppingItem['history']['purchases'];
  busy: boolean;
  onAct: Act;
  onBuyAmount: () => void;
  testID: string;
}) {
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
      {progress.purchase_mode === 'quantity' ? <Button label={t('grocery.boughtOther')} variant="secondary" onPress={onBuyAmount} disabled={busy} testID={`${testID}-buy-amount`} /> : null}
      {last ? <Button label={t('grocery.undo')} variant="secondary" onPress={() => onAct({ kind: 'undo', purchaseId: last.id })} disabled={busy} testID={`${testID}-undo`} /> : null}
    </View>
  );
}

function ItemCard({ item, writable, busy, onAct }: { item: ShoppingItem; writable: boolean; busy: boolean; onAct: Act }) {
  const [editing, setEditing] = useState<Editing>(null);
  const id = `shopping-item-${item.grocery_list_item_id}`;
  const itemId = item.grocery_list_item_id;
  const line: ShoppingLine = { kind: 'item', id: itemId };
  const fromPlan = item.generated_quantity ? t('grocery.fromPlan', { amount: amountText(item.generated_quantity) }) : t('grocery.fromPlanUnresolved');
  // Amounts are typed against the item's own base unit when it has one.
  const base = item.generated_quantity?.unit ?? item.shopping_target?.unit ?? null;
  const close = () => setEditing(null);
  const adjusted = item.shopping_target_source === 'user_adjusted';
  return (
    <Card testID={id} accessibilityLabel={`${item.display_name}. ${fromPlan}. ${shoppingStatusText(item.status)}`}>
      <Text variant="heading">{item.display_name}</Text>
      <Text variant="small" testID={`${id}-plan`}>
        {fromPlan}
      </Text>
      {item.already_have ? (
        <Text variant="small" testID={`${id}-have`}>
          {t('grocery.alreadyHave', { amount: amountText(item.already_have.input) })}
        </Text>
      ) : null}
      <ProgressLines progress={item} testID={id} />
      {writable ? (
        <>
          <Actions line={line} progress={item} purchases={item.history.purchases} busy={busy} onAct={onAct} onBuyAmount={() => setEditing('buy')} testID={id} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
            <Button label={item.already_have ? t('grocery.changeHave') : t('grocery.setHave')} variant="secondary" onPress={() => setEditing('have')} disabled={busy} testID={`${id}-have-edit`} />
            {item.already_have ? (
              <Button label={t('grocery.clearHave')} variant="secondary" onPress={() => onAct({ kind: 'clear', itemId, which: 'already-have' })} disabled={busy} testID={`${id}-have-clear`} />
            ) : null}
            <Button label={t('grocery.setTarget')} variant="secondary" onPress={() => setEditing('target')} disabled={busy} testID={`${id}-target-edit`} />
            {adjusted ? (
              <Button label={t('grocery.clearTarget')} variant="secondary" onPress={() => onAct({ kind: 'clear', itemId, which: 'shopping-quantity' })} disabled={busy} testID={`${id}-target-clear`} />
            ) : null}
          </View>
          {editing === 'have' ? (
            <AmountForm
              title={t('grocery.setHave')}
              base={base}
              allowZero
              submitLabel={t('grocery.save')}
              busy={busy}
              onSubmit={(value) => onAct({ kind: 'set', itemId, which: 'already-have', value }, close)}
              onCancel={close}
              testID={`${id}-have-form`}
            />
          ) : null}
          {editing === 'target' ? (
            <AmountForm
              title={t('grocery.setTarget')}
              base={base}
              allowZero
              submitLabel={t('grocery.save')}
              busy={busy}
              onSubmit={(value) => onAct({ kind: 'set', itemId, which: 'shopping-quantity', value }, close)}
              onCancel={close}
              testID={`${id}-target-form`}
            />
          ) : null}
          {editing === 'buy' ? (
            <AmountForm
              title={t('grocery.boughtOther')}
              base={base}
              allowZero={false}
              submitLabel={t('grocery.recordPurchase')}
              busy={busy}
              onSubmit={(value) => onAct({ kind: 'buy', line, amount: value }, close)}
              onCancel={close}
              testID={`${id}-buy-form`}
            />
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

function ManualCard({ item, writable, busy, onAct }: { item: ManualShoppingItem; writable: boolean; busy: boolean; onAct: Act }) {
  const [buying, setBuying] = useState(false);
  const id = `shopping-manual-${item.grocery_manual_item_id}`;
  const line: ShoppingLine = { kind: 'manual', id: item.grocery_manual_item_id };
  return (
    <Card testID={id} accessibilityLabel={`${item.name}. ${t('grocery.manual')}. ${shoppingStatusText(item.status)}`}>
      <Text variant="heading">{item.name}</Text>
      <Text variant="small">{t('grocery.manual')}</Text>
      {item.notes ? <Text variant="small">{item.notes}</Text> : null}
      <ProgressLines progress={item} testID={id} />
      {writable ? (
        <>
          <Actions line={line} progress={item} purchases={item.purchases} busy={busy} onAct={onAct} onBuyAmount={() => setBuying(true)} testID={id} />
          <Button label={t('grocery.removeManual')} variant="secondary" onPress={() => onAct({ kind: 'removeManual', manualId: item.grocery_manual_item_id })} disabled={busy} testID={`${id}-remove`} />
          {buying ? (
            <AmountForm
              title={t('grocery.boughtOther')}
              base={item.shopping_target?.unit ?? null}
              allowZero={false}
              submitLabel={t('grocery.recordPurchase')}
              busy={busy}
              onSubmit={(value) => onAct({ kind: 'buy', line, amount: value }, () => setBuying(false))}
              onCancel={() => setBuying(false)}
              testID={`${id}-buy-form`}
            />
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

function AddManual({ busy, onAct }: { busy: boolean; onAct: Act }) {
  const { api } = useServices();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [text, setText] = useState('');
  const [unit, setUnit] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const units = useQuery({ queryKey: queryKeys.units(), queryFn: ({ signal }) => listUnits(api, signal), staleTime: Infinity, enabled: open });
  if (!open) return <Button label={t('grocery.addManual')} variant="secondary" onPress={() => setOpen(true)} testID="manual-add-start" />;

  const choices = units.data ? unitChoices(null, units.data.data) : ['count'];
  const hasAmount = text.trim().length > 0;
  const quantity = parseAmount(text, false);
  const nameMissing = !name.trim();
  const amountBad = hasAmount && (quantity === null || !unit);
  const reset = () => {
    setOpen(false);
    setName('');
    setNotes('');
    setText('');
    setUnit(null);
    setTouched(false);
  };
  const submit = () => {
    setTouched(true);
    if (nameMissing || amountBad || busy) return;
    const input: ManualItemInput = { name: name.trim(), notes: notes.trim() || null };
    if (hasAmount) Object.assign(input, { quantity, unit });
    onAct({ kind: 'addManual', input }, reset);
  };
  return (
    <Card testID="manual-form">
      <Text variant="heading">{t('grocery.addManual')}</Text>
      <Input label={t('grocery.manualName')} value={name} onChangeText={setName} maxLength={200} testID="manual-name" />
      {touched && nameMissing ? <Text variant="error">{t('grocery.error.name')}</Text> : null}
      <Input label={t('grocery.manualAmount')} value={text} onChangeText={setText} keyboardType="decimal-pad" testID="manual-quantity" />
      <ChoiceRow>
        {choices.map((code) => (
          <Choice key={code} label={code === 'count' ? t('grocery.unitCount') : code} selected={unit === code} onPress={() => setUnit(code)} testID={`manual-unit-${code}`} />
        ))}
      </ChoiceRow>
      {touched && amountBad ? <Text variant="error">{t('grocery.error.manualAmount')}</Text> : null}
      <Input label={t('grocery.manualNotes')} value={notes} onChangeText={setNotes} maxLength={1000} testID="manual-notes" />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
        <Button label={t('grocery.addManualSave')} onPress={submit} disabled={busy} testID="manual-save" />
        <Button label={t('recipeEdit.cancel')} variant="secondary" onPress={reset} testID="manual-cancel" />
      </View>
    </Card>
  );
}
