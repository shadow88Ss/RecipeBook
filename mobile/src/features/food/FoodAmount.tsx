// Layer 12E — choosing a Food from the server's search and an amount of it,
// shared by the recipe ingredient editor (12D) and the meal plan item editor.
//
// The amount is either a quantity of one of the Food's servings or a
// quantity in a unit code the server lists. Amounts are parsed only to check
// and send them; nothing is calculated here.

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { View } from 'react-native';

import { getFood, listUnits, searchFoods } from '../../api/endpoints';
import { formatNumber, t } from '../../i18n';
import { useServices } from '../../state/AppProviders';
import { queryKeys } from '../../state/queryClient';
import { Button, Choice, ChoiceRow, EmptyState, ErrorState, Input, LoadingState, Row, Text } from '../../ui';
import { theme } from '../../ui/theme';
import { foodName } from '../log/LogScreen';
import { OFFERED_UNITS, parseQuantity } from '../log/LogItemScreen';

export type FoodAmount =
  | { kind: 'unit'; quantity: number; unit: string }
  | { kind: 'serving'; quantity: number; servingId: string; label: string | null }
  /** A stored count with no unit (from a recipe line); never produced by the fields below. */
  | { kind: 'count'; quantity: number };

type Mode = 'serving' | 'unit';

/** Search the server's Foods and pick one. */
export function FoodSearch({ label, onPick }: { label: string; onPick: (food: { id: string; name: string }) => void }) {
  const { api } = useServices();
  const [searchText, setSearchText] = useState('');
  const [q, setQ] = useState('');
  const search = useQuery({ queryKey: queryKeys.foodSearch(q), queryFn: ({ signal }) => searchFoods(api, q, signal), enabled: q.length > 0 });
  return (
    <View style={{ gap: theme.space.sm }}>
      <Input
        label={label}
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
        <Row key={f.id} onPress={() => onPick({ id: f.id, name: foodName(f) })} accessibilityLabel={foodName(f)} testID={`pick-food-${f.id}`}>
          <Text>{foodName(f)}</Text>
          {f.match.identity_confirmation_required ? <Text variant="small">{t('log.identityCheck')}</Text> : null}
        </Row>
      ))}
    </View>
  );
}

/** The amount being chosen for `foodId`, starting from `start` (a stored amount, if any). */
export function useFoodAmount(foodId: string | null, start: FoodAmount | null) {
  const { api } = useServices();
  const [mode, setMode] = useState<Mode | null>(start?.kind === 'serving' ? 'serving' : start?.kind === 'unit' ? 'unit' : null);
  const [servingId, setServingId] = useState<string | null>(start?.kind === 'serving' ? start.servingId : null);
  const [unit, setUnit] = useState(start?.kind === 'unit' ? start.unit : 'g');
  const [quantityText, setQuantityText] = useState(start && start.kind !== 'count' ? String(start.quantity) : '');

  const detail = useQuery({ queryKey: queryKeys.food(foodId ?? ''), queryFn: ({ signal }) => getFood(api, foodId!, signal), enabled: !!foodId });
  const units = useQuery({ queryKey: queryKeys.units(), queryFn: ({ signal }) => listUnits(api, signal), staleTime: Infinity, enabled: !!foodId });

  const servings = detail.data?.servings ?? [];
  const effectiveMode: Mode = mode ?? (servings.length ? 'serving' : 'unit');
  const quantity = parseQuantity(quantityText);
  const effectiveServingId = servingId ?? (servings.length === 1 ? servings[0]!.id : null);
  const chosenServing = servings.find((s) => s.id === effectiveServingId) ?? null;
  const offeredUnits = (units.data?.data ?? []).filter((u) => (OFFERED_UNITS as readonly string[]).includes(u.code)).sort((a, b) => OFFERED_UNITS.indexOf(a.code as never) - OFFERED_UNITS.indexOf(b.code as never));

  // A stored count ("2" with no unit) is kept as-is unless the user sets an amount.
  const keptCount = start?.kind === 'count' && !quantityText ? start : null;
  const amount: FoodAmount | null = !foodId
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

  /** Forget the choices made for a previous Food. */
  const reset = () => {
    setMode(null);
    setServingId(null);
    setQuantityText('');
  };

  return { detail, servings, effectiveMode, effectiveServingId, offeredUnits, unit, quantityText, keptCount, amount, setMode, setServingId, setUnit, setQuantityText, reset };
}

export type FoodAmountState = ReturnType<typeof useFoodAmount>;

/** Serving-or-unit choice and the quantity, for the Food in `state`. */
export function FoodAmountFields({ state, showMissing }: { state: FoodAmountState; showMissing: boolean }) {
  const { detail, servings, effectiveMode, effectiveServingId, offeredUnits, unit } = state;
  if (detail.isPending) return <LoadingState />;
  if (detail.isError) return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;
  return (
    <>
      <ChoiceRow>
        {servings.length ? <Choice label={t('logItem.byServing')} selected={effectiveMode === 'serving'} onPress={() => state.setMode('serving')} testID="ing-mode-serving" /> : null}
        <Choice label={t('logItem.byWeight')} selected={effectiveMode === 'unit'} onPress={() => state.setMode('unit')} testID="ing-mode-unit" />
      </ChoiceRow>
      {effectiveMode === 'serving' ? (
        <ChoiceRow>
          {servings.map((s) => (
            <Choice
              key={s.id}
              label={t('logItem.servingOf', { description: s.serving_description, quantity: formatNumber(s.canonical_quantity, 3), unit: s.canonical_unit })}
              selected={effectiveServingId === s.id}
              onPress={() => state.setServingId(s.id)}
              testID={`ing-serving-${s.id}`}
            />
          ))}
        </ChoiceRow>
      ) : (
        <ChoiceRow>
          {offeredUnits.map((u) => (
            <Choice key={u.code} label={u.code === u.label ? u.code : `${u.label} (${u.code})`} selected={unit === u.code} onPress={() => state.setUnit(u.code)} testID={`ing-unit-${u.code}`} />
          ))}
        </ChoiceRow>
      )}
      <Input
        label={effectiveMode === 'serving' ? t('logItem.quantity') : t('logItem.quantityUnit', { unit })}
        value={state.quantityText}
        onChangeText={state.setQuantityText}
        keyboardType="decimal-pad"
        testID="ingredient-quantity"
      />
      {state.keptCount ? <Text variant="small">{t('recipeEdit.keptCount', { quantity: formatNumber(state.keptCount.quantity, 3) })}</Text> : null}
      {showMissing && !state.amount ? <Text variant="error">{t('recipeEdit.error.amount')}</Text> : null}
    </>
  );
}
