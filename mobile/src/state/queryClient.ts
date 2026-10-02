// Layer 12A §29–30 — server state.
//
// TanStack Query holds API responses in memory only (never persisted to
// disk): it gives loading/error/refetch states, request de-duplication and
// cancellation without hand-written caching. The cache is never authoritative
// — the API is — and it is cleared on sign-out and session expiry.

import { QueryClient, type QueryKey } from '@tanstack/react-query';

import { isApiError, isRetryable } from '../api/errors';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: (failureCount, error) => failureCount < 2 && isRetryable(error) && !(isApiError(error) && error.kind === 'rate_limited'),
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
}

export const queryKeys = {
  profiles: (userId: string | null) => ['profiles', userId] as const,
  dailyTrackerRoot: (profileId: string) => ['daily-tracker', profileId] as const,
  dailyTracker: (profileId: string, date: string, timezone: string) => ['daily-tracker', profileId, date, timezone] as const,
  progress: (profileId: string, from: string, to: string, timezone: string) => ['progress', profileId, from, to, timezone] as const,
  // Layer 12B — global reference data (not profile-scoped) and server previews.
  foodSearch: (q: string) => ['food-search', q] as const,
  productSearch: (q: string) => ['product-search', q] as const,
  food: (foodId: string) => ['food', foodId] as const,
  product: (productId: string) => ['product', productId] as const,
  units: () => ['units'] as const,
  preview: (kind: 'food' | 'product', id: string, amount: string) => ['nutrition-preview', kind, id, amount] as const,
  barcode: (code: string) => ['barcode', code] as const,
} satisfies Record<string, (...args: never[]) => QueryKey>;

/**
 * Call after any write that changes consumption or targets for a Profile
 * (meal logging, corrections, target snapshots — Layer 12B onwards), so every
 * cached day of that Profile's Daily Tracker and Progress is re-read.
 */
export async function invalidateAfterNutritionWrite(client: QueryClient, profileId: string): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.dailyTrackerRoot(profileId) }),
    client.invalidateQueries({ queryKey: ['progress', profileId] }),
  ]);
}
