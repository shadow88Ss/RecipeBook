// Layer 12A §22–23 — Profile selection context.
//
// Holds which Profile the user is looking at, its display info and the
// access_scope the API returned — for display only. It grants nothing: every
// request carries the profile id in the path and the API decides (RLS +
// scope policies). A single Profile is selected automatically.

import { useQuery } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import type { Profile } from '../api/contracts/profile';
import { listAllProfiles } from '../api/endpoints';
import { useAuth } from '../auth/AuthProvider';
import { useServices } from '../state/AppProviders';
import { queryKeys } from '../state/queryClient';

export interface ProfileContextValue {
  status: 'idle' | 'loading' | 'error' | 'ready';
  profiles: Profile[];
  selected: Profile | null;
  error: unknown;
  select(profileId: string): void;
  clearSelection(): void;
  refetch(): void;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

export function useProfiles(): ProfileContextValue {
  const value = useContext(ProfileContext);
  if (!value) throw new Error('useProfiles must be used inside ProfileProvider');
  return value;
}

/** The selected Profile; only call below the "profile selected" navigation guard. */
export function useSelectedProfile(): Profile {
  const { selected } = useProfiles();
  if (!selected) throw new Error('No Profile selected');
  return selected;
}

export function ProfileProvider({ children }: { children: ReactNode }) {
  const { api } = useServices();
  const { status: authStatus, userId } = useAuth();
  const signedIn = authStatus === 'signed_in';
  // The selection is tied to the user who made it, so a different user (or a
  // sign-out) never inherits it.
  const [selection, setSelection] = useState<{ userId: string; profileId: string } | null>(null);
  const selectedId = selection && selection.userId === userId ? selection.profileId : null;

  const query = useQuery({
    queryKey: queryKeys.profiles(userId),
    queryFn: ({ signal }) => listAllProfiles(api, signal),
    enabled: signedIn,
  });

  const profiles = useMemo(() => query.data ?? [], [query.data]);
  const selected = useMemo(() => {
    if (!signedIn) return null;
    const explicit = selectedId ? profiles.find((p) => p.id === selectedId) : undefined;
    if (explicit) return explicit;
    return profiles.length === 1 ? profiles[0]! : null;
  }, [signedIn, selectedId, profiles]);

  const select = useCallback((id: string) => setSelection(userId ? { userId, profileId: id } : null), [userId]);
  const clearSelection = useCallback(() => setSelection(null), []);
  const { refetch } = query;

  const value = useMemo<ProfileContextValue>(
    () => ({
      status: !signedIn ? 'idle' : query.isPending ? 'loading' : query.isError ? 'error' : 'ready',
      profiles,
      selected,
      error: query.error,
      select,
      clearSelection,
      refetch: () => void refetch(),
    }),
    [signedIn, query.isPending, query.isError, query.error, profiles, selected, select, clearSelection, refetch],
  );

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}
