// Layer 12E — create a draft meal plan: a name and a date range in the
// device's time zone (POST /v1/profiles/{id}/meal-plans). Days, meals and
// items are added on the plan itself afterwards.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { createMealPlan } from '../../api/endpoints';
import { t } from '../../i18n';
import { addDays, deviceTimeZone, localDate } from '../../lib/dates';
import { useSelectedProfile } from '../../profile/ProfileProvider';
import { canPlanMeals } from '../../profile/scope';
import { useServices } from '../../state/AppProviders';
import { queryKeys } from '../../state/queryClient';
import { Button, Input, Notice, Screen, Text, errorMessage } from '../../ui';

/** The API's limit on a plan's length. */
export const MAX_PLAN_DAYS = 366;

type DatesError = 'start' | 'end' | 'order' | 'length';

/** Checks the typed range against the API's rules (calendar dates, start ≤ end, at most 366 days). */
export function planDatesError(start: string, end: string): DatesError | null {
  const valid = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && addDays(d, 0) === d;
  if (!valid(start)) return 'start';
  if (!valid(end)) return 'end';
  if (start > end) return 'order';
  if (addDays(start, MAX_PLAN_DAYS - 1) < end) return 'length';
  return null;
}

export function MealPlanCreateScreen({ onCreated, now = () => new Date(), timeZone }: { onCreated: (planId: string) => void; now?: () => Date; timeZone?: string }) {
  const profile = useSelectedProfile();
  const { api } = useServices();
  const client = useQueryClient();
  const [zone] = useState(() => timeZone ?? deviceTimeZone());
  const [today] = useState(() => localDate(now(), zone));
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(() => addDays(today, 6));
  const [touched, setTouched] = useState(false);

  const create = useMutation({
    mutationFn: () => createMealPlan(api, profile.id, { name: name.trim(), description: description.trim() || null, start_date: start.trim(), end_date: end.trim(), local_timezone: zone }),
    onSuccess: async (plan) => {
      client.setQueryData(queryKeys.mealPlan(profile.id, plan.id), plan);
      await client.invalidateQueries({ queryKey: queryKeys.mealPlans(profile.id) });
      onCreated(plan.id);
    },
  });

  if (!canPlanMeals(profile.access_scope)) {
    return (
      <Screen testID="plan-new-screen">
        <Notice testID="plan-new-read-only">{t('planEdit.readOnly')}</Notice>
      </Screen>
    );
  }

  const nameMissing = !name.trim();
  const datesError = planDatesError(start.trim(), end.trim());
  const submit = () => {
    setTouched(true);
    if (nameMissing || datesError || create.isPending) return;
    create.mutate();
  };

  return (
    <Screen testID="plan-new-screen">
      <Text variant="title">{t('planEdit.newTitle')}</Text>
      <Input label={t('planEdit.name')} value={name} onChangeText={setName} maxLength={200} testID="plan-name" />
      {touched && nameMissing ? <Text variant="error">{t('planEdit.error.name')}</Text> : null}
      <Input label={t('planEdit.startDate')} value={start} onChangeText={setStart} autoCorrect={false} maxLength={10} testID="plan-start" />
      <Input label={t('planEdit.endDate')} value={end} onChangeText={setEnd} autoCorrect={false} maxLength={10} testID="plan-end" />
      {touched && datesError ? (
        <Text variant="error" testID="plan-dates-error">
          {t(`planEdit.error.${datesError}`)}
        </Text>
      ) : null}
      <Text variant="small">{t('planEdit.timeZone', { zone })}</Text>
      <Input label={t('planEdit.description')} value={description} onChangeText={setDescription} maxLength={2000} multiline testID="plan-description" />
      {create.isError ? (
        <Text variant="error" testID="plan-new-error">
          {errorMessage(create.error)}
        </Text>
      ) : null}
      <Button label={t('planEdit.create')} onPress={submit} disabled={create.isPending} testID="plan-create" />
    </Screen>
  );
}
