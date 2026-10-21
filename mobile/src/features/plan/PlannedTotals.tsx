// Layer 12C — a planned day's five-field server summary, behind a toggle so a
// multi-day plan stays scannable.

import { useState } from 'react';
import { View } from 'react-native';

import type { PlannedNutrition } from '../../api/contracts/mealPlans';
import { t } from '../../i18n';
import { Button } from '../../ui';
import { theme } from '../../ui/theme';
import { SummaryCards } from '../nutrition/SummaryCards';

export function PlannedTotals({ nutrition, testID }: { nutrition: PlannedNutrition; testID: string }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: theme.space.sm }}>
      <Button label={open ? t('plans.totals.hide') : t('plans.totals.show')} variant="secondary" onPress={() => setOpen(!open)} testID={`${testID}-toggle`} />
      {open ? <SummaryCards summary={nutrition.summary} testID={testID} /> : null}
    </View>
  );
}
