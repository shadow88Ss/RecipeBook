// Layer 4B — a small, generic, RLS-respecting database access abstraction
// shared by every new Layer 4B domain (Goal, NutritionTarget,
// ClinicianTarget, WeightMeasurement, EffectiveTarget). Layer 4A's
// Profile-specific ProfileRepository (src/domain/profiles/profile.
// repository.ts) is intentionally left untouched — this is a parallel,
// additive abstraction, not a replacement, so there is zero regression risk
// to the already-approved Layer 4A code path.
//
// Every ScopedDbClient is constructed per-request from the caller's own
// verified AuthContext (see supabaseScopedDb.ts) — there is no code path
// here that ever uses a service-role/elevated credential. RLS is always the
// final word: this abstraction only ever executes as the calling user.

export interface SelectOptions {
  /** A plain "col1, col2, ..." column list. Always supplied by this
   * codebase's own service code, never derived from client input. */
  columns: string;
  eq?: Record<string, string | boolean | number>;
  order?: { column: string; ascending?: boolean };
  limit?: number;
}

export interface ScopedDbClient {
  select<T>(table: string, opts: SelectOptions): Promise<T[]>;
  insert<T>(table: string, values: Record<string, unknown>, returningColumns: string): Promise<T>;
  /** Returns null when the row exists but RLS/the `eq` filter matched
   * nothing to update — never throws for "no matching row" specifically. */
  update<T>(table: string, eq: Record<string, unknown>, values: Record<string, unknown>, returningColumns: string): Promise<T | null>;
  rpc<T>(fn: string, args: Record<string, unknown>): Promise<T>;
}

export interface ScopedDbFactory {
  forUser(auth: import('../types/express').AuthContext): ScopedDbClient;
}

/** Table/column/function names passed into this abstraction come only from
 * this codebase's own TypeScript call sites, never directly from an HTTP
 * request — but every implementation still validates them against this
 * pattern before use in raw/PostgREST identifier positions, as defense in
 * depth against a future call-site mistake. */
export const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export function assertSafeIdentifier(name: string): void {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`Unsafe identifier rejected: ${name}`);
  }
}
