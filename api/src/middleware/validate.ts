// Layer 4A §2 — reusable runtime validation at API trust boundaries
// (30_API.md §3). One factory used by every route instead of duplicating
// parsing logic inline.
//
// Unknown-field policy (Layer 4A spec Testing item M — "unexpected request
// fields, handled according to approved validation policy"): schemas built
// with plain `z.object(...)` (the default used throughout this codebase,
// never `.strict()`) silently strip fields the schema does not declare,
// rather than rejecting the request. This is a deliberate choice for
// forward/backward compatibility across mobile app versions — an older or
// newer client sending an extra field it no longer/not-yet uses must not
// hard-fail a request. Only fields the schema actually declares are
// validated and passed through; anything else never reaches domain code.

import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';
import { AppError } from '../lib/errors';

export interface ValidationTargets {
  params?: ZodType;
  query?: ZodType;
  body?: ZodType;
}

export function validate({ params, query, body }: ValidationTargets) {
  return function validateRequest(req: Request, _res: Response, next: NextFunction): void {
    if (params) {
      const result = params.safeParse(req.params);
      if (!result.success) {
        next(AppError.validation('Invalid path parameters.', { issues: formatIssues(result.error) }));
        return;
      }
      req.params = result.data as typeof req.params;
    }

    if (query) {
      const result = query.safeParse(req.query);
      if (!result.success) {
        next(AppError.validation('Invalid query parameters.', { issues: formatIssues(result.error) }));
        return;
      }
      // req.query is otherwise read-only-typed in Express 5; assign via the
      // documented escape hatch of replacing the whole object.
      Object.defineProperty(req, 'query', { value: result.data, writable: true, configurable: true });
    }

    if (body) {
      const result = body.safeParse(req.body);
      if (!result.success) {
        next(AppError.validation('Invalid request body.', { issues: formatIssues(result.error) }));
        return;
      }
      req.body = result.data;
    }

    next();
  };
}

function formatIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): Array<{
  path: string;
  message: string;
}> {
  return error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}
