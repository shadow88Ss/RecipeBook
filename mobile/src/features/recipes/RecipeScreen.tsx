// Layer 12C — one recipe: the current version's yield, ingredients (as the
// user wrote them) and steps, and its nutrition as the server calculated it
// for that version (docs/30_API.md §17).
//
// Nutrition is shown per serving or for the whole recipe, both from the
// server; the app never divides or adds. A version without a yield has no
// per-serving view, and says so. An ingredient the server could not count is
// still listed, with the reason, and keeps the totals partial — a partial
// total is a lower bound, and missing is never shown as 0.

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { View } from 'react-native';

import type { RecipeNutrition, RecipeVersion } from '../../api/contracts/recipes';
import { getRecipe, getRecipeNutrition } from '../../api/endpoints';
import { en } from '../../i18n/en';
import { t, type MessageKey } from '../../i18n';
import { useSelectedProfile } from '../../profile/ProfileProvider';
import { canManageRecipes } from '../../profile/scope';
import { useServices } from '../../state/AppProviders';
import { queryKeys } from '../../state/queryClient';
import { Button, Card, Choice, ChoiceRow, ErrorState, LoadingState, Notice, Screen, Text } from '../../ui';
import { theme } from '../../ui/theme';
import { fromAggregate } from '../nutrition/display';
import { NutritionDetails } from '../nutrition/NutritionDetails';
import { SummaryCards } from '../nutrition/SummaryCards';
import { servingsText } from './RecipesScreen';

export function RecipeScreen({ recipeId, onEdit }: { recipeId: string; onEdit?: () => void }) {
  const profile = useSelectedProfile();
  const { api } = useServices();
  const recipe = useQuery({
    queryKey: queryKeys.recipe(profile.id, recipeId),
    queryFn: ({ signal }) => getRecipe(api, profile.id, recipeId, signal),
  });
  const nutrition = useQuery({
    queryKey: queryKeys.recipeNutrition(profile.id, recipeId),
    queryFn: ({ signal }) => getRecipeNutrition(api, profile.id, recipeId, signal),
    enabled: !!recipe.data?.current_version,
  });

  const version = recipe.data?.current_version ?? null;
  return (
    <Screen testID="recipe-screen">
      {recipe.isPending ? <LoadingState /> : null}
      {recipe.isError ? <ErrorState error={recipe.error} onRetry={() => void recipe.refetch()} /> : null}
      {recipe.data ? (
        <>
          <Text variant="title">{recipe.data.title}</Text>
          {version ? (
            <Text variant="small" testID="recipe-version">
              {t('recipes.version', { number: version.version_number, total: recipe.data.version_count })}
            </Text>
          ) : (
            <Notice testID="recipe-no-version">{t('recipes.noVersion')}</Notice>
          )}
        </>
      ) : null}
      {version ? (
        <>
          {onEdit && canManageRecipes(profile.access_scope) ? <Button label={t('recipeEdit.edit')} variant="secondary" onPress={onEdit} testID="edit-recipe" /> : null}
          {version.description ? <Text>{version.description}</Text> : null}
          <Text testID="recipe-servings">{servingsText(version.servings)}</Text>
          {nutrition.isPending ? <LoadingState /> : null}
          {nutrition.isError ? <ErrorState error={nutrition.error} onRetry={() => void nutrition.refetch()} /> : null}
          {nutrition.data ? <RecipeNutritionView nutrition={nutrition.data} /> : null}
          <Ingredients version={version} statuses={nutrition.data?.recipe_version_id === version.id ? nutrition.data.ingredients : []} />
          <Steps version={version} />
        </>
      ) : null}
    </Screen>
  );
}

type Basis = 'per_serving' | 'whole_recipe';

export function RecipeNutritionView({ nutrition }: { nutrition: RecipeNutrition }) {
  const perServing = nutrition.per_serving;
  const [chosen, setChosen] = useState<Basis>('per_serving');
  const basis: Basis = perServing ? chosen : 'whole_recipe';
  const view = basis === 'per_serving' && perServing ? perServing : nutrition.whole_recipe;
  const uncounted = nutrition.ingredient_count - nutrition.calculated_ingredient_count;
  return (
    <View style={{ gap: theme.space.sm }} testID="recipe-nutrition">
      <Text variant="heading">{t('recipes.nutrition.title')}</Text>
      {perServing ? (
        <ChoiceRow>
          <Choice label={t('recipes.nutrition.perServing')} selected={basis === 'per_serving'} onPress={() => setChosen('per_serving')} testID="basis-per-serving" />
          <Choice label={t('recipes.nutrition.wholeRecipe')} selected={basis === 'whole_recipe'} onPress={() => setChosen('whole_recipe')} testID="basis-whole-recipe" />
        </ChoiceRow>
      ) : (
        <Notice testID="per-serving-unavailable">{t('recipes.nutrition.noPerServing')}</Notice>
      )}
      <Text variant="small" testID="recipe-nutrition-basis">
        {basis === 'per_serving' ? t('recipes.nutrition.perServingLine') : t('recipes.nutrition.wholeRecipeLine')}
      </Text>
      {uncounted > 0 ? (
        <Text variant="small" testID="recipe-uncounted">
          {t('recipes.nutrition.uncounted', { uncounted, total: nutrition.ingredient_count })}
        </Text>
      ) : null}
      <SummaryCards summary={view.summary} wording="ingredients" testID="recipe-summary" />
      <NutritionDetails key={basis} rows={view.nutrients.map((n) => fromAggregate(n, 'recipes.state.partial'))} testID="recipe-details" />
    </View>
  );
}

/** Why the server did not count an ingredient; an unknown status gets a generic reason. */
export function ingredientStatusText(status: string): string | null {
  if (status === 'calculated') return null;
  const key = `recipes.ingredient.${status}`;
  return key in en ? t(key as MessageKey) : t('recipes.ingredient.other');
}

function Ingredients({ version, statuses }: { version: RecipeVersion; statuses: RecipeNutrition['ingredients'] }) {
  const statusById = new Map(statuses.map((s) => [s.ingredient_id, s.nutrition_status]));
  return (
    <View style={{ gap: theme.space.xs }} testID="recipe-ingredients">
      <Text variant="heading">{t('recipes.ingredients')}</Text>
      {version.ingredients.map((ingredient) => {
        const status = statusById.get(ingredient.id);
        const reason = status ? ingredientStatusText(status) : null;
        return (
          <Card key={ingredient.id} testID={`ingredient-${ingredient.id}`} accessibilityLabel={[ingredient.text, reason].filter(Boolean).join('. ')}>
            <Text>{ingredient.text}</Text>
            {reason ? (
              <Text variant="small" testID={`ingredient-status-${ingredient.id}`}>
                {reason}
              </Text>
            ) : null}
          </Card>
        );
      })}
    </View>
  );
}

function Steps({ version }: { version: RecipeVersion }) {
  if (!version.instructions.length) return null;
  return (
    <View style={{ gap: theme.space.xs }} testID="recipe-steps">
      <Text variant="heading">{t('recipes.steps')}</Text>
      {version.instructions.map((step) => (
        <Text key={step.id}>{t('recipes.step', { number: step.step_number, text: step.text })}</Text>
      ))}
    </View>
  );
}
