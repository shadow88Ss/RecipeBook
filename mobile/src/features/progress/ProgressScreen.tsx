// Layer 12A §26 — Progress (Layer 10B), shown factually.
//
// Three separate sections exactly as the API reports them: meal-plan
// follow-through rates, nutrition against saved daily targets, and weight.
// No combined score, no judgement words, no new calculation: every number on
// screen is a field of the response.

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { RATE_KEYS, type Progress } from '../../api/contracts/progress';
import { getProgress } from '../../api/endpoints';
import { formatNumber, t } from '../../i18n';
import { addDays, deviceTimeZone, localDate } from '../../lib/dates';
import { useSelectedProfile } from '../../profile/ProfileProvider';
import { useServices } from '../../state/AppProviders';
import { queryKeys } from '../../state/queryClient';
import { Card, ErrorState, LoadingState, Screen, Text } from '../../ui';
import { nutrientLabel } from '../today/format';

export const PROGRESS_RANGE_DAYS = 7;

export function ProgressScreen({ now = () => new Date(), timeZone }: { now?: () => Date; timeZone?: string }) {
  const profile = useSelectedProfile();
  const { api } = useServices();
  const zone = useMemo(() => timeZone ?? deviceTimeZone(), [timeZone]);
  const to = localDate(now(), zone);
  const from = addDays(to, -(PROGRESS_RANGE_DAYS - 1));

  const query = useQuery({
    queryKey: queryKeys.progress(profile.id, from, to, zone),
    queryFn: ({ signal }) => getProgress(api, profile.id, { from, to, timezone: zone }, signal),
  });

  return (
    <Screen testID="progress-screen">
      <Text variant="title">{t('progress.title')}</Text>
      <Text variant="muted">{profile.display_name}</Text>
      <Text variant="small">{t('progress.range', { from, to })}</Text>
      {query.isPending ? <LoadingState /> : null}
      {query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : null}
      {query.data ? <ProgressView progress={query.data} /> : null}
    </Screen>
  );
}

const pct = (value: number) => formatNumber(value, 1);

export function ProgressView({ progress }: { progress: Progress }) {
  const { plan_fulfillment: plan, nutrition_adherence: nutrition, goal_progress: goal } = progress;
  return (
    <>
      <Card testID="progress-plan">
        <Text variant="heading">{t('progress.plan.title')}</Text>
        {plan.rates.status === 'no_eligible_planned_items' ? (
          <Text variant="muted" testID="plan-none">
            {t('progress.plan.none')}
          </Text>
        ) : (
          <>
            <Text variant="small">{t('progress.plan.eligible', { count: plan.rates.denominator.value })}</Text>
            {RATE_KEYS.map((key) => {
              const rate = plan.rates[key];
              return (
                <Text key={key} testID={`rate-${key}`}>
                  {`${t(`progress.rate.${key}`)}: ${
                    rate.percentage === null ? t('common.notAvailable') : t('progress.plan.rate', { count: rate.count, total: rate.denominator, percentage: pct(rate.percentage) })
                  }`}
                </Text>
              );
            })}
          </>
        )}
        <Text variant="small">{t('progress.plan.unplanned', { count: plan.unplanned_actual_item_count })}</Text>
      </Card>

      <Card testID="progress-nutrition">
        <Text variant="heading">{t('progress.nutrition.title')}</Text>
        <Text variant="small">
          {t('progress.nutrition.days', {
            consumption: nutrition.range_summary.days_with_consumption,
            days: nutrition.range_summary.days_requested,
            targets: nutrition.range_summary.days_with_historical_target,
          })}
        </Text>
        {nutrition.nutrient_summary.length === 0 ? <Text variant="muted">{t('progress.nutrition.none')}</Text> : null}
        {nutrition.nutrient_summary.map((row) => (
          <Text key={row.nutrient_key} testID={`adherence-${row.nutrient_key}`}>
            {`${nutrientLabel(row.nutrient_key)}: ${t('progress.nutrition.nutrient', { comparable: row.days_comparable, withTarget: row.days_with_target })}. ${
              row.average_percentage_of_target === null ? t('progress.nutrition.noComparable') : t('progress.nutrition.average', { value: pct(row.average_percentage_of_target) })
            }`}
          </Text>
        ))}
      </Card>

      <Card testID="progress-weight">
        <Text variant="heading">{t('progress.weight.title')}</Text>
        {goal.latest_active ? (
          <>
            <Text testID="weight-latest">{t('progress.weight.latest', { value: formatNumber(goal.latest_active.value, 2), date: goal.latest_active.local_date })}</Text>
            {goal.first_active && goal.absolute_change_kg !== null ? (
              <>
                <Text variant="small">{t('progress.weight.first', { value: formatNumber(goal.first_active.value, 2), date: goal.first_active.local_date })}</Text>
                <Text variant="small" testID="weight-change">
                  {t('progress.weight.change', { value: formatNumber(goal.absolute_change_kg, 2) })}
                </Text>
              </>
            ) : null}
          </>
        ) : (
          <Text variant="muted" testID="weight-none">
            {t('progress.weight.none')}
          </Text>
        )}
        {goal.goals
          .filter((g) => g.difference_from_target_kg !== null)
          .map((g) => (
            <Text key={g.goal_id} variant="small" testID={`goal-${g.goal_id}`}>
              {t('progress.weight.goalDifference', { value: formatNumber(g.difference_from_target_kg as number, 2) })}
            </Text>
          ))}
      </Card>
    </>
  );
}
