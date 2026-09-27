// Augments Express's Request with the authenticated context attached by
// src/middleware/auth.ts. `accountId` is derived ONLY from the verified
// Supabase JWT's `sub` claim — never from a client-supplied body/query/path
// value (Layer 4A spec §3).

export interface AuthContext {
  /** Always equal to the verified token's `sub` claim, i.e. Supabase
   * `auth.users.id`, i.e. `account.id` (37_Authentication_and_Login.md §2). */
  accountId: string;
  /** The verified, still-encoded bearer token, forwarded to Supabase's
   * PostgREST/RPC endpoints so RLS evaluates as this specific user — never
   * logged, never returned to the client (Layer 4A spec §10, §17). */
  accessToken: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      /** Set by middleware/requestId.ts before any handler runs. */
      requestId: string;
    }
  }
}

export {};
