// Layer 13A.1 — the nutrition a recipe's source page states about itself,
// shown exactly as published and clearly apart from the nutrition the server
// calculates. It is never added, converted or used in any total.

import { View } from 'react-native';

import type { StatedNutrition as Stated } from '../../api/contracts/recipeImports';
import { en } from '../../i18n/en';
import { t, type MessageKey } from '../../i18n';
import { Card, Text } from '../../ui';
import { theme } from '../../ui/theme';

export function hostOf(url: string | undefined | null): string {
  if (!url) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function fieldLabel(field: string): string {
  const key = `recipeImport.stated.${field}`;
  return key in en ? t(key as MessageKey) : field;
}

export function StatedNutrition({ stated, host, review = false }: { stated: Stated; host: string; review?: boolean }) {
  return (
    <Card testID="stated-nutrition">
      <Text variant="heading">{t('recipeImport.stated.title', { host })}</Text>
      <Text variant="small">{review ? t('recipeImport.stated.basisReview') : t('recipeImport.stated.basis')}</Text>
      {stated.serving_size ? <Text variant="small">{t('recipeImport.stated.servingSize', { size: stated.serving_size })}</Text> : null}
      <View style={{ gap: theme.space.xs }}>
        {stated.values.map((v) => (
          <Text key={v.field} testID={`stated-${v.field}`}>
            {`${fieldLabel(v.field)}: ${v.text}`}
          </Text>
        ))}
      </View>
    </Card>
  );
}
