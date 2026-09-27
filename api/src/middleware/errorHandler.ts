// Layer 4A §8 — the single place an error becomes an HTTP response. Every
// route/service throws AppError (or lets an unexpected error propagate);
// nothing else in the codebase writes an error response body directly.
//
// Envelope (30_API.md §6 leaves the exact shape open beyond "stable code,
// safe message, no internals" — this fixes it for the foundation):
//   { "error": { "code": "...", "message": "...", "requestId": "...", "details"?: {...} } }
//
// An unexpected (non-AppError) failure is logged in full server-side —
// never sanitized in the log, so the real cause is diagnosable — but the
// client only ever receives a generic INTERNAL_ERROR with no stack trace,
// no SQL text, and no internal identifiers (spec §8, Testing item N).

import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors';
import type { Logger } from '../lib/logger';

export function createErrorHandler(logger: Logger) {
  return function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
    if (err instanceof AppError) {
      if (err.code === 'INTERNAL_ERROR') {
        logger.error({ requestId: req.requestId, err: serializeError(err) });
      }
      res.status(err.httpStatus).json({
        error: {
          code: err.code,
          message: err.message,
          requestId: req.requestId,
          ...(err.details ? { details: err.details } : {}),
        },
      });
      return;
    }

    logger.error({ requestId: req.requestId, err: serializeError(err) });
    const fallback = AppError.internal();
    res.status(fallback.httpStatus).json({
      error: {
        code: fallback.code,
        message: fallback.message,
        requestId: req.requestId,
      },
    });
  };
}

function serializeError(err: unknown): { message: string; stack?: string; name?: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, ...(err.stack ? { stack: err.stack } : {}) };
  }
  return { message: String(err) };
}
