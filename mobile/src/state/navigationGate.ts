// Layer 12A §18 — which flow the user is in. Used by the root layout's
// Stack.Protected guards (and by tests, which render the same decision).

import type { AuthStatus } from '../auth/AuthProvider';

export type Gate = 'restoring' | 'auth' | 'select-profile' | 'app';

export function navigationGate(authStatus: AuthStatus, hasSelectedProfile: boolean): Gate {
  if (authStatus === 'restoring') return 'restoring';
  if (authStatus === 'signed_out') return 'auth';
  return hasSelectedProfile ? 'app' : 'select-profile';
}
