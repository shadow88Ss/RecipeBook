// Layer 4A §3 / Layer 12A.1 — Supabase JWT authentication middleware.
//
// Verifies the bearer token locally with the configured AccessTokenVerifier
// (JWKS for Supabase's asymmetric signing keys, and/or the explicitly
// enabled legacy HS256 secret — see src/lib/accessTokenVerifier.ts) and
// derives the caller's Account strictly from the verified `sub` claim.
// account_id is never accepted from a client-supplied header, query
// parameter, path parameter, or body field as authentication evidence
// (Layer 4A spec §3) — only this middleware may set `req.auth`.
//
// This is one layer of a defense-in-depth chain (Layer 4A spec §4):
// Supabase authentication (this middleware, and independently Supabase's
// own PostgREST verification of the same token) -> API Account/Profile
// authorization (src/domain/profiles) -> PostgreSQL RLS (already
// implemented and tested in Layers 1-3). This middleware being satisfied
// never substitutes for the RLS check that still runs on every database
// query issued with the caller's forwarded token.

import type { NextFunction, Request, Response } from 'express';
import { createAccessTokenVerifier, type AccessTokenVerifier } from '../lib/accessTokenVerifier';
import { AppError } from '../lib/errors';

const BEARER_PREFIX = 'Bearer ';

export type AuthMiddlewareOptions =
  | { verifier: AccessTokenVerifier }
  /** Legacy HS256 only, with no issuer check — the local test harness. */
  | { jwtSecret: string };

export function createAuthMiddleware(options: AuthMiddlewareOptions) {
  const verifier = 'verifier' in options ? options.verifier : createAccessTokenVerifier({ mode: 'legacy_hs256', legacySecret: options.jwtSecret });

  return async function requireAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const header = req.header('authorization');
    if (!header || !header.startsWith(BEARER_PREFIX)) {
      next(AppError.unauthenticated());
      return;
    }

    const token = header.slice(BEARER_PREFIX.length).trim();
    if (!token) {
      next(AppError.unauthenticated());
      return;
    }

    // Deliberately one generic outcome for every rejected token (bad
    // signature, expired, wrong issuer/audience/role, malformed, unknown
    // key) — the specific reason is never disclosed to the client, and the
    // token itself is never logged.
    const result = await verifier.verify(token);
    if (!result.ok) {
      next(
        result.reason === 'unavailable'
          ? // The signing keys could not be fetched: a temporary server
            // problem, not a bad token, so clients must not sign out.
            AppError.unavailable('Authentication is temporarily unavailable.')
          : AppError.unauthenticated(),
      );
      return;
    }

    req.auth = {
      accountId: result.accountId,
      accessToken: token,
    };
    next();
  };
}
