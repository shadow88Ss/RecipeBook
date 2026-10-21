// Layer 12C — Recipe Book list: the selected Profile's own recipes
// (GET /v1/profiles/{id}/recipes), most recently updated first, with the
// server's title search and cursor paging. Every scope that can read the
// Profile can read its recipes; the server decides each request. Layer 12D
// adds "New recipe" for scopes that can manage recipes.

import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';

import type { RecipeListItem } from '../../api/contracts/recipes';
import { listRecipes } from '../../api/endpoints';
import { formatNumber, t, tp } from '../../i18n';
import { useSelectedProfile } from '../../profile/ProfileProvider';
import { canManageRecipes } from '../../profile/scope';
import { useServices } from '../../state/AppProviders';
import { queryKeys } from '../../state/queryClient';
import { Button, EmptyState, ErrorState, Input, LoadingState, Row, Screen, Text } from '../../ui';

export function RecipesScreen({ onOpen, onNew }: { onOpen: (recipeId: string) => void; onNew?: () => void }) {
  const profile = useSelectedProfile();
  const { api } = useServices();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');

  const query = useInfiniteQuery({
    queryKey: queryKeys.recipes(profile.id, q),
    queryFn: ({ pageParam, signal }) => listRecipes(api, profile.id, { q, cursor: pageParam }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.pagination.nextCursor,
  });

  const search = () => setQ(text.trim());
  const recipes = query.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <Screen testID="recipes-screen">
      <Text variant="title">{t('recipes.title')}</Text>
      <Text variant="muted">{profile.display_name}</Text>
      {onNew && canManageRecipes(profile.access_scope) ? <Button label={t('recipeEdit.newTitle')} onPress={onNew} testID="new-recipe" /> : null}
      <Input
        label={t('recipes.searchLabel')}
        value={text}
        onChangeText={setText}
        onSubmitEditing={search}
        returnKeyType="search"
        autoCorrect={false}
        maxLength={100}
        testID="recipe-search-input"
      />
      <Button label={t('log.search')} variant="secondary" onPress={search} testID="recipe-search-submit" />
      {query.isPending ? <LoadingState /> : null}
      {query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : null}
      {query.data && !recipes.length ? <EmptyState message={q ? t('recipes.noMatches', { q }) : t('recipes.empty')} testID="recipes-empty" /> : null}
      {recipes.map((recipe) => (
        <RecipeRow key={recipe.id} recipe={recipe} onPress={() => onOpen(recipe.id)} />
      ))}
      {query.hasNextPage ? (
        <Button label={t('common.loadMore')} variant="secondary" onPress={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage} testID="recipes-more" />
      ) : null}
    </Screen>
  );
}

export function servingsText(servings: number | null): string {
  return servings === null ? t('recipes.servingsNotDefined') : tp('recipes.servings', servings, { count: formatNumber(servings, 2) });
}

function RecipeRow({ recipe, onPress }: { recipe: RecipeListItem; onPress: () => void }) {
  const servings = servingsText(recipe.servings);
  return (
    <Row onPress={onPress} accessibilityLabel={`${recipe.title}. ${servings}`} testID={`recipe-${recipe.id}`}>
      <Text variant="heading">{recipe.title}</Text>
      <Text variant="small">{servings}</Text>
    </Row>
  );
}
