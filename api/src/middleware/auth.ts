// Layer 4A §3 — Supabase JWT authentication middleware.
//
// Verifies the bearer token locally (HS256, the project's JWT secret) and
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
import jwt from 'jsonwebtoken';
import { AppError } from '../lib/errors';

const BEARER_PREFIX = 'Bearer ';

/** Supabase Auth issues access tokens with this fixed audience claim for
 * ordinary authenticated API access. Rejecting anything else (e.g. a token
 * minted for a different purpose) is intentional, narrow scope-checking. */
const EXPECTED_AUDIENCE = 'authenticated';

export interface AuthMiddlewareOptions {
  jwtSecret: string;
}

export function createAuthMiddleware({ jwtSecret }: AuthMiddlewareOptions) {
  return function requireAuth(req: Request, _res: Response, next: NextFunction): void {
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

    let payload: jwt.JwtPayload;
    try {
      const verified = jwt.verify(token, jwtSecret, {
        algorithms: ['HS256'],
        audience: EXPECTED_AUDIENCE,
      });
      if (typeof verified === 'string' || !verified.sub) {
        next(AppError.unauthenticated());
        return;
      }
      payload = verified;
    } catch {
      // Deliberately one generic outcome for every verification failure
      // (bad signature, expired, wrong audience, malformed) — the specific
      // reason is never disclosed to the client, only ever to server logs
      // (and even there, never the token itself).
      next(AppError.unauthenticated());
      return;
    }

    req.auth = {
      accountId: payload.sub as string,
      accessToken: token,
    };
    next();
  };
}
