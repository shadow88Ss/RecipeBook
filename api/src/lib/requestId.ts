// Layer 4A §9 — request/correlation identifier.
//
// The id is an opaque random UUID: it carries no account/profile/session
// data, so it is always safe to log, echo to the client, and pass across
// service boundaries.

import { randomUUID } from 'node:crypto';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * A caller-supplied request id is trusted only as a correlation hint across
 * a chain of already-cooperating services — never as authorization or
 * identity evidence. It is accepted only if it is a syntactically plausible
 * opaque token, and is otherwise replaced, so a client can never inject
 * control characters, oversized values, or structured data into logs via
 * this header.
 */
const INBOUND_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

export function resolveRequestId(inbound: string | undefined): string {
  if (inbound && INBOUND_ID_PATTERN.test(inbound)) {
    return inbound;
  }
  return randomUUID();
}
