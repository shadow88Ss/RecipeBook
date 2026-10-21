// Layer 12D — edit one ingredient line: the text as written, and optionally a
// Food the user picks from the server's search (a confirmed match) with an
// amount in a unit or one of that Food's servings. A line without a Food is
// kept as text only and is not counted in nutrition; nothing is matched
// automatically.

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { View } from 'react-native';

import { getFood, listUnits, searchFoods } from '../../api/endpoints';
import { formatNumber, t } from '../../i18n';
import { useServices } from '../../state/AppProviders';
import { queryKeys } from '../../state/queryClient';
import { Button, Card, Choice, ChoiceRow, EmptyState, ErrorState, Input, LoadingState, Row, Text } from '../../ui';
import { theme } from '../../ui/theme';
import { foodName } from '../log/LogScreen';
import { OFFERED_UNITS, parseQuantity } from '../log/LogItemScreen';
import type { DraftAmount, DraftIngredient } from './draft';

type Mode = 'serving' | 'unit';

export function IngredientEditor({ initial, onSave, onCancel }: { initial: DraftIngredient; onSave: (next: DraftIngredient) => void; onCancel: () => void }) {
  const { api } = useServices();
  const [text, setText] = useState(initial.text);
  const [food, setFood] = useState(initial.food);
  const [searchText, setSearchText] = useState('');
  const [q, setQ] = useState('');
  const start = initial.amount;
  const [mode, setMode] = useState<Mode | null>(start?.kind === 'serving' ? 'serving' : start?.kind === 'unit' ? 'unit' : null);
  const [servingId, setServingId] = useState<string | null>(start?.kind === 'serving' ? start.servingId : null);
  const [unit, setUnit] = useState(start?.kind === 'unit' ? start.unit : 'g');
  const [quantityText, setQuantityText] = useState(start && start.kind !== 'count' ? String(start.quantity) : '');
  const [touched, setTouched] = useState(false);

  const search = useQuery({ queryKey: queryKeys.foodSearch(q), queryFn: ({ signal }) => searchFoods(api, q, signal), enabled: !food && q.length > 0 });
  const detail = useQuery({ queryKey: queryKeys.food(food?.id ?? ''), queryFn: ({ signal }) => getFood(api, food!.id, signal), enabled: !!food });
  const units = useQuery({ queryKey: queryKeys.units(), queryFn: ({ signal }) => listUnits(api, signal), staleTime: Infinity, enabled: !!food });

  const servings = detail.data?.servings ?? [];
  const effectiveMode: Mode = mode ?? (servings.length ? 'serving' : 'unit');
  const quantity = parseQuantity(quantityText);
  const effectiveServingId = servingId ?? (servings.length === 1 ? servings[0]!.id : null);
  const chosenServing = servings.find((s) => s.id === effectiveServingId) ?? null;
  const offeredUnits = (units.data?.data ?? []).filter((u) => (OFFERED_UNITS as readonly string[]).includes(u.code)).sort((a, b) => OFFERED_UNITS.indexOf(a.code as never) - OFFERED_UNITS.indexOf(b.code as never));

  // A stored count ("2" with no unit) is kept as-is unless the user sets an amount.
  const keptCount = start?.kind === 'count' && !quantityText ? start : null;
  const amount: DraftAmount | null = !food
    ? null
    : keptCount
      ? keptCount
      : quantity === null
        ? null
        : effectiveMode === 'serving'
          ? effectiveServingId
            ? { kind: 'serving', quantity, servingId: effectiveServingId, label: chosenServing?.serving_description ?? (start?.kind === 'serving' ? start.label : null) }
            : null
          : { kind: 'unit', quantity, unit };

  const textMissing = !text.trim();
  const amountMissing = !!food && !amount;
  const save = () => {
    setTouched(true);
    if (textMissing || amountMissing) return;
    // Without a Food, a stored amount is kept for the record (never calculated).
    const nextAmount = food ? amount : initial.food ? null : initial.amount;
    onSave({ ...initial, text: text.trim(), food, amount: nextAmount, unconfirmedSuggestion: food ? false : initial.unconfirmedSuggestion });
  };

  return (
    <Card testID="ingredient-editor">
      <Input label={t('recipeEdit.ingredientText')} value={text} onChangeText={setText} maxLength={500} testID="ingredient-text" />
      {touched && textMissing ? <Text variant="error">{t('recipeEdit.error.ingredientText')}</Text> : null}
      {food ? (
        <View style={{ gap: theme.space.sm }}>
          <Text testID="linked-food">{t('recipeEdit.linkedTo', { name: food.name ?? (detail.data ? foodName(detail.data) : t('recipeEdit.aFood')) })}</Text>
          <Button
            label={t('recipeEdit.unlink')}
            variant="secondary"
            onPress={() => {
              setFood(null);
              setServingId(null);
              setMode(null);
            }}
            testID="unlink-food"
          />
          {detail.isPending ? <LoadingState /> : null}
          {detail.isError ? <ErrorState error={detail.error} onRetry={() => void detail.refetch()} /> : null}
          {detail.data ? (
            <>
              <ChoiceRow>
                {servings.length ? <Choice label={t('logItem.byServing')} selected={effectiveMode === 'serving'} onPress={() => setMode('serving')} testID="ing-mode-serving" /> : null}
                <Choice label={t('logItem.byWeight')} selected={effectiveMode === 'unit'} onPress={() => setMode('unit')} testID="ing-mode-unit" />
              </ChoiceRow>
              {effectiveMode === 'serving' ? (
                <ChoiceRow>
                  {servings.map((s) => (
                    <Choice
                      key={s.id}
                      label={t('logItem.servingOf', { description: s.serving_description, quantity: formatNumber(s.canonical_quantity, 3), unit: s.canonical_unit })}
                      selected={effectiveServingId === s.id}
                      onPress={() => setServingId(s.id)}
                      testID={`ing-serving-${s.id}`}
                    />
                  ))}
                </ChoiceRow>
              ) : (
                <ChoiceRow>
                  {offeredUnits.map((u) => (
                    <Choice key={u.code} label={u.code === u.label ? u.code : `${u.label} (${u.code})`} selected={unit === u.code} onPress={() => setUnit(u.code)} testID={`ing-unit-${u.code}`} />
                  ))}
                </ChoiceRow>
              )}
              <Input
                label={effectiveMode === 'serving' ? t('logItem.quantity') : t('logItem.quantityUnit', { unit })}
                value={quantityText}
                onChangeText={setQuantityText}
                keyboardType="decimal-pad"
                testID="ingredient-quantity"
              />
              {keptCount ? <Text variant="small">{t('recipeEdit.keptCount', { quantity: formatNumber(keptCount.quantity, 3) })}</Text> : null}
              {touched && amountMissing ? <Text variant="error">{t('recipeEdit.error.amount')}</Text> : null}
            </>
          ) : null}
        </View>
      ) : (
        <View style={{ gap: theme.space.sm }}>
          <Text variant="small">{initial.unconfirmedSuggestion ? t('recipeEdit.unconfirmedHint') : t('recipeEdit.textOnlyHint')}</Text>
          <Input
            label={t('recipeEdit.findFood')}
            value={searchText}
            onChangeText={setSearchText}
            onSubmitEditing={() => setQ(searchText.trim())}
            returnKeyType="search"
            autoCorrect={false}
            maxLength={100}
            testID="ingredient-food-search"
          />
          <Button label={t('log.search')} variant="secondary" onPress={() => setQ(searchText.trim())} disabled={!searchText.trim()} testID="ingredient-food-search-submit" />
          {q && search.isPending ? <LoadingState /> : null}
          {search.isError ? <ErrorState error={search.error} onRetry={() => void search.refetch()} /> : null}
          {search.data && !search.data.data.length ? <EmptyState message={t('log.noFoods', { q })} /> : null}
          {search.data?.data.map((f) => (
            <Row
              key={f.id}
              onPress={() => {
                setFood({ id: f.id, name: foodName(f) });
                setMode(null);
                setServingId(null);
                setQuantityText('');
              }}
              accessibilityLabel={foodName(f)}
              testID={`pick-food-${f.id}`}
            >
              <Text>{foodName(f)}</Text>
              {f.match.identity_confirmation_required ? <Text variant="small">{t('log.identityCheck')}</Text> : null}
            </Row>
          ))}
        </View>
      )}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm }}>
        <Button label={t('recipeEdit.saveLine')} onPress={save} testID="ingredient-save" />
        <Button label={t('recipeEdit.cancel')} variant="secondary" onPress={onCancel} testID="ingredient-cancel" />
      </View>
    </Card>
  );
}
