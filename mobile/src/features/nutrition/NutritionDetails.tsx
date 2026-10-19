// Layer 12B.4 — expandable list of every nutrient the server returned, grouped,
// with completeness in words (never color alone) and the source where the API
// provides one. Nutrients without a value are listed by name as "Not
// available", never as 0.

import { useState } from 'react';
import { View } from 'react-native';

import { t } from '../../i18n';
import { Button, Card, Text } from '../../ui';
import { theme } from '../../ui/theme';
import { arrange, type NutrientDisplay } from './display';

export function NutritionDetails({ rows, testID = 'nutrition-details', initiallyOpen = false }: { rows: readonly NutrientDisplay[]; testID?: string; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  if (!rows.length) return null;
  const { groups, unavailable } = arrange(rows);
  return (
    <View style={{ gap: theme.space.sm }} testID={testID}>
      <Button
        label={open ? t('nutrition.details.hide') : t('nutrition.details.show')}
        variant="secondary"
        onPress={() => setOpen(!open)}
        testID={`${testID}-toggle`}
      />
      {open ? (
        <View style={{ gap: theme.space.md }} testID={`${testID}-list`}>
          {groups.map(({ group, rows: groupRows }) => (
            <View key={group} style={{ gap: theme.space.xs }}>
              <Text variant="heading">{t(`nutrition.group.${group}`)}</Text>
              {groupRows.map((row) => (
                <NutrientRow key={row.key} row={row} />
              ))}
            </View>
          ))}
          {unavailable.length ? (
            <Text variant="small" testID={`${testID}-unavailable`}>
              {t('nutrition.notAvailableList', { names: unavailable.join(', ') })}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

export function NutrientRow({ row }: { row: NutrientDisplay }) {
  const spoken = [row.label, row.hint, row.amountText, row.stateText, row.sourceText].filter(Boolean).join('. ');
  return (
    <Card testID={`nutrient-row-${row.key}`} accessibilityLabel={spoken}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.space.sm, flexWrap: 'wrap' }}>
        <Text>{row.label}</Text>
        <Text testID={`nutrient-amount-${row.key}`}>{row.amountText}</Text>
      </View>
      {row.hint ? <Text variant="small">{row.hint}</Text> : null}
      <Text variant="small" testID={`nutrient-state-${row.key}`}>
        {row.stateText}
      </Text>
      {row.sourceText ? <Text variant="small">{row.sourceText}</Text> : null}
    </Card>
  );
}
