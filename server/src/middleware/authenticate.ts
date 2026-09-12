import type { NextFunction, Request, Response } from 'express';

import { extractBearerToken, verifyAccessToken } from '../auth/tokens.js';
import { unauthorized } from '../errors/AppError.js';

/**
 * Verifies the bearer token and attaches `request.userId`
 * (IMPLEMENTATION_PLAN.md §4.4).
 *
 * Deliberately dumb: no database call, no user lookup, no role resolution.
 * Two reasons. It keeps every authenticated route from paying for a query it
 * may not need -- `POST /transactions` only needs the id, to look up the
 * portfolio it was going to join to anyway. And it keeps the middleware
 * synchronous in spirit, so "is this request authenticated" cannot fail
 * because the database is briefly unreachable.
 *
 * The cost of that choice, stated plainly: a token for a since-deleted user
 * passes this middleware. Routes that care call `AuthService.getCurrentUser`,
 * which rejects it.
 */
export function authenticate(
  request: Request,
  _response: Response,
  next: NextFunction,
): void {
  const token = extractBearerToken(request.headers.authorization);

  if (token === null) {
    next(unauthorized('Authentication required'));
    return;
  }

  try {
    request.userId = verifyAccessToken(token);
    next();
  } catch (error) {
    // Passed to `next` rather than thrown. Express 4 does not catch a throw
    // from an async boundary, and routing it through `next` is what puts it in
    // front of the error middleware in every case.
    next(error);
  }
}

/**
 * Reads the id the middleware attached.
 *
 * Exists so routes never write `request.userId!`. The non-null assertion would
 * be correct wherever `authenticate` ran, and silently wrong on a route where
 * someone forgot to register it -- producing `undefined` as a user id and, at
 * worst, a query that matches nothing rather than an error. This throws
 * instead, loudly, at the point the mistake was made.
 */
export function requireUserId(request: Request): string {
  const { userId } = request;

  if (userId === undefined) {
    throw new Error(
      'requireUserId called on a route without the authenticate middleware',
    );
  }

  return userId;
}
