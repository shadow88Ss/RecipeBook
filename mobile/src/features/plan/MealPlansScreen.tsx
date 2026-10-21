// Layer 12C — Meal plans: the selected Profile's plans
// (GET /v1/profiles/{id}/meal-plans), newest start date first, with cursor
// paging. A plan is planned intent; it is never shown as food eaten. Layer
// 12E adds "New meal plan" for scopes that can plan.

import { useInfiniteQuery } from '@tanstack/react-query';

import type { MealPlanSummary } from '../../api/contracts/mealPlans';
import { listMealPlans } from '../../api/endpoints';
import { en } from '../../i18n/en';
import { t, type MessageKey } from '../../i18n';
import { useSelectedProfile } from '../../profile/ProfileProvider';
import { canPlanMeals } from '../../profile/scope';
import { useServices } from '../../state/AppProviders';
import { queryKeys } from '../../state/queryClient';
import { Button, EmptyState, ErrorState, LoadingState, Row, Screen, Text } from '../../ui';

export function MealPlansScreen({ onOpen, onNew }: { onOpen: (planId: string) => void; onNew?: () => void }) {
  const profile = useSelectedProfile();
  const { api } = useServices();
  const query = useInfiniteQuery({
    queryKey: queryKeys.mealPlans(profile.id),
    queryFn: ({ pageParam, signal }) => listMealPlans(api, profile.id, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.pagination.nextCursor,
  });
  const plans = query.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <Screen testID="plans-screen">
      <Text variant="title">{t('plans.title')}</Text>
      <Text variant="muted">{profile.display_name}</Text>
      {onNew && canPlanMeals(profile.access_scope) ? <Button label={t('planEdit.newTitle')} onPress={onNew} testID="new-plan" /> : null}
      {query.isPending ? <LoadingState /> : null}
      {query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : null}
      {query.data && !plans.length ? <EmptyState message={t('plans.empty')} testID="plans-empty" /> : null}
      {plans.map((plan) => (
        <PlanRow key={plan.id} plan={plan} onPress={() => onOpen(plan.id)} />
      ))}
      {query.hasNextPage ? (
        <Button label={t('common.loadMore')} variant="secondary" onPress={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage} testID="plans-more" />
      ) : null}
    </Screen>
  );
}

/** The plan status in words; a status this app does not know is shown as-is. */
export function planStatusText(status: string): string {
  const key = `plans.status.${status}`;
  return key in en ? t(key as MessageKey) : status;
}

export function planDatesText(plan: Pick<MealPlanSummary, 'start_date' | 'end_date'>): string {
  return plan.start_date === plan.end_date ? plan.start_date : t('plans.dates', { start: plan.start_date, end: plan.end_date });
}

function PlanRow({ plan, onPress }: { plan: MealPlanSummary; onPress: () => void }) {
  const line = `${planDatesText(plan)} · ${planStatusText(plan.status)}`;
  return (
    <Row onPress={onPress} accessibilityLabel={`${plan.name}. ${line}`} testID={`plan-${plan.id}`}>
      <Text variant="heading">{plan.name}</Text>
      <Text variant="small">{line}</Text>
    </Row>
  );
}
