import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

import { AppError, ErrorCodes } from '../errors/AppError.js';

/**
 * The single place where any failure becomes an HTTP response
 * (IMPLEMENTATION_PLAN.md §4.2).
 *
 * Three sources are normalized into one envelope: explicit `AppError` throws,
 * `ZodError`s from boundary validation, and anything else. Because this exists,
 * routes contain no try/catch at all -- they validate, call a service, and
 * throw. That is a net *reduction* in code rather than added scope
 * (ASSUMPTIONS.md #21), which is the main argument for doing it up front.
 */

interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/** Express identifies an error handler by its arity -- all four parameters
 *  must be declared even though `next` is unused on most paths. */
export function errorHandler(
  error: unknown,
  _request: Request,
  response: Response,
  next: NextFunction,
): void {
  // If headers are already sent the response is mid-flight and cannot be
  // rewritten; the only correct move is to hand off to Express's default
  // handler, which destroys the socket rather than emitting a corrupt body.
  if (response.headersSent) {
    next(error);
    return;
  }

  const { status, body } = toEnvelope(error);

  // Only 5xx is logged as an error. 4xx is expected traffic -- a user typing a
  // bad password is not an incident, and logging it at error level is how a log
  // becomes noise that nobody reads (ASSUMPTIONS.md #21).
  if (status >= 500) {
    console.error('[error]', {
      code: body.error.code,
      status,
      // The original error, not the sanitized message: the envelope
      // deliberately hides internals from the client, so the log is the only
      // place the real cause survives.
      cause: error instanceof Error ? error.stack : error,
    });
  }

  response.status(status).json(body);
}

function toEnvelope(error: unknown): { status: number; body: ErrorEnvelope } {
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      },
    };
  }

  if (error instanceof ZodError) {
    return {
      status: 400,
      body: {
        error: {
          code: ErrorCodes.VALIDATION_FAILED,
          message: 'Request validation failed',
          // `.flatten().fieldErrors` rather than the raw issue array: it is
          // already shaped as { field: [messages] }, which is what a form UI
          // needs to put a message next to the offending input.
          details: error.flatten().fieldErrors,
        },
      },
    };
  }

  // A malformed JSON body surfaces as a SyntaxError from body-parser with a
  // `status` already attached. Without this branch it would be reported as a
  // 500 -- blaming the server for what is a client mistake, and paging on it.
  if (isBodyParserSyntaxError(error)) {
    return {
      status: 400,
      body: {
        error: {
          code: ErrorCodes.VALIDATION_FAILED,
          message: 'Malformed JSON body',
        },
      },
    };
  }

  // A database constraint rejecting the write means the input violated a rule
  // the schema documents — a client error, not a server fault. Reported as 400
  // rather than 500 so it is not logged as an incident and does not page
  // anyone.
  //
  // This is a backstop, not the primary defence: every such rule is also
  // enforced at the Zod boundary or in a service, where the message can name
  // the offending field. Reaching here means one of those was missed, so the
  // constraint name is surfaced to make the gap findable rather than silent.
  const constraint = postgresConstraintViolation(error);
  if (constraint !== null) {
    return {
      status: 400,
      body: {
        error: {
          code: ErrorCodes.VALIDATION_FAILED,
          message: 'That change violates a data rule for this record',
          details: { constraint },
        },
      },
    };
  }

  // Deliberately generic. An unexpected error can carry a driver message, a
  // connection string, or a fragment of a query; none of that belongs in a
  // response body. The detail is in the log written above.
  return {
    status: 500,
    body: {
      error: {
        code: ErrorCodes.INTERNAL,
        message: 'An unexpected error occurred',
      },
    },
  };
}

/** Postgres CHECK (23514), foreign key (23503) and NOT NULL (23502)
 *  violations. Unique violations (23505) are deliberately excluded: those carry
 *  real meaning per table and are already translated by the services that can
 *  say what they mean (duplicate email, reused idempotency key). */
const CONSTRAINT_VIOLATION_CODES = new Set(['23514', '23503', '23502']);

function postgresConstraintViolation(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;

  const candidate = error as { code?: unknown; constraint?: unknown };
  if (typeof candidate.code !== 'string' || !CONSTRAINT_VIOLATION_CODES.has(candidate.code)) {
    return null;
  }

  return typeof candidate.constraint === 'string' ? candidate.constraint : candidate.code;
}

function isBodyParserSyntaxError(error: unknown): boolean {
  return (
    error instanceof SyntaxError &&
    'status' in error &&
    (error as { status?: unknown }).status === 400 &&
    'body' in error
  );
}

/**
 * Terminal 404 handler. Registered after all routes so an unmatched path
 * produces the same envelope as every other failure, rather than Express's
 * default HTML error page -- a client parsing `error.code` should never have
 * to special-case one route being missing.
 */
export function notFoundHandler(
  _request: Request,
  response: Response,
): void {
  response.status(404).json({
    error: {
      code: ErrorCodes.NOT_FOUND,
      message: 'Route not found',
    },
  } satisfies ErrorEnvelope);
}
