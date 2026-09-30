// Display helpers for server-computed nutrition values. These only choose
// words and display rounding; they never add, subtract or derive a value.

import type { ComparisonEntry, SummaryEntry, SummaryField, TargetContext } from '../../api/contracts/dailyTracker';
import type { RoundedValue } from '../../api/contracts/common';
import { formatNumber, t, type MessageKey } from '../../i18n';

export const SUMMARY_UNITS: Record<SummaryField, string> = {
  energy_kcal: 'kcal',
  protein_g: 'g',
  carbohydrate_g: 'g',
  fat_g: 'g',
  fiber_g: 'g',
};

const DISPLAY_DIGITS = 1;
const SMALLEST_SHOWN = 0.1;

/** `null` stays "Not available" — unknown intake is never shown as 0. */
export function formatAmount(value: RoundedValue, unit: string): string {
  if (value.value === null) return t('common.notAvailable');
  if (value.is_zero) return `${formatNumber(0)} ${unit}`;
  if (value.below_output_precision || Math.abs(value.value) < SMALLEST_SHOWN) {
    return `${t('today.belowPrecision', { value: formatNumber(SMALLEST_SHOWN) })} ${unit}`;
  }
  return `${formatNumber(value.value, DISPLAY_DIGITS)} ${unit}`;
}

export function coverageText(entry: SummaryEntry): string {
  if (entry.coverage === 'complete') return t('today.coverage.complete');
  if (entry.coverage === 'partial') return t('today.coverage.partial', { resolved: entry.resolved_item_count, total: entry.item_count });
  return t('today.coverage.unavailable');
}

export function targetContextText(context: TargetContext): string {
  return t(`today.target.${context}`);
}

const n = (value: number | null) => formatNumber(value ?? 0, DISPLAY_DIGITS);

/** Words for the comparison the server made. Every number shown comes from the response. */
export function comparisonText(entry: ComparisonEntry): string {
  const unit = entry.unit;
  switch (entry.comparison_status) {
    case 'below_target':
      return t('today.cmp.below_target', { value: n(entry.remaining), unit });
    case 'at_target':
      return t('today.cmp.at_target');
    case 'above_target':
      return entry.over_target_by !== null
        ? t('today.cmp.above_target', { value: n(entry.over_target_by), unit })
        : t('today.cmp.above_target_at_least', { value: n(entry.over_target_by_at_least), unit });
    case 'at_or_above_target':
      return t('today.cmp.at_or_above_target');
    case 'undetermined':
      return t('today.cmp.undetermined', { value: n(entry.remaining_at_most), unit });
    case 'actual_unavailable':
      return t('today.cmp.actual_unavailable');
  }
}

export function nutrientLabel(nutrientKey: string): string {
  const key = `nutrient.${nutrientKey}` as MessageKey;
  return ['energy', 'protein', 'carbohydrate', 'fat', 'fiber'].includes(nutrientKey) ? t(key) : nutrientKey;
}
