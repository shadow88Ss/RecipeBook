// Layer 12A §16 — safe error mapping.
//
// Every failure from the API client becomes an ApiError with a `kind`. Screens
// show a translated message for the kind (and the request id for support);
// server messages, stack traces and SQL are never shown or logged.

export type ApiErrorKind =
  | 'validation' // 400
  | 'unauthenticated' // 401, or no session
  | 'forbidden' // 403
  | 'not_found' // 404
  | 'conflict' // 409
  | 'rate_limited' // 429
  | 'unavailable' // 503
  | 'server' // 500 and anything else unexpected from the server
  | 'timeout'
  | 'offline'
  | 'invalid_response'; // the body did not match the documented contract

export interface ValidationIssue {
  path: string;
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  readonly code: string | null;
  readonly requestId: string | null;
  readonly retryAfterSeconds: number | null;
  readonly issues: ValidationIssue[];

  constructor(
    kind: ApiErrorKind,
    init: { status?: number | null; code?: string | null; requestId?: string | null; retryAfterSeconds?: number | null; issues?: ValidationIssue[] } = {},
  ) {
    // The message is the kind only: nothing from the server body is kept as text.
    super(`api_error:${kind}`);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = init.status ?? null;
    this.code = init.code ?? null;
    this.requestId = init.requestId ?? null;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
    this.issues = init.issues ?? [];
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function kindForStatus(status: number): ApiErrorKind {
  switch (status) {
    case 400:
      return 'validation';
    case 401:
      return 'unauthenticated';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 429:
      return 'rate_limited';
    case 503:
      return 'unavailable';
    default:
      return 'server';
  }
}

/** Whether a retry (by the user or the query layer) could plausibly succeed. */
export function isRetryable(error: unknown): boolean {
  if (!isApiError(error)) return false;
  return error.kind === 'offline' || error.kind === 'timeout' || error.kind === 'server' || error.kind === 'unavailable' || error.kind === 'rate_limited';
}
