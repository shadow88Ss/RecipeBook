// Layer 12A §29 — the provider tree. Auth state, selected-Profile state,
// server state (TanStack Query) and screen-local UI state stay separate.

import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider } from '../auth/AuthProvider';
import { ProfileProvider } from '../profile/ProfileProvider';
import { createQueryClient } from './queryClient';
import type { Services } from './services';

const ServicesContext = createContext<Services | null>(null);

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('useServices must be used inside AppProviders');
  return services;
}

export function AppProviders({ services, queryClient, children }: { services: Services; queryClient?: QueryClient; children: ReactNode }) {
  const [client] = useState(() => queryClient ?? createQueryClient());
  return (
    <SafeAreaProvider>
      <ServicesContext.Provider value={services}>
        <QueryClientProvider client={client}>
          <AuthProvider>
            <ProfileProvider>{children}</ProfileProvider>
          </AuthProvider>
        </QueryClientProvider>
      </ServicesContext.Provider>
    </SafeAreaProvider>
  );
}
