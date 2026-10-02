// Layer 12B — choose an amount and a meal for one Food or Product, review the
// nutrition the SERVER calculates for it, and log it.
//
// The app sends only what the user chose: the item reference, a quantity and
// exactly one of a unit code (from the server's unit registry) or a serving of
// that item, the meal type and today's local date/time zone. The preview is
// POST /v1/nutrition/calculate (Food) or /v1/products/{id}/nutrition/calculate
// (Product); logging is POST /v1/profiles/{id}/meals, which recalculates and
// stores the authoritative snapshot. After a successful log every cached day
// of the Daily Tracker (and Progress) is invalidated and re-read from the API —
// totals are never adjusted on the device.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { SUMMARY_FIELDS, type SummaryEntry } from '../../api/contracts/dailyTracker';
import { MEAL_TYPES, type ItemAmount, type MealType, type Serving } from '../../api/contracts/catalog';
import { foodItem, getFood, getProduct, listUnits, logMeal, previewFoodNutrition, previewProductNutrition, productItem } from '../../api/endpoints';
import { isApiError } from '../../api/errors';
import { formatNumber, t, type MessageKey } from '../../i18n';
import { deviceTimeZone, localDate } from '../../lib/dates';
import { useSelectedProfile } from '../../profile/ProfileProvider';
import { canLogMeals } from '../../profile/scope';
import { useServices } from '../../state/AppProviders';
import { invalidateAfterNutritionWrite, queryKeys } from '../../state/queryClient';
import { Button, Card, Choice, ChoiceRow, ErrorState, Input, LoadingState, Notice, Screen, Text, errorMessage } from '../../ui';
import { theme } from '../../ui/theme';
import { coverageText, formatAmount, nutrientLabel, SUMMARY_UNITS } from '../today/format';
import { foodName, productLines } from './LogScreen';

export type LogTarget = { kind: 'food'; id: string } | { kind: 'product'; id: string; barcode?: string | null };

/** Unit codes offered for a weight/volume amount, in this order, if the server lists them. */
export const OFFERED_UNITS = ['g', 'kg', 'oz', 'lb', 'ml', 'l', 'cup_us', 'tbsp_us', 'tsp_us', 'fl_oz_us'] as const;

/** Reads a typed amount. Input parsing only (a decimal comma is accepted); no nutrition is derived. */
export function parseQuantity(text: string): number | null {
  const value = Number(text.trim().replace(',', '.'));
  return text.trim().length && Number.isFinite(value) && value > 0 ? value : null;
}

/** The server preview, reduced to what this screen shows (values untouched). */
interface Preview {
  summary: Record<(typeof SUMMARY_FIELDS)[number], SummaryEntry>;
  converted: boolean;
  labelStatus: 'non_authoritative_label' | 'no_label_version' | null;
}

interface Item {
  name: string;
  kindLabel: string;
  lines: string[];
  servings: Serving[];
  /** Product only: why it cannot be logged at all. */
  blocked: 'no_label_version' | null;
}

export function LogItemScreen({ target, onLogged, now = () => new Date(), timeZone }: { target: LogTarget; onLogged: () => void; now?: () => Date; timeZone?: string }) {
  const profile = useSelectedProfile();
  const { api } = useServices();
  const queryClient = useQueryClient();
  const zone = useMemo(() => timeZone ?? deviceTimeZone(), [timeZone]);

  const food = useQuery({ queryKey: queryKeys.food(target.id), queryFn: ({ signal }) => getFood(api, target.id, signal), enabled: target.kind === 'food' });
  const product = useQuery({ queryKey: queryKeys.product(target.id), queryFn: ({ signal }) => getProduct(api, target.id, signal), enabled: target.kind === 'product' });
  const units = useQuery({ queryKey: queryKeys.units(), queryFn: ({ signal }) => listUnits(api, signal), staleTime: Infinity });
  const detail = target.kind === 'food' ? food : product;

  const item: Item | null = useMemo(() => {
    if (target.kind === 'food' && food.data) {
      return { name: foodName(food.data), kindLabel: t('log.kind.food'), lines: food.data.category ? [food.data.category] : [], servings: food.data.servings, blocked: null };
    }
    if (target.kind === 'product' && product.data) {
      const p = product.data;
      return {
        name: p.display_name,
        kindLabel: `${t('log.kind.product')} · ${p.brand_name}`,
        lines: productLines(p),
        servings: p.current_label?.servings ?? [],
        blocked: p.current_label ? null : 'no_label_version',
      };
    }
    return null;
  }, [target.kind, food.data, product.data]);

  const [mode, setMode] = useState<'serving' | 'unit' | null>(null);
  const [servingId, setServingId] = useState<string | null>(null);
  const [unit, setUnit] = useState<string>('g');
  const [quantityText, setQuantityText] = useState<string | null>(null);
  const [mealType, setMealType] = useState<MealType | null>(null);
  const [touched, setTouched] = useState(false);

  // Defaults once the item is known: a serving when it lists any, else grams.
  const effectiveMode = mode ?? (item?.servings.length ? 'serving' : 'unit');
  const effectiveServing = servingId ?? (item?.servings.length === 1 ? item.servings[0]!.id : null);
  const effectiveText = quantityText ?? (effectiveMode === 'serving' ? '1' : '100');
  const quantity = parseQuantity(effectiveText);
  const amount: ItemAmount | null =
    quantity === null ? null : effectiveMode === 'serving' ? (effectiveServing ? { kind: 'serving', quantity, servingId: effectiveServing } : null) : { kind: 'unit', quantity, unit };

  const offeredUnits = (units.data?.data ?? []).filter((u) => (OFFERED_UNITS as readonly string[]).includes(u.code)).sort((a, b) => OFFERED_UNITS.indexOf(a.code as never) - OFFERED_UNITS.indexOf(b.code as never));

  const preview = useQuery({
    queryKey: queryKeys.preview(target.kind, target.id, JSON.stringify(amount)),
    queryFn: ({ signal }): Promise<Preview> =>
      target.kind === 'food'
        ? previewFoodNutrition(api, target.id, amount!, signal).then((p) => ({ summary: p.summary, converted: p.items[0]?.normalized_quantity.status === 'converted', labelStatus: null }))
        : previewProductNutrition(api, target.id, amount!, signal).then((p) => ({
            summary: p.summary,
            converted: p.normalized_quantity.status === 'converted',
            labelStatus: p.label_status === 'authoritative_label' ? null : p.label_status,
          })),
    enabled: !!item && !item.blocked && amount !== null,
  });

  const log = useMutation({
    mutationFn: () => {
      const instant = now();
      return logMeal(api, profile.id, {
        mealType: mealType!,
        loggedDate: localDate(instant, zone),
        timeZone: zone,
        consumedAt: instant.toISOString(),
        items: [target.kind === 'food' ? foodItem(target.id, amount!) : productItem({ productId: target.id, barcode: target.barcode }, amount!)],
      });
    },
    onSuccess: async () => {
      await invalidateAfterNutritionWrite(queryClient, profile.id);
      onLogged();
    },
  });

  const selectMode = (next: 'serving' | 'unit') => {
    setMode(next);
    setQuantityText(null);
  };
  const writable = canLogMeals(profile.access_scope);
  const submit = () => {
    setTouched(true);
    if (amount && mealType && writable && !item?.blocked) log.mutate();
  };

  if (detail.isPending) {
    return (
      <Screen testID="log-item-screen">
        <LoadingState />
      </Screen>
    );
  }
  if (detail.isError || !item) {
    return (
      <Screen testID="log-item-screen">
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      </Screen>
    );
  }

  const previewData = preview.data;
  const notConverted = previewData && !previewData.converted;
  const labelStatus = previewData?.labelStatus ?? null;

  return (
    <Screen testID="log-item-screen">
      <Text variant="title">{item.name}</Text>
      <Text variant="small" testID="item-kind">
        {item.kindLabel}
      </Text>
      {item.lines.map((line) => (
        <Text key={line} variant="small">
          {line}
        </Text>
      ))}
      {!writable ? <Notice testID="log-read-only">{t('log.readOnly')}</Notice> : null}
      {item.blocked ? <Notice testID="item-blocked">{t(`logItem.label.${item.blocked}`)}</Notice> : null}

      {writable && !item.blocked ? (
        <>
          <Text variant="heading">{t('logItem.amount')}</Text>
          <ChoiceRow>
            <Choice label={t('logItem.byServing')} selected={effectiveMode === 'serving'} onPress={() => selectMode('serving')} testID="mode-serving" />
            <Choice label={t('logItem.byWeight')} selected={effectiveMode === 'unit'} onPress={() => selectMode('unit')} testID="mode-unit" />
          </ChoiceRow>
          {effectiveMode === 'serving' ? (
            item.servings.length ? (
              <ChoiceRow>
                {item.servings.map((s) => (
                  <Choice
                    key={s.id}
                    label={t('logItem.servingOf', { description: s.serving_description, quantity: formatNumber(s.canonical_quantity, 3), unit: s.canonical_unit })}
                    selected={effectiveServing === s.id}
                    onPress={() => setServingId(s.id)}
                    testID={`serving-${s.id}`}
                  />
                ))}
              </ChoiceRow>
            ) : (
              <Text variant="muted" testID="no-servings">
                {t('logItem.noServings')}
              </Text>
            )
          ) : units.isError ? (
            <ErrorState error={units.error} onRetry={() => void units.refetch()} />
          ) : (
            <ChoiceRow>
              {offeredUnits.map((u) => (
                <Choice key={u.code} label={u.code === u.label ? u.code : `${u.label} (${u.code})`} selected={unit === u.code} onPress={() => setUnit(u.code)} testID={`unit-${u.code}`} />
              ))}
            </ChoiceRow>
          )}
          <Input
            label={effectiveMode === 'serving' ? t('logItem.quantity') : t('logItem.quantityUnit', { unit })}
            value={effectiveText}
            onChangeText={setQuantityText}
            keyboardType="decimal-pad"
            maxLength={12}
            testID="quantity-input"
          />
          {quantity === null ? <Text variant="error">{t('logItem.invalidQuantity')}</Text> : null}
          {effectiveMode === 'serving' && item.servings.length && !effectiveServing && touched ? <Text variant="error">{t('logItem.chooseServing')}</Text> : null}

          <Text variant="heading">{t('logItem.mealType')}</Text>
          <ChoiceRow>
            {MEAL_TYPES.map((m) => (
              <Choice key={m} label={t(`meal.${m}` as MessageKey)} selected={mealType === m} onPress={() => setMealType(m)} testID={`meal-${m}`} />
            ))}
          </ChoiceRow>
          {touched && !mealType ? (
            <Text variant="error" testID="meal-type-required">
              {t('logItem.chooseMealType')}
            </Text>
          ) : null}

          <Text variant="heading">{t('logItem.preview')}</Text>
          <Text variant="small">{t('logItem.previewHint')}</Text>
          {amount === null ? null : preview.isPending ? <LoadingState /> : null}
          {preview.isError ? <ErrorState error={preview.error} onRetry={() => void preview.refetch()} /> : null}
          {labelStatus ? <Notice testID="label-status">{t(`logItem.label.${labelStatus}`)}</Notice> : null}
          {notConverted ? <Notice testID="not-converted">{t('logItem.notConverted')}</Notice> : null}
          {previewData ? <SummaryView summary={previewData.summary} /> : null}

          {log.isError ? (
            <Text variant="error" testID="log-error">
              {isApiError(log.error) && log.error.kind === 'conflict' ? t('logItem.conflict') : errorMessage(log.error)}
            </Text>
          ) : null}
          <Button label={t('logItem.submit')} onPress={submit} busy={log.isPending} disabled={amount === null} testID="log-submit" />
        </>
      ) : null}
    </Screen>
  );
}

/** The five server summary values as reported: unknown stays "Not available", never 0. */
export function SummaryView({ summary }: { summary: Record<(typeof SUMMARY_FIELDS)[number], SummaryEntry> }) {
  return (
    <View style={{ gap: theme.space.sm }} testID="nutrition-preview">
      {SUMMARY_FIELDS.map((field) => {
        const entry = summary[field];
        const label = nutrientLabel(entry.nutrient_key);
        const amount = formatAmount(entry, SUMMARY_UNITS[field]);
        return (
          <Card key={field} testID={`preview-${field}`} accessibilityLabel={`${label}. ${amount}. ${coverageText(entry)}`}>
            <Text>{`${label}: ${amount}`}</Text>
            <Text variant="small">{coverageText(entry)}</Text>
          </Card>
        );
      })}
    </View>
  );
}
