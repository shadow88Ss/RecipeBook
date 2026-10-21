// Layer 12A §24–25 — Today (Daily Tracker).
//
// Shows the five summary nutrients exactly as the API reports them: complete,
// partial (with how many items have data) or unavailable ("Not available",
// never 0). A no-consumption day shows the API's known zeros. The target line
// preserves the API's context (live current target / saved daily snapshot /
// historical target unavailable) and the comparison is the API's own.
//
// Layer 12B.4: below the summary, the day's meals (each with its own server
// totals) and an expandable list of every nutrient in the day's recorded
// snapshots. Total and available carbohydrate are separate rows; when some
// items stated only available carbohydrate, a note says so instead of
// letting a partial total look complete. Nothing is calculated on the device.

import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { SUMMARY_FIELDS, type DailyTracker } from '../../api/contracts/dailyTracker';
import { getDailyTracker } from '../../api/endpoints';
import { formatNumber, t, tp, type MessageKey } from '../../i18n';
import { addDays, deviceTimeZone, localDate } from '../../lib/dates';
import { useSelectedProfile } from '../../profile/ProfileProvider';
import { canLogMeals } from '../../profile/scope';
import { useServices } from '../../state/AppProviders';
import { queryKeys } from '../../state/queryClient';
import { Button, Card, ErrorState, LoadingState, Screen, Text } from '../../ui';
import { theme } from '../../ui/theme';
import { availableCarbohydrateNoteNeeded, fromAggregate } from '../nutrition/display';
import { NutritionDetails } from '../nutrition/NutritionDetails';
import { comparisonText, coverageText, formatAmount, nutrientLabel, SUMMARY_UNITS, targetContextText } from './format';

export function TodayScreen({ now = () => new Date(), timeZone, onLog }: { now?: () => Date; timeZone?: string; onLog?: () => void }) {
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
      {onLog && canLogMeals(profile.access_scope) ? <Button label={t('log.todayLog')} onPress={onLog} testID="today-log" /> : null}
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
        <Text variant="muted" testID="meal-count">
          {tp('today.meals', tracker.meal_count)}
        </Text>
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
      {availableCarbohydrateNoteNeeded(tracker.actual.nutrients) ? (
        <Text variant="small" testID="carb-note">
          {t('today.carbNote')}
        </Text>
      ) : null}
      {tracker.actual.basis === 'recorded_snapshots' ? <NutritionDetails rows={tracker.actual.nutrients.map((n) => fromAggregate(n))} testID="day-details" /> : null}
      <MealBreakdown tracker={tracker} />
    </View>
  );
}

/** The day's meals as the server grouped them, each with its own recorded totals. */
function MealBreakdown({ tracker }: { tracker: DailyTracker }) {
  const meals = tracker.meal_groups.flatMap((g) => g.meals);
  if (!meals.length) return null;
  return (
    <View style={{ gap: theme.space.sm }} testID="meal-breakdown">
      <Text variant="heading">{t('today.mealsTitle')}</Text>
      {meals.map((meal) => {
        const energy = meal.nutrition?.summary.energy_kcal;
        const name = t(`meal.${meal.meal_type}` as MessageKey);
        const items = tp('today.mealItems', meal.active_item_count);
        const energyText = energy ? t('today.mealEnergy', { amount: formatAmount(energy, 'kcal'), coverage: coverageText(energy) }) : null;
        return (
          <Card key={meal.id} testID={`meal-${meal.id}`} accessibilityLabel={[name, items, energyText].filter(Boolean).join('. ')}>
            <Text>{name}</Text>
            <Text variant="small">{items}</Text>
            {energyText ? <Text variant="small">{energyText}</Text> : null}
          </Card>
        );
      })}
    </View>
  );
}
