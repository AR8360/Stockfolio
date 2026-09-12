import jwt from 'jsonwebtoken';
import { z } from 'zod';

import { env } from '../config/env.js';
import { unauthorized } from '../errors/AppError.js';
import type { UserId } from '../database/users.js';

/**
 * JWT issue/verify (IMPLEMENTATION_PLAN.md §4.4, ASSUMPTIONS.md #26).
 *
 * Stateless and 7-day, with the accepted trade-off that a token cannot be
 * revoked before it expires. Isolated here rather than inlined into the
 * service so the security-relevant choices below sit in one reviewable place.
 */

const ALGORITHM = 'HS256' as const;
const EXPIRES_IN = '7d';

/**
 * A token is untrusted input -- it arrives from the client -- so its decoded
 * payload is validated like any other external data (CLAUDE.md boundary rule),
 * not merely cast. `jwt.verify` proves the signature and expiry; it says
 * nothing about the payload containing the fields this application expects.
 */
const tokenPayloadSchema = z.object({
  sub: z.string().min(1),
});

export function signAccessToken(userId: UserId): string {
  return jwt.sign({}, env.JWT_SECRET, {
    subject: userId,
    algorithm: ALGORITHM,
    expiresIn: EXPIRES_IN,
  });
}

/**
 * Returns the user id, or throws `UNAUTHORIZED`.
 *
 * `algorithms` is pinned explicitly. Without it, the library will honour
 * whatever algorithm the token's own header names -- so an attacker can
 * present a token declaring `alg: none`, or trick an HMAC verifier into
 * treating an RSA public key as a shared secret. Pinning the single algorithm
 * this application issues closes that class of attack, and it costs one line.
 */
export function verifyAccessToken(token: string): UserId {
  let decoded: unknown;

  try {
    decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: [ALGORITHM] });
  } catch {
    // Expired, tampered, wrong secret and malformed all collapse to the same
    // response. Distinguishing them for the client tells an attacker which
    // part of a forged token to fix next, and no legitimate client acts
    // differently on the difference.
    throw unauthorized('Invalid or expired token');
  }

  const parsed = tokenPayloadSchema.safeParse(decoded);
  if (!parsed.success) {
    throw unauthorized('Invalid or expired token');
  }

  return parsed.data.sub;
}

/**
 * Pulls a bearer token out of an Authorization header.
 *
 * Returns null rather than throwing, so the caller decides whether a missing
 * token is an error -- the same parsing is wanted on routes that merely
 * *prefer* a token. The scheme comparison is case-insensitive because RFC 7235
 * defines it that way and some clients send "bearer".
 */
export function extractBearerToken(header: string | undefined): string | null {
  if (header === undefined) {
    return null;
  }

  const [scheme, ...rest] = header.split(' ');
  if (scheme === undefined || scheme.toLowerCase() !== 'bearer') {
    return null;
  }

  const token = rest.join(' ').trim();
  return token.length > 0 ? token : null;
}
