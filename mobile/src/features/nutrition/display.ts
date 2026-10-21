// Layer 12B.4 — words and grouping for server-calculated nutrients. Shared by
// Today, the Food preview and the Product preview.
//
// Nothing here computes nutrition. Each nutrient is shown exactly as the API
// reported it: its value (null = unknown, never 0), its known-zero and
// below-display-precision flags, and its completeness. Total carbohydrate
// (`carbohydrate`, includes fiber) and available carbohydrate
// (`available_carbohydrate`, excludes fiber) are separate identities: never
// added, substituted or converted. The vocabulary is open: a key this app does
// not know is still shown, under a generic label.

import type { AggregateNutrient, ItemNutrient } from '../../api/contracts/nutrition';
import { en, type MessageKey } from '../../i18n/en';
import { t } from '../../i18n';
import { formatAmount, nutrientLabel } from '../today/format';

export type NutrientState = 'complete' | 'known_zero' | 'partial' | 'unavailable';
export type NutrientGroup = 'main' | 'minerals' | 'vitamins' | 'other';

export interface NutrientDisplay {
  key: string;
  label: string;
  /** e.g. "Excludes fiber. Not the same as total carbohydrate" */
  hint: string | null;
  unit: string;
  amountText: string;
  state: NutrientState;
  stateText: string;
  sourceText: string | null;
  group: NutrientGroup;
  order: number;
}

/** Display order. Keys not listed (a nutrient added later) go to "Other nutrients". */
const GROUPS: Record<Exclude<NutrientGroup, 'other'>, readonly string[]> = {
  main: ['energy', 'protein', 'fat', 'saturated_fat', 'carbohydrate', 'available_carbohydrate', 'total_sugars', 'added_sugars', 'fiber'],
  minerals: ['sodium', 'potassium', 'calcium', 'iron', 'magnesium', 'zinc'],
  vitamins: ['vitamin_a', 'vitamin_c', 'vitamin_d', 'vitamin_e', 'vitamin_k', 'thiamin', 'riboflavin', 'niacin', 'vitamin_b6', 'folate', 'vitamin_b12'],
};
export const GROUP_ORDER: readonly NutrientGroup[] = ['main', 'minerals', 'vitamins', 'other'];

function placement(key: string): { group: NutrientGroup; order: number } {
  for (const group of ['main', 'minerals', 'vitamins'] as const) {
    const index = GROUPS[group].indexOf(key);
    if (index >= 0) return { group, order: index };
  }
  return { group: 'other', order: 0 };
}

const has = (key: string): key is MessageKey => key in en;

export const nutrientName = nutrientLabel;

function hint(key: string): string | null {
  const k = `nutrient.hint.${key}`;
  return has(k) ? t(k) : null;
}

function sourceText(source: string | undefined | null): string | null {
  if (!source) return null;
  const k = `nutrition.source.${source}`;
  return has(k) ? t('nutrition.sourceLine', { source: t(k) }) : null;
}

/** A nutrient of a day, meal or recipe total: completeness across its items (or, for a recipe, its ingredients). */
export function fromAggregate(n: AggregateNutrient, partialKey: 'nutrition.state.partial' | 'recipes.state.partial' = 'nutrition.state.partial'): NutrientDisplay {
  const state: NutrientState = n.value === null ? 'unavailable' : n.coverage === 'partial' ? 'partial' : n.is_zero ? 'known_zero' : 'complete';
  const stateText = state === 'partial' ? t(partialKey, { resolved: n.resolved_item_count, total: n.item_count }) : t(`nutrition.state.${state}`);
  return { key: n.nutrient_key, label: nutrientName(n.nutrient_key), hint: hint(n.nutrient_key), unit: n.unit, amountText: formatAmount(n, n.unit), state, stateText, sourceText: null, ...placement(n.nutrient_key) };
}

/** A nutrient of one Food or Product preview: its status and, if resolved, its source. */
export function fromItem(n: ItemNutrient): NutrientDisplay {
  const resolved = n.status === 'resolved' && n.value !== null;
  const state: NutrientState = !resolved ? 'unavailable' : n.is_zero ? 'known_zero' : 'complete';
  const reason = n.status === 'no_data' || n.status === 'not_authoritative' ? n.status : 'other';
  const stateText = resolved ? t(`nutrition.state.${state}`) : `${t('nutrition.state.unavailable')}: ${t(`nutrition.reason.${reason}`)}`;
  return {
    key: n.nutrient_key,
    label: nutrientName(n.nutrient_key),
    hint: hint(n.nutrient_key),
    unit: n.unit,
    amountText: resolved ? formatAmount(n, n.unit) : t('common.notAvailable'),
    state,
    stateText,
    sourceText: resolved ? sourceText(n.source?.source) : null,
    ...placement(n.nutrient_key),
  };
}

/** Rows with a value, grouped and ordered; and the names of those without one. */
export function arrange(rows: readonly NutrientDisplay[]): { groups: { group: NutrientGroup; rows: NutrientDisplay[] }[]; unavailable: string[] } {
  const sorted = [...rows].sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const withValue = sorted.filter((r) => r.state !== 'unavailable');
  return {
    groups: GROUP_ORDER.map((group) => ({ group, rows: withValue.filter((r) => r.group === group) })).filter((g) => g.rows.length),
    unavailable: sorted.filter((r) => r.state === 'unavailable').map((r) => r.label),
  };
}

/**
 * True when the day's total carbohydrate is not complete AND available
 * carbohydrate has data: some items stated available carbohydrate instead.
 * Only reads the server's states; no value is compared or combined.
 */
export function availableCarbohydrateNoteNeeded(nutrients: readonly AggregateNutrient[]): boolean {
  const total = nutrients.find((n) => n.nutrient_key === 'carbohydrate');
  const available = nutrients.find((n) => n.nutrient_key === 'available_carbohydrate');
  return !!available && available.value !== null && (!total || total.coverage !== 'complete');
}
