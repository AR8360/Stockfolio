import bcrypt from 'bcrypt';

import { AppError, ErrorCodes } from '../errors/AppError.js';
import { signAccessToken } from '../auth/tokens.js';
import type { Database } from '../database/pool.js';
import {
  DEFAULT_PORTFOLIO_NAME,
  insertPortfolio,
} from '../database/portfolios.js';
import {
  findUserByEmail,
  findUserById,
  insertUser,
  isUniqueViolation,
  type UserId,
  type UserRow,
} from '../database/users.js';

/**
 * Authentication business logic (IMPLEMENTATION_PLAN.md §4.4).
 *
 * Contains no Express types and no raw SQL: it takes a `Database` and calls
 * named query functions. That is what lets the whole class be tested against a
 * fake database with no server running (§8, Tier 2).
 */

/**
 * bcrypt work factor. 12 is the current sensible default -- roughly 250ms per
 * hash on modern hardware, which is slow enough to make offline cracking
 * expensive and fast enough not to be a denial-of-service vector on login.
 * It is a named constant because the dummy hash below MUST be generated at the
 * same cost; a mismatch reintroduces exactly the timing leak this design is
 * meant to close.
 */
const BCRYPT_COST = 12;

/**
 * Precomputed hash of a value no user can hold, generated once at module load
 * (ASSUMPTIONS.md #27).
 *
 * On a login for an unknown email, this is what `bcrypt.compare` runs against.
 * Without it, an unknown email returns in about a millisecond while a known
 * one takes the ~250ms of a real hash comparison -- a difference an attacker
 * can measure over a handful of requests to enumerate which addresses are
 * registered.
 *
 * Deliberately `hashSync` at module load rather than lazily on first use:
 * doing it lazily would make the *first* failed login for an unknown email
 * measurably slower than subsequent ones, which is the same leak in a subtler
 * form. Paying ~250ms once at startup is the correct trade.
 */
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(
  'this-value-is-never-a-real-password',
  BCRYPT_COST,
);

/** What the API is willing to say about a user. `password_hash` is absent by
 *  construction rather than deleted later, so it cannot be leaked by a caller
 *  that forgets to strip it. */
export interface PublicUser {
  id: UserId;
  email: string;
  name: string;
  createdAt: Date;
}

export interface AuthResult {
  user: PublicUser;
  token: string;
}

export interface RegisterInput {
  email: string;
  password: string;
  name: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export class AuthService {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Creates the user and their single portfolio (ASSUMPTIONS.md, known gaps)
   * in one transaction, so a user can never exist without the portfolio every
   * later write assumes and locks.
   */
  async register(input: RegisterInput): Promise<AuthResult> {
    const email = normalizeEmail(input.email);
    const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST);

    let user: UserRow;
    try {
      user = await this.#db.transaction(async (tx) => {
        const created = await insertUser(tx, {
          email,
          passwordHash,
          name: input.name.trim(),
        });

        await insertPortfolio(tx, {
          userId: created.id,
          name: DEFAULT_PORTFOLIO_NAME,
        });

        return created;
      });
    } catch (error) {
      // Translated from the constraint rather than from a pre-insert lookup:
      // see the note in database/users.ts on why the check-then-insert version
      // is racy. The narrow constraint name matters -- a different 23505 here
      // is a bug, and reporting it as "email taken" would hide it.
      if (isUniqueViolation(error, 'users_email_key')) {
        throw new AppError({
          status: 409,
          code: ErrorCodes.EMAIL_ALREADY_REGISTERED,
          message: 'An account with that email already exists',
        });
      }
      throw error;
    }

    return { user: toPublicUser(user), token: signAccessToken(user.id) };
  }

  async login(input: LoginInput): Promise<AuthResult> {
    const email = normalizeEmail(input.email);
    const user = await findUserByEmail(this.#db, email);

    // Both branches run exactly one bcrypt comparison at the same cost, so the
    // two paths take indistinguishable time. The comparison against the dummy
    // hash is not a formality -- its result is discarded, but removing the
    // call is what would leak.
    const passwordMatches = await bcrypt.compare(
      input.password,
      user?.password_hash ?? DUMMY_PASSWORD_HASH,
    );

    if (!user || !passwordMatches) {
      // One message for both causes. "No such user" versus "wrong password"
      // hands an attacker a membership oracle, and the timing defence above
      // would be pointless if the response body said it outright.
      throw new AppError({
        status: 401,
        code: ErrorCodes.INVALID_CREDENTIALS,
        message: 'Invalid email or password',
      });
    }

    return { user: toPublicUser(user), token: signAccessToken(user.id) };
  }

  /**
   * Resolves the user behind an authenticated request. Separate from token
   * verification on purpose: the `authenticate` middleware stays a pure token
   * check with no database round trip (§4.4), and only routes that actually
   * need user details pay for this lookup.
   */
  async getCurrentUser(userId: UserId): Promise<PublicUser> {
    const user = await findUserById(this.#db, userId);

    if (!user) {
      // A valid signature for a user who no longer exists -- a deleted account
      // whose 7-day token is still live. 401, not 404: the correct client
      // response is to discard the token and log in again, and there is no
      // revocation mechanism to have prevented this (ASSUMPTIONS.md #26).
      throw new AppError({
        status: 401,
        code: ErrorCodes.UNAUTHORIZED,
        message: 'Account no longer exists',
      });
    }

    return toPublicUser(user);
  }
}

/**
 * Lowercased and trimmed before it reaches the database, which independently
 * enforces lowercase via a CHECK constraint. The service normalizes so that
 * "Alice@Example.com" logs in successfully; the constraint exists so that a
 * path which forgot to normalize fails loudly instead of creating a second
 * account for the same person.
 */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toPublicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.created_at,
  };
}
