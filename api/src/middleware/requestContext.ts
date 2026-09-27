// Layer 4A §9 — assigns/propagates the request/correlation id before any
// other middleware or route handler runs, so every log line and error
// response for this request can carry it.

import type { NextFunction, Request, Response } from 'express';
import { REQUEST_ID_HEADER, resolveRequestId } from '../lib/requestId';

export function requestContext(req: Request, res: Response, next: NextFunction): void {
  const requestId = resolveRequestId(req.header(REQUEST_ID_HEADER));
  req.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  next();
}
