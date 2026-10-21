// Layer 12C — Grocery lists: every generated list of the Profile
// (GET /v1/profiles/{id}/grocery-lists), newest first. A list is generated
// from a confirmed meal plan on the server; this screen only shows them. A
// list replaced by a newer generation is labelled so.

import { useInfiniteQuery } from '@tanstack/react-query';

import type { GroceryListSummary } from '../../api/contracts/groceries';
import { listGroceryLists } from '../../api/endpoints';
import { t } from '../../i18n';
import { useSelectedProfile } from '../../profile/ProfileProvider';
import { useServices } from '../../state/AppProviders';
import { queryKeys } from '../../state/queryClient';
import { Button, EmptyState, ErrorState, LoadingState, Row, Screen, Text } from '../../ui';
import { planDatesText } from '../plan/MealPlansScreen';

export function GroceryListsScreen({ onOpen }: { onOpen: (listId: string) => void }) {
  const profile = useSelectedProfile();
  const { api } = useServices();
  const query = useInfiniteQuery({
    queryKey: queryKeys.groceryLists(profile.id),
    queryFn: ({ pageParam, signal }) => listGroceryLists(api, profile.id, pageParam, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.pagination.nextCursor,
  });
  const lists = query.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <Screen testID="grocery-lists-screen">
      <Text variant="title">{t('grocery.title')}</Text>
      <Text variant="muted">{profile.display_name}</Text>
      {query.isPending ? <LoadingState /> : null}
      {query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : null}
      {query.data && !lists.length ? <EmptyState message={t('grocery.empty')} testID="grocery-empty" /> : null}
      {lists.map((list) => (
        <ListRow key={list.id} list={list} onPress={() => onOpen(list.id)} />
      ))}
      {query.hasNextPage ? (
        <Button label={t('common.loadMore')} variant="secondary" onPress={() => void query.fetchNextPage()} disabled={query.isFetchingNextPage} testID="grocery-more" />
      ) : null}
    </Screen>
  );
}

export function listTitle(list: { plan_context: { start_date: string; end_date: string } }): string {
  return t('grocery.listFor', { dates: planDatesText(list.plan_context) });
}

function ListRow({ list, onPress }: { list: GroceryListSummary; onPress: () => void }) {
  const title = listTitle(list);
  const line = [t('grocery.generation', { number: list.generation_number }), list.status === 'superseded' ? t('grocery.superseded') : null].filter(Boolean).join(' · ');
  return (
    <Row onPress={onPress} accessibilityLabel={`${title}. ${line}`} testID={`grocery-list-${list.id}`}>
      <Text variant="heading">{title}</Text>
      <Text variant="small">{line}</Text>
    </Row>
  );
}
