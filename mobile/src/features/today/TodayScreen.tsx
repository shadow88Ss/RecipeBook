// Layer 12A §24–25 — Today (Daily Tracker).
//
// Shows the five summary nutrients exactly as the API reports them: complete,
// partial (with how many items have data) or unavailable ("Not available",
// never 0). A no-consumption day shows the API's known zeros. The target line
// preserves the API's context (live current target / saved daily snapshot /
// historical target unavailable) and the comparison is the API's own.

import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { SUMMARY_FIELDS, type DailyTracker } from '../../api/contracts/dailyTracker';
import { getDailyTracker } from '../../api/endpoints';
import { formatNumber, t } from '../../i18n';
import { addDays, deviceTimeZone, localDate } from '../../lib/dates';
import { useSelectedProfile } from '../../profile/ProfileProvider';
import { useServices } from '../../state/AppProviders';
import { queryKeys } from '../../state/queryClient';
import { Button, Card, ErrorState, LoadingState, Screen, Text } from '../../ui';
import { theme } from '../../ui/theme';
import { comparisonText, coverageText, formatAmount, nutrientLabel, SUMMARY_UNITS, targetContextText } from './format';

export function TodayScreen({ now = () => new Date(), timeZone }: { now?: () => Date; timeZone?: string }) {
  const profile = useSelectedProfile();
  const { api } = useServices();
  const zone = useMemo(() => timeZone ?? deviceTimeZone(), [timeZone]);
  const today = localDate(now(), zone);
  const [date, setDate] = useState(today);

  const query = useQuery({
    queryKey: queryKeys.dailyTracker(profile.id, date, zone),
    queryFn: ({ signal }) => getDailyTracker(api, profile.id, date, zone, signal),
  });

  return (
    <Screen testID="today-screen">
      <Text variant="title">{t('today.title')}</Text>
      <Text variant="muted">{profile.display_name}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.sm }}>
        <Button label={t('today.previousDay')} variant="secondary" onPress={() => setDate(addDays(date, -1))} testID="previous-day" />
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text variant="heading" testID="tracker-date">
            {date}
          </Text>
        </View>
        <Button label={t('today.nextDay')} variant="secondary" onPress={() => setDate(addDays(date, 1))} disabled={date >= today} testID="next-day" />
      </View>
      {query.isPending ? <LoadingState /> : null}
      {query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : null}
      {query.data ? <TrackerView tracker={query.data} /> : null}
    </Screen>
  );
}

export function TrackerView({ tracker }: { tracker: DailyTracker }) {
  const comparisonByKey = new Map(tracker.comparison.nutrients.map((c) => [c.nutrient_key, c]));
  const comparisonAvailable = tracker.comparison.status === 'available';

  return (
    <View style={{ gap: theme.space.md }} testID="tracker-view">
      {tracker.actual.basis === 'no_consumption' ? (
        <Text variant="muted" testID="no-consumption">
          {t('today.noConsumption')}
        </Text>
      ) : (
        <Text variant="muted">{t('today.meals', { count: tracker.meal_count })}</Text>
      )}
      <Text variant="small" testID="target-context">
        {targetContextText(tracker.target.context)}
      </Text>
      {SUMMARY_FIELDS.map((field) => {
        const entry = tracker.actual.summary[field];
        const comparison = comparisonByKey.get(entry.nutrient_key);
        const amount = formatAmount(entry, SUMMARY_UNITS[field]);
        const coverage = coverageText(entry);
        const cmp = !comparisonAvailable ? null : comparison ? comparisonText(comparison) : t('today.target.none');
        const targetLine = comparison && comparison.target.value !== null ? t('today.target.value', { value: formatNumber(comparison.target.value, 1), unit: comparison.unit }) : null;
        const label = nutrientLabel(entry.nutrient_key);
        return (
          <Card key={field} testID={`nutrient-${field}`} accessibilityLabel={[label, amount, coverage, targetLine, cmp].filter(Boolean).join('. ')}>
            <Text variant="heading">{label}</Text>
            <Text testID={`amount-${field}`}>{amount}</Text>
            <Text variant="small" testID={`coverage-${field}`}>
              {coverage}
            </Text>
            {targetLine ? <Text variant="small">{targetLine}</Text> : null}
            {cmp ? (
              <Text variant="small" testID={`comparison-${field}`}>
                {cmp}
              </Text>
            ) : null}
          </Card>
        );
      })}
      {tracker.comparison.unmapped_targets.length ? <Text variant="small">{t('today.unmapped', { count: tracker.comparison.unmapped_targets.length })}</Text> : null}
    </View>
  );
}
