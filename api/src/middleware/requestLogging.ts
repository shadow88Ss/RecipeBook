// Layer 4A §10 — safe structured request logging.
//
// Deliberately logs a fixed, small, explicitly-named set of fields only —
// it never passes the raw req/res objects (headers, body, query) to the
// logger, so there is no path by which an Authorization header, a token, or
// a request body containing health/child data can reach a log line from
// here. Route/service code must not separately log request or response
// bodies either (spec §10) — this middleware is the one place HTTP-level
// logging happens.

import type { NextFunction, Request, Response } from 'express';
import type { Logger } from '../lib/logger';

export function createRequestLogging(logger: Logger) {
  return function requestLogging(req: Request, res: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint();

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      logger.info({
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        accountId: req.auth?.accountId,
      });
    });

    next();
  };
}
