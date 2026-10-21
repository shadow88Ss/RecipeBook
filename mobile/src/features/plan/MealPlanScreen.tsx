// Layer 12C — one meal plan (GET /v1/profiles/{id}/meal-plans/{plan}): its
// days, meals and items, with the server's planned nutrition per day.
//
// Planned nutrition is the server's: live for draft/planned items (it can
// change with reference data), the stored snapshot for confirmed items. The
// totals cover current items only; cancelled and replaced items are still
// listed, labelled, and not counted. A day with nothing planned says so; it
// is not shown as zero intake. Nothing is calculated on the device.

import { useQuery } from '@tanstack/react-query';
import { View } from 'react-native';

import type { MealPlanDetail, PlannedItem, PlannedMeal, PlannedNutrition } from '../../api/contracts/mealPlans';
import { getMealPlan } from '../../api/endpoints';
import { en } from '../../i18n/en';
import { formatNumber, t, tp, type MessageKey } from '../../i18n';
import { useSelectedProfile } from '../../profile/ProfileProvider';
import { useServices } from '../../state/AppProviders';
import { queryKeys } from '../../state/queryClient';
import { Card, ErrorState, LoadingState, Notice, Screen, Text } from '../../ui';
import { theme } from '../../ui/theme';
import { summaryCoverageText } from '../nutrition/SummaryCards';
import { formatAmount } from '../today/format';
import { planDatesText, planStatusText } from './MealPlansScreen';
import { PlannedTotals } from './PlannedTotals';

export function MealPlanScreen({ planId }: { planId: string }) {
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
      {query.data ? <PlanView plan={query.data} /> : null}
    </Screen>
  );
}

function PlanView({ plan }: { plan: MealPlanDetail }) {
  return (
    <View style={{ gap: theme.space.md }}>
      <Text variant="title">{plan.name}</Text>
      <Text variant="small" testID="plan-meta">
        {`${planDatesText(plan)} · ${planStatusText(plan.status)}`}
      </Text>
      {plan.description ? <Text>{plan.description}</Text> : null}
      {plan.includes_unconfirmed ? <Notice testID="plan-unconfirmed">{t('plans.unconfirmedNote')}</Notice> : null}
      {plan.days.length ? null : <Text variant="muted" testID="plan-no-days">{t('plans.noDays')}</Text>}
      {plan.days.map((day) => (
        <View key={day.id} style={{ gap: theme.space.sm }} testID={`plan-day-${day.plan_date}`}>
          <Text variant="heading">{day.plan_date}</Text>
          <Text variant="small" testID={`day-energy-${day.plan_date}`}>
            {plannedEnergyText(day.nutrition)}
          </Text>
          {day.nutrition.basis === 'planned_items' ? <PlannedTotals nutrition={day.nutrition} testID={`day-totals-${day.plan_date}`} /> : null}
          {day.meals.map((meal) => (
            <MealCard key={meal.id} meal={meal} />
          ))}
        </View>
      ))}
    </View>
  );
}

/** "Planned energy: 1,800 kcal (Complete)", or "Nothing planned" — never a 0 kcal intake. */
export function plannedEnergyText(nutrition: PlannedNutrition): string {
  if (nutrition.basis === 'no_planned_items') return t('plans.nothingPlanned');
  const energy = nutrition.summary.energy_kcal;
  return t('plans.plannedEnergy', { amount: formatAmount(energy, 'kcal'), coverage: summaryCoverageText(energy) });
}

function MealCard({ meal }: { meal: PlannedMeal }) {
  const typeKey = `meal.${meal.meal_type}`;
  const name = typeKey in en ? t(typeKey as MessageKey) : meal.meal_type;
  const title = meal.scheduled_local_time ? t('plans.mealAt', { meal: name, time: meal.scheduled_local_time }) : name;
  return (
    <Card testID={`planned-meal-${meal.id}`} accessibilityLabel={`${title}. ${plannedEnergyText(meal.nutrition)}`}>
      <Text variant="heading">{title}</Text>
      {meal.notes ? <Text variant="small">{meal.notes}</Text> : null}
      <Text variant="small">{plannedEnergyText(meal.nutrition)}</Text>
      {meal.items.map((item) => (
        <PlannedItemLine key={item.id} item={item} />
      ))}
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

function PlannedItemLine({ item }: { item: PlannedItem }) {
  const name = plannedItemName(item);
  const amount = plannedAmountText(item);
  const state = plannedItemStateText(item);
  return (
    <View testID={`planned-item-${item.id}`} accessible accessibilityLabel={`${name}. ${amount}. ${state}`} style={{ gap: theme.space.xs }}>
      <Text>{`${name} · ${amount}`}</Text>
      <Text variant="small" testID={`planned-item-state-${item.id}`}>
        {item.is_current ? state : t('plans.item.notCounted', { state })}
      </Text>
    </View>
  );
}
