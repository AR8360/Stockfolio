/**
 * The single error type the application throws deliberately
 * (IMPLEMENTATION_PLAN.md §4.2, ASSUMPTIONS.md #21).
 *
 * The reason there is exactly one class rather than a hierarchy
 * (NotFoundError, ConflictError, ...) is that the error middleware needs to
 * answer only two questions -- what status, what code -- and a hierarchy
 * answers them with `instanceof` chains that have to be kept in sync with the
 * middleware. Carrying `status` and `code` as data means a new error type is a
 * new constant, not a new class plus a new branch in the handler.
 *
 * Note this class is for *expected* failures: the 4xx conditions the API
 * defines. Anything else that escapes -- a bug, a driver failure -- stays an
 * ordinary Error and is deliberately handled differently by the middleware
 * (logged, and reported as a generic 500 with no internals leaked).
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(args: {
    status: number;
    code: string;
    message: string;
    details?: unknown;
  }) {
    super(args.message);
    this.name = 'AppError';
    this.status = args.status;
    this.code = args.code;
    if (args.details !== undefined) {
      this.details = args.details;
    }

    // Without this, `instanceof AppError` is unreliable for a class extending
    // a built-in when the code is transpiled to an older target.
    Object.setPrototypeOf(this, new.target.prototype);
    Error.captureStackTrace?.(this, AppError);
  }
}

/**
 * Error codes are a closed set defined here rather than as free strings at
 * throw sites, so the API's failure vocabulary is greppable in one place and
 * the frontend can switch on it. Clients branch on `code`; `message` is for
 * humans and may be reworded without it counting as an API change.
 */
export const ErrorCodes = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  EMAIL_ALREADY_REGISTERED: 'EMAIL_ALREADY_REGISTERED',
  NOT_FOUND: 'NOT_FOUND',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  INSUFFICIENT_HOLDINGS: 'INSUFFICIENT_HOLDINGS',
  UNKNOWN_SYMBOL: 'UNKNOWN_SYMBOL',
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/* Constructors for the cases thrown from more than one place. Kept as
 * functions rather than subclasses for the reason given above. */

export const badRequest = (message: string, details?: unknown): AppError =>
  new AppError({
    status: 400,
    code: ErrorCodes.VALIDATION_FAILED,
    message,
    ...(details !== undefined ? { details } : {}),
  });

export const unauthorized = (message = 'Authentication required'): AppError =>
  new AppError({ status: 401, code: ErrorCodes.UNAUTHORIZED, message });

export const notFound = (message = 'Not found'): AppError =>
  new AppError({ status: 404, code: ErrorCodes.NOT_FOUND, message });

export const conflict = (code: ErrorCode, message: string): AppError =>
  new AppError({ status: 409, code, message });

/**
 * 502, not 500: the upstream market data provider failing is not this
 * application malfunctioning. The distinction matters operationally -- a 500
 * should page someone, a 502 from an unofficial, unsupported data source
 * (ASSUMPTIONS.md #12) is an expected weather condition, and the cache's
 * stale-while-revalidate path (§4.5) exists precisely so most of these never
 * reach the user at all.
 */
export const upstreamUnavailable = (
  message = 'Market data is temporarily unavailable',
): AppError =>
  new AppError({ status: 502, code: ErrorCodes.UPSTREAM_UNAVAILABLE, message });
