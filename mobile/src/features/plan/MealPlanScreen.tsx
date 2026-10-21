// Layer 12C — one meal plan (GET /v1/profiles/{id}/meal-plans/{plan}): its
// days, meals and items, with the server's planned nutrition per day.
//
// Planned nutrition is the server's: live for draft/planned items (it can
// change with reference data), the stored snapshot for confirmed items. The
// totals cover current items only; cancelled and replaced items are still
// listed, labelled, and not counted. A day with nothing planned says so; it
// is not shown as zero intake. Nothing is calculated on the device.
//
// Layer 12E — for scopes that can plan, a draft or active plan can be added
// to: a day from its date range, a meal on a day, items on a meal (on their
// own screen). Draft and planned items can be removed (cancelled; they stay
// listed). "Confirm plan" asks the server to confirm every draft/planned item,
// which stores each one's nutrition as it is now; confirmed items cannot be
// changed afterwards. Every write answers with the plan as the server has it.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { View } from 'react-native';

import { MEAL_TYPES } from '../../api/contracts/catalog';
import type { MealPlanDetail, PlannedItem, PlannedMeal, PlannedMealCreate, PlannedNutrition } from '../../api/contracts/mealPlans';
import { addPlanDay, addPlannedMeal, cancelPlannedItem, confirmMealPlan, getMealPlan } from '../../api/endpoints';
import { en } from '../../i18n/en';
import { formatNumber, t, tp, type MessageKey } from '../../i18n';
import { addDays } from '../../lib/dates';
import { useSelectedProfile } from '../../profile/ProfileProvider';
import { canPlanMeals } from '../../profile/scope';
import { useServices } from '../../state/AppProviders';
import { queryKeys } from '../../state/queryClient';
import { Button, Card, Choice, ChoiceRow, ErrorState, Input, LoadingState, Notice, Screen, Text, errorMessage } from '../../ui';
import { theme } from '../../ui/theme';
import { summaryCoverageText } from '../nutrition/SummaryCards';
import { formatAmount } from '../today/format';
import { planDatesText, planStatusText } from './MealPlansScreen';
import { PlannedTotals } from './PlannedTotals';

export function MealPlanScreen({ planId, onAddItem }: { planId: string; onAddItem?: (mealId: string) => void }) {
  const profile = useSelectedProfile();
  const { api } = useServices();
  const query = useQuery({
    queryKey: queryKeys.mealPlan(profile.id, planId),
    queryFn: ({ signal }) => getMealPlan(api, profile.id, planId, signal),
  });
  return (
    <Screen testID="plan-screen">
      {query.isPending ? <LoadingState /> : null}
      {query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : null}
      {query.data ? <PlanView plan={query.data} onAddItem={onAddItem} /> : null}
    </Screen>
  );
}

type PlanWrite = { kind: 'day'; date: string } | { kind: 'meal'; dayId: string; meal: PlannedMealCreate } | { kind: 'cancel'; itemId: string } | { kind: 'confirm' };

/** Days, meals and items can be added only to draft and active plans (docs/30_API.md §21). */
export function isPlanEditable(status: string): boolean {
  return status === 'draft' || status === 'active';
}

/** Draft and planned items can still be changed; confirmed ones only replaced (not in this layer). */
export function isItemOpen(item: PlannedItem): boolean {
  return item.status === 'draft' || item.status === 'planned';
}

function usePlanWrite(planId: string) {
  const profile = useSelectedProfile();
  const { api } = useServices();
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (w: PlanWrite): Promise<MealPlanDetail> => {
      switch (w.kind) {
        case 'day':
          return addPlanDay(api, profile.id, planId, w.date);
        case 'meal':
          return addPlannedMeal(api, profile.id, planId, w.dayId, w.meal);
        case 'confirm':
          return confirmMealPlan(api, profile.id, planId);
        case 'cancel':
          // The PATCH answers with the one item; re-read the plan for the server's totals.
          await cancelPlannedItem(api, profile.id, planId, w.itemId);
          return getMealPlan(api, profile.id, planId);
      }
    },
    onSuccess: async (plan, w) => {
      client.setQueryData(queryKeys.mealPlan(profile.id, plan.id), plan);
      if (w.kind === 'confirm') await client.invalidateQueries({ queryKey: queryKeys.mealPlans(profile.id) });
    },
  });
}

function PlanView({ plan, onAddItem }: { plan: MealPlanDetail; onAddItem?: (mealId: string) => void }) {
  const profile = useSelectedProfile();
  const write = usePlanWrite(plan.id);
  const editable = !!onAddItem && canPlanMeals(profile.access_scope) && isPlanEditable(plan.status);
  const edit = editable ? { write, onAddItem: onAddItem! } : null;
  const openItems = plan.days.flatMap((d) => d.meals.flatMap((m) => m.items)).filter(isItemOpen).length;
  return (
    <View style={{ gap: theme.space.md }}>
      <Text variant="title">{plan.name}</Text>
      <Text variant="small" testID="plan-meta">
        {`${planDatesText(plan)} · ${planStatusText(plan.status)}`}
      </Text>
      {plan.description ? <Text>{plan.description}</Text> : null}
      {plan.includes_unconfirmed ? <Notice testID="plan-unconfirmed">{t('plans.unconfirmedNote')}</Notice> : null}
      {write.isError ? (
        <Text variant="error" testID="plan-write-error">
          {errorMessage(write.error)}
        </Text>
      ) : null}
      {edit && openItems ? <ConfirmPlan count={openItems} edit={edit} /> : null}
      {plan.days.length ? null : <Text variant="muted" testID="plan-no-days">{t('plans.noDays')}</Text>}
      {plan.days.map((day) => (
        <View key={day.id} style={{ gap: theme.space.sm }} testID={`plan-day-${day.plan_date}`}>
          <Text variant="heading">{day.plan_date}</Text>
          <Text variant="small" testID={`day-energy-${day.plan_date}`}>
            {plannedEnergyText(day.nutrition)}
          </Text>
          {day.nutrition.basis === 'planned_items' ? <PlannedTotals nutrition={day.nutrition} testID={`day-totals-${day.plan_date}`} /> : null}
          {day.meals.map((meal) => (
            <MealCard key={meal.id} meal={meal} edit={edit} />
          ))}
          {edit ? <AddMeal dayId={day.id} date={day.plan_date} edit={edit} /> : null}
        </View>
      ))}
      {edit ? <AddDay plan={plan} edit={edit} /> : null}
    </View>
  );
}

type Edit = { write: ReturnType<typeof usePlanWrite>; onAddItem: (mealId: string) => void };

function ConfirmPlan({ count, edit }: { count: number; edit: Edit }) {
  const [asking, setAsking] = useState(false);
  return (
    <Card testID="plan-confirm">
      <Text variant="small">{tp('planEdit.toConfirm', count, { count })}</Text>
      {asking ? (
        <>
          <Notice testID="plan-confirm-warning">{t('planEdit.confirmWarning')}</Notice>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
            <Button
              label={t('planEdit.confirmYes')}
              onPress={() => edit.write.mutate({ kind: 'confirm' }, { onSettled: () => setAsking(false) })}
              disabled={edit.write.isPending}
              testID="plan-confirm-yes"
            />
            <Button label={t('recipeEdit.cancel')} variant="secondary" onPress={() => setAsking(false)} testID="plan-confirm-no" />
          </View>
        </>
      ) : (
        <Button label={t('planEdit.confirm')} onPress={() => setAsking(true)} disabled={edit.write.isPending} testID="plan-confirm-start" />
      )}
    </Card>
  );
}

/** The plan's dates that have no day yet, in order. */
export function missingDates(plan: Pick<MealPlanDetail, 'start_date' | 'end_date' | 'days'>): string[] {
  const have = new Set(plan.days.map((d) => d.plan_date));
  const out: string[] = [];
  for (let d = plan.start_date; d <= plan.end_date; d = addDays(d, 1)) if (!have.has(d)) out.push(d);
  return out;
}

function AddDay({ plan, edit }: { plan: MealPlanDetail; edit: Edit }) {
  const dates = missingDates(plan);
  if (!dates.length) return null;
  return (
    <View style={{ gap: theme.space.sm }} testID="plan-add-day">
      <Text variant="heading">{t('planEdit.addDay')}</Text>
      <ChoiceRow>
        {dates.map((date) => (
          <Choice key={date} label={date} selected={false} onPress={() => !edit.write.isPending && edit.write.mutate({ kind: 'day', date })} testID={`add-day-${date}`} />
        ))}
      </ChoiceRow>
    </View>
  );
}

/** "HH:MM" (24-hour) or empty. */
export const validTime = (text: string) => !text || /^([01]\d|2[0-3]):[0-5]\d$/.test(text);

function AddMeal({ dayId, date, edit }: { dayId: string; date: string; edit: Edit }) {
  const [open, setOpen] = useState(false);
  const [mealType, setMealType] = useState<string>('breakfast');
  const [time, setTime] = useState('');
  if (!open) return <Button label={t('planEdit.addMeal')} variant="secondary" onPress={() => setOpen(true)} testID={`add-meal-${date}`} />;
  const timeOk = validTime(time.trim());
  return (
    <Card testID={`meal-form-${date}`}>
      <Text variant="heading">{t('planEdit.addMeal')}</Text>
      <ChoiceRow>
        {MEAL_TYPES.map((type) => (
          <Choice key={type} label={t(`meal.${type}`)} selected={mealType === type} onPress={() => setMealType(type)} testID={`meal-type-${type}`} />
        ))}
      </ChoiceRow>
      <Input label={t('planEdit.time')} value={time} onChangeText={setTime} keyboardType="numbers-and-punctuation" maxLength={5} testID="meal-time" />
      {timeOk ? null : <Text variant="error">{t('planEdit.error.time')}</Text>}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
        <Button
          label={t('planEdit.saveMeal')}
          onPress={() => {
            if (!timeOk || edit.write.isPending) return;
            const meal: PlannedMealCreate = { meal_type: mealType, ...(time.trim() ? { scheduled_local_time: time.trim() } : {}) };
            edit.write.mutate({ kind: 'meal', dayId, meal }, { onSuccess: () => setOpen(false) });
          }}
          disabled={edit.write.isPending}
          testID="meal-save"
        />
        <Button label={t('recipeEdit.cancel')} variant="secondary" onPress={() => setOpen(false)} testID="meal-cancel" />
      </View>
    </Card>
  );
}

/** "Planned energy: 1,800 kcal (Complete)", or "Nothing planned" — never a 0 kcal intake. */
export function plannedEnergyText(nutrition: PlannedNutrition): string {
  if (nutrition.basis === 'no_planned_items') return t('plans.nothingPlanned');
  const energy = nutrition.summary.energy_kcal;
  return t('plans.plannedEnergy', { amount: formatAmount(energy, 'kcal'), coverage: summaryCoverageText(energy) });
}

function MealCard({ meal, edit }: { meal: PlannedMeal; edit: Edit | null }) {
  const typeKey = `meal.${meal.meal_type}`;
  const name = typeKey in en ? t(typeKey as MessageKey) : meal.meal_type;
  const title = meal.scheduled_local_time ? t('plans.mealAt', { meal: name, time: meal.scheduled_local_time }) : name;
  return (
    <Card testID={`planned-meal-${meal.id}`} accessibilityLabel={`${title}. ${plannedEnergyText(meal.nutrition)}`}>
      <Text variant="heading">{title}</Text>
      {meal.notes ? <Text variant="small">{meal.notes}</Text> : null}
      <Text variant="small">{plannedEnergyText(meal.nutrition)}</Text>
      {meal.items.map((item) => (
        <PlannedItemLine key={item.id} item={item} edit={edit} />
      ))}
      {edit ? <Button label={t('planEdit.addItem')} variant="secondary" onPress={() => edit.onAddItem(meal.id)} testID={`add-item-${meal.id}`} /> : null}
    </Card>
  );
}

export function plannedItemName(item: PlannedItem): string {
  if (item.source_type === 'recipe') return item.recipe?.title ?? t('plans.item.recipe');
  return item.food?.canonical_name ?? t('plans.item.food');
}

export function plannedAmountText(item: PlannedItem): string {
  const a = item.amount;
  if ('servings' in a) return tp('plans.amount.servings', a.servings, { count: formatNumber(a.servings, 2) });
  if (a.serving_description) return t('plans.amount.serving', { quantity: formatNumber(a.quantity, 2), serving: a.serving_description });
  return `${formatNumber(a.quantity, 2)} ${a.unit ?? ''}`.trim();
}

/** Where the item stands: not counted (cancelled, replaced, pending replacement) or its status. */
export function plannedItemStateText(item: PlannedItem): string {
  if (item.superseded_by_planned_meal_item_id) return t('plans.item.replaced');
  if (item.is_pending_replacement) return t('plans.item.pendingReplacement');
  const key = `plans.itemStatus.${item.status}`;
  return key in en ? t(key as MessageKey) : item.status;
}

function PlannedItemLine({ item, edit }: { item: PlannedItem; edit: Edit | null }) {
  const name = plannedItemName(item);
  const amount = plannedAmountText(item);
  const state = plannedItemStateText(item);
  return (
    <View testID={`planned-item-${item.id}`} accessible accessibilityLabel={`${name}. ${amount}. ${state}`} style={{ gap: theme.space.xs }}>
      <Text>{`${name} · ${amount}`}</Text>
      <Text variant="small" testID={`planned-item-state-${item.id}`}>
        {item.is_current ? state : t('plans.item.notCounted', { state })}
      </Text>
      {edit && isItemOpen(item) ? (
        <Button
          label={t('planEdit.removeItem')}
          variant="secondary"
          onPress={() => !edit.write.isPending && edit.write.mutate({ kind: 'cancel', itemId: item.id })}
          disabled={edit.write.isPending}
          testID={`cancel-item-${item.id}`}
        />
      ) : null}
    </View>
  );
}
