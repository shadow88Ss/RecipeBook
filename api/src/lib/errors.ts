// Layer 4A — typed error model (30_API.md §6, Layer 4A spec §8).
//
// AppError is the only vocabulary route/service code should use to signal a
// client-facing failure. The error handler middleware (src/middleware/
// errorHandler.ts) is the single place that turns an AppError — or any other
// thrown value — into the stable JSON error envelope. Nothing else in the
// codebase should hand-construct an error response body.

export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  /** Layer 11D — an external dependency could not answer (no detail given). */
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
};

/**
 * A client-facing error. `message` and `details` must never contain a stack
 * trace, SQL text, internal identifiers, tokens, secrets, or health data —
 * they are returned verbatim to the API caller (Layer 4A spec §8).
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = STATUS_BY_CODE[code];
    if (details !== undefined) this.details = details;
  }

  static validation(message: string, details?: Record<string, unknown>): AppError {
    return new AppError(ErrorCode.VALIDATION_ERROR, message, details);
  }

  static unauthenticated(message = 'Authentication is required.'): AppError {
    return new AppError(ErrorCode.UNAUTHENTICATED, message);
  }

  static forbidden(message = 'You do not have access to this resource.'): AppError {
    return new AppError(ErrorCode.FORBIDDEN, message);
  }

  /**
   * Non-disclosing "not found": used both for a resource that truly does not
   * exist and for one that exists but the caller is not authorized for
   * (Layer 4A spec §15 / Testing item E). Returning the same code+message in
   * both cases is deliberate — it never confirms or denies existence of a
   * resource the caller cannot access.
   */
  static notFound(message = 'Resource not found.'): AppError {
    return new AppError(ErrorCode.NOT_FOUND, message);
  }

  static conflict(message: string, details?: Record<string, unknown>): AppError {
    return new AppError(ErrorCode.CONFLICT, message, details);
  }

  static rateLimited(message = 'Too many requests.'): AppError {
    return new AppError(ErrorCode.RATE_LIMITED, message);
  }

  static internal(message = 'An unexpected error occurred.'): AppError {
    return new AppError(ErrorCode.INTERNAL_ERROR, message);
  }

  static unavailable(message = 'This service is temporarily unavailable.'): AppError {
    return new AppError(ErrorCode.SERVICE_UNAVAILABLE, message);
  }
}
