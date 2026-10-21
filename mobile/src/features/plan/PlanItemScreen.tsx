// Layer 12E — add one item to a planned meal: an amount of a Food from the
// server's search, or servings of one of the Profile's own recipes
// (POST …/meal-plans/{plan}/meals/{meal}/items). A recipe item names the
// recipe's CURRENT version exactly; later recipe edits make new versions and
// leave the planned one as it is. The item is added as a draft and its
// nutrition is the server's, calculated live until the plan is confirmed.

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { View } from 'react-native';

import type { PlannedItemInput } from '../../api/contracts/mealPlans';
import { addPlannedItems, getRecipe, listRecipes } from '../../api/endpoints';
import { t } from '../../i18n';
import { useSelectedProfile } from '../../profile/ProfileProvider';
import { canPlanMeals } from '../../profile/scope';
import { useServices } from '../../state/AppProviders';
import { queryKeys } from '../../state/queryClient';
import { Button, Card, Choice, ChoiceRow, EmptyState, ErrorState, Input, LoadingState, Notice, Row, Screen, Text, errorMessage } from '../../ui';
import { theme } from '../../ui/theme';
import { FoodAmountFields, FoodSearch, useFoodAmount, type FoodAmount } from '../food/FoodAmount';
import { parseQuantity } from '../log/LogItemScreen';
import { servingsText } from '../recipes/RecipesScreen';

/** The API's limit on planned servings of a recipe. */
export const MAX_PLANNED_SERVINGS = 100;

type Source = 'food' | 'recipe';

export function foodItemInput(foodId: string, amount: FoodAmount): PlannedItemInput | null {
  if (amount.kind === 'serving') return { type: 'food', food_id: foodId, quantity: amount.quantity, serving_id: amount.servingId };
  if (amount.kind === 'unit') return { type: 'food', food_id: foodId, quantity: amount.quantity, unit: amount.unit };
  return null;
}

export function PlanItemScreen({ planId, mealId, onDone }: { planId: string; mealId: string; onDone: () => void }) {
  const profile = useSelectedProfile();
  const { api } = useServices();
  const client = useQueryClient();
  const [source, setSource] = useState<Source>('food');

  const add = useMutation({
    mutationFn: (item: PlannedItemInput) => addPlannedItems(api, profile.id, planId, mealId, [item]),
    onSuccess: (plan) => {
      client.setQueryData(queryKeys.mealPlan(profile.id, plan.id), plan);
      void client.invalidateQueries({ queryKey: queryKeys.groceryPreview(profile.id, plan.id) });
      onDone();
    },
  });

  if (!canPlanMeals(profile.access_scope)) {
    return (
      <Screen testID="plan-item-screen">
        <Notice testID="plan-item-read-only">{t('planEdit.readOnly')}</Notice>
      </Screen>
    );
  }

  return (
    <Screen testID="plan-item-screen">
      <Text variant="title">{t('planEdit.addItem')}</Text>
      <ChoiceRow>
        <Choice label={t('planEdit.source.food')} selected={source === 'food'} onPress={() => setSource('food')} testID="source-food" />
        <Choice label={t('planEdit.source.recipe')} selected={source === 'recipe'} onPress={() => setSource('recipe')} testID="source-recipe" />
      </ChoiceRow>
      {source === 'food' ? <FoodItemForm onAdd={(item) => add.mutate(item)} busy={add.isPending} /> : <RecipeItemForm onAdd={(item) => add.mutate(item)} busy={add.isPending} />}
      {add.isError ? (
        <Text variant="error" testID="plan-item-error">
          {errorMessage(add.error)}
        </Text>
      ) : null}
    </Screen>
  );
}

function FoodItemForm({ onAdd, busy }: { onAdd: (item: PlannedItemInput) => void; busy: boolean }) {
  const [food, setFood] = useState<{ id: string; name: string } | null>(null);
  const [touched, setTouched] = useState(false);
  const amountState = useFoodAmount(food?.id ?? null, null);

  if (!food) {
    return (
      <FoodSearch
        label={t('planEdit.findFood')}
        onPick={(picked) => {
          setFood(picked);
          amountState.reset();
          setTouched(false);
        }}
      />
    );
  }
  const item = amountState.amount ? foodItemInput(food.id, amountState.amount) : null;
  return (
    <Card testID="plan-food-form">
      <Text variant="heading" testID="plan-food-name">
        {food.name}
      </Text>
      <Button label={t('planEdit.otherFood')} variant="secondary" onPress={() => setFood(null)} testID="plan-other-food" />
      <FoodAmountFields state={amountState} showMissing={touched} />
      <Button
        label={t('planEdit.addToMeal')}
        onPress={() => {
          setTouched(true);
          if (item && !busy) onAdd(item);
        }}
        disabled={busy}
        testID="plan-item-add"
      />
    </Card>
  );
}

function RecipeItemForm({ onAdd, busy }: { onAdd: (item: PlannedItemInput) => void; busy: boolean }) {
  const profile = useSelectedProfile();
  const { api } = useServices();
  const [recipeId, setRecipeId] = useState<string | null>(null);
  const [servingsInput, setServingsInput] = useState('1');
  const [touched, setTouched] = useState(false);

  // Same key and shape as the Recipes list, so the two share one paged cache entry.
  const list = useInfiniteQuery({
    queryKey: queryKeys.recipes(profile.id, ''),
    queryFn: ({ pageParam, signal }) => listRecipes(api, profile.id, { cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.pagination.nextCursor,
    enabled: !recipeId,
  });
  const recipes = list.data?.pages.flatMap((p) => p.data) ?? [];
  const recipe = useQuery({ queryKey: queryKeys.recipe(profile.id, recipeId ?? ''), queryFn: ({ signal }) => getRecipe(api, profile.id, recipeId!, signal), enabled: !!recipeId });

  if (!recipeId) {
    return (
      <View style={{ gap: theme.space.sm }}>
        {list.isPending ? <LoadingState /> : null}
        {list.isError ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : null}
        {list.data && !recipes.length ? <EmptyState message={t('planEdit.noRecipes')} testID="plan-no-recipes" /> : null}
        {recipes.map((r) => (
          <Row key={r.id} onPress={() => setRecipeId(r.id)} accessibilityLabel={r.title} testID={`pick-recipe-${r.id}`}>
            <Text>{r.title}</Text>
            <Text variant="small">{servingsText(r.servings)}</Text>
          </Row>
        ))}
        {list.hasNextPage ? (
          <Button label={t('common.loadMore')} variant="secondary" onPress={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage} testID="plan-recipes-more" />
        ) : null}
      </View>
    );
  }

  const back = <Button label={t('planEdit.otherRecipe')} variant="secondary" onPress={() => setRecipeId(null)} testID="plan-other-recipe" />;
  if (recipe.isPending) return <LoadingState />;
  if (recipe.isError) return <ErrorState error={recipe.error} onRetry={() => void recipe.refetch()} />;
  const version = recipe.data.current_version;
  // The API plans a recipe by servings, so a version without a yield cannot be planned.
  if (!version || version.servings === null) {
    return (
      <Card testID="plan-recipe-form">
        <Text variant="heading">{recipe.data.title}</Text>
        <Notice testID="plan-recipe-no-yield">{t('planEdit.recipeNoYield')}</Notice>
        {back}
      </Card>
    );
  }
  const servings = parseQuantity(servingsInput);
  const servingsValid = servings !== null && servings <= MAX_PLANNED_SERVINGS;
  return (
    <Card testID="plan-recipe-form">
      <Text variant="heading" testID="plan-recipe-title">
        {recipe.data.title}
      </Text>
      <Text variant="small" testID="plan-recipe-version">
        {t('planEdit.recipeVersion', { number: version.version_number, yield: servingsText(version.servings) })}
      </Text>
      {back}
      <Input label={t('planEdit.servings')} value={servingsInput} onChangeText={setServingsInput} keyboardType="decimal-pad" testID="plan-recipe-servings" />
      {touched && !servingsValid ? <Text variant="error">{t('planEdit.error.servings')}</Text> : null}
      <Button
        label={t('planEdit.addToMeal')}
        onPress={() => {
          setTouched(true);
          if (servingsValid && !busy) onAdd({ type: 'recipe', recipe_id: recipe.data.id, recipe_version_id: version.id, servings: servings! });
        }}
        disabled={busy}
        testID="plan-item-add"
      />
    </Card>
  );
}
