// Layer 12C — the five-field server summary (energy, protein, total
// carbohydrate, fat, fiber) as cards, for totals that have no target
// comparison: a recipe, a planned day. Each value is shown as the API reported
// it, with its coverage in words; unknown is "Not available", never 0.

import { View } from 'react-native';

import { SUMMARY_FIELDS, type SummaryEntry } from '../../api/contracts/dailyTracker';
import { t } from '../../i18n';
import { Card, Text } from '../../ui';
import { theme } from '../../ui/theme';
import { formatAmount, nutrientLabel, SUMMARY_UNITS } from '../today/format';

type Summary = Record<(typeof SUMMARY_FIELDS)[number], SummaryEntry>;
export type PartialWording = 'items' | 'ingredients';

export function summaryCoverageText(entry: SummaryEntry, wording: PartialWording = 'items'): string {
  if (entry.coverage === 'complete') return t('today.coverage.complete');
  if (entry.coverage === 'unavailable') return t('today.coverage.unavailable');
  const params = { resolved: entry.resolved_item_count, total: entry.item_count };
  return wording === 'ingredients' ? t('recipes.state.partial', params) : t('today.coverage.partial', params);
}

export function SummaryCards({ summary, wording = 'items', testID }: { summary: Summary; wording?: PartialWording; testID: string }) {
  return (
    <View style={{ gap: theme.space.sm }} testID={testID}>
      {SUMMARY_FIELDS.map((field) => {
        const entry = summary[field];
        const label = nutrientLabel(entry.nutrient_key);
        const amount = formatAmount(entry, SUMMARY_UNITS[field]);
        const coverage = summaryCoverageText(entry, wording);
        return (
          <Card key={field} testID={`${testID}-${field}`} accessibilityLabel={`${label}. ${amount}. ${coverage}`}>
            <Text variant="heading">{label}</Text>
            <Text testID={`${testID}-amount-${field}`}>{amount}</Text>
            <Text variant="small" testID={`${testID}-coverage-${field}`}>
              {coverage}
            </Text>
          </Card>
        );
      })}
    </View>
  );
}
