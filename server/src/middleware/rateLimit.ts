import type { NextFunction, Request, Response } from 'express';

import { AppError, ErrorCodes } from '../errors/AppError.js';

/**
 * Fixed-window rate limiter (IMPLEMENTATION_PLAN.md §4.6, ASSUMPTIONS.md #25).
 *
 * Simplified from the plan: a fixed window rather than a sliding one, so a
 * client can in principle send 2x the limit across a window boundary. Accepted
 * because the goal here is protecting a free-tier upstream quota from
 * autocomplete bursts, not precise fairness — and a fixed window is a third of
 * the code with no dependency.
 *
 * In-process, so the counters are per-instance. Correct for the single-process
 * deployment; a shared store would be needed across instances (noted as a gap).
 */

interface Window {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  name: string;
}

export function rateLimit(options: RateLimitOptions) {
  const windows = new Map<string, Window>();

  return function rateLimitMiddleware(
    request: Request,
    response: Response,
    next: NextFunction,
  ): void {
    const now = Date.now();
    const key = clientKey(request);
    const existing = windows.get(key);

    if (!existing || now >= existing.resetAt) {
      windows.set(key, { count: 1, resetAt: now + options.windowMs });
      // Sweep opportunistically rather than on a timer: an interval would keep
      // the process alive and needs teardown in tests. The map only grows
      // while traffic does, and entries are dropped once expired.
      if (windows.size > 5_000) {
        for (const [k, w] of windows) if (now >= w.resetAt) windows.delete(k);
      }
      next();
      return;
    }

    existing.count += 1;

    if (existing.count > options.max) {
      const retryAfter = Math.ceil((existing.resetAt - now) / 1000);
      response.setHeader('Retry-After', String(retryAfter));
      next(
        new AppError({
          status: 429,
          code: ErrorCodes.RATE_LIMITED,
          message: `Too many requests. Try again in ${String(retryAfter)}s.`,
        }),
      );
      return;
    }

    next();
  };
}

/**
 * `req.ip` honours `trust proxy`, which the app sets because it runs behind a
 * platform proxy — without it every request appears to come from the proxy and
 * one user's burst would rate-limit everybody.
 */
function clientKey(request: Request): string {
  return request.ip ?? request.socket.remoteAddress ?? 'unknown';
}

/** Shared limiter for public routes. */
export const publicLimiter = rateLimit({ windowMs: 60_000, max: 120, name: 'public' });

/**
 * Dedicated limiter for search.
 *
 * Originally set to 30/min on the reasoning that search is the cheapest
 * endpoint to call repeatedly and the most likely path to exhaust the upstream
 * quota. That reasoning was wrong, and it showed up in real use: a person
 * exploring the dashboard — typing a query, backspacing, trying another — hit
 * the limit and got "Too many requests" on a feature that was working fine.
 *
 * What it missed is that the search cache (§4.5) holds results for five
 * minutes, so repeated and near-identical queries never reach the provider at
 * all. The limiter was therefore throttling cache hits, which protects nothing
 * upstream while making the app look broken.
 *
 * Now matched to the general public limit: still a real ceiling against
 * scripted abuse, but comfortably above what a human can produce by typing.
 */
export const searchLimiter = rateLimit({ windowMs: 60_000, max: 120, name: 'search' });
