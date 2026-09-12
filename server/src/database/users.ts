import type { Queryable } from './pool.js';

/**
 * All SQL touching `users` and `portfolios` at registration time
 * (IMPLEMENTATION_PLAN.md §4).
 *
 * Kept out of the service layer so that services read as business logic and
 * every query against these tables is visible in one file. Every statement
 * here is parameterized -- there is no string interpolation of user input
 * anywhere in this repo.
 */

export interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  name: string;
  created_at: Date;
}

/** `id` is `BIGINT`, which pg returns as a string rather than a number --
 *  deliberately, since a 64-bit integer does not fit in a JS number. It stays
 *  a string throughout the application; nothing does arithmetic on it. */
export type UserId = string;

export async function findUserByEmail(
  db: Queryable,
  email: string,
): Promise<UserRow | null> {
  const result = await db.query<UserRow>(
    `SELECT id, email, password_hash, name, created_at
     FROM users
     WHERE email = $1`,
    [email],
  );

  return result.rows[0] ?? null;
}

export async function findUserById(
  db: Queryable,
  id: UserId,
): Promise<UserRow | null> {
  const result = await db.query<UserRow>(
    `SELECT id, email, password_hash, name, created_at
     FROM users
     WHERE id = $1`,
    [id],
  );

  return result.rows[0] ?? null;
}

/**
 * Inserts a user. Throws the driver's unique-violation error (23505) when the
 * email is taken -- the caller translates it.
 *
 * There is deliberately no "does this email exist?" check before the insert.
 * Any such check is a race: two concurrent registrations both see the email
 * free, both proceed, and one fails at the constraint anyway. Relying on the
 * constraint as the single source of truth means the success path is one
 * round trip and the failure path is correct under concurrency, rather than
 * merely usually correct.
 */
export async function insertUser(
  db: Queryable,
  user: { email: string; passwordHash: string; name: string },
): Promise<UserRow> {
  const result = await db.query<UserRow>(
    `INSERT INTO users (email, password_hash, name)
     VALUES ($1, $2, $3)
     RETURNING id, email, password_hash, name, created_at`,
    [user.email, user.passwordHash, user.name],
  );

  const row = result.rows[0];
  if (!row) {
    // RETURNING on a successful INSERT always yields a row; reaching here
    // means the driver or a fake broke its contract, which is a bug rather
    // than a user-facing condition.
    throw new Error('insertUser: INSERT ... RETURNING produced no row');
  }

  return row;
}

/** Postgres unique-violation. Checked by code rather than by matching the
 *  message text, which is localized and version-dependent. */
export const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const candidate = error as { code?: unknown; constraint?: unknown };
  if (candidate.code !== UNIQUE_VIOLATION) {
    return false;
  }

  // Narrowing by constraint name matters once a table has more than one unique
  // constraint: treating any 23505 as "email taken" would report the wrong
  // cause the moment a second one is added.
  return constraint === undefined || candidate.constraint === constraint;
}
