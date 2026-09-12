import { describe, expect, it } from 'vitest';

import { AuthService } from './AuthService.js';
import { AppError } from '../errors/AppError.js';
import type { Database, Queryable } from '../database/pool.js';
import type { UserRow } from '../database/users.js';
import type { PortfolioRow } from '../database/portfolios.js';

/**
 * Tier 2 (IMPLEMENTATION_PLAN.md §8): service logic against a fake database.
 *
 * The fake dispatches on the SQL it is actually handed, rather than being a
 * mock whose methods are asserted to have been called. That distinction is the
 * point of the tier: this exercises the real transaction path, the real
 * constraint-violation translation, and the real rollback behaviour, so a
 * change that breaks any of them fails here instead of in production.
 */

interface FakeOptions {
  /** Force a failure on the statement matching this fragment, to test rollback. */
  failOn?: string;
}

class FakeDatabase implements Database {
  users: UserRow[] = [];
  portfolios: PortfolioRow[] = [];
  readonly executed: string[] = [];

  #nextId = 1;
  readonly #options: FakeOptions;

  constructor(options: FakeOptions = {}) {
    this.#options = options;
  }

  // Typed loosely on purpose: this stands in for pg's generically-typed query
  // method, and reproducing that generic signature
  // faithfully here adds noise without adding safety to the assertions below.
  async query(sql: string, params: readonly unknown[] = []): Promise<any> {
    this.executed.push(sql);

    if (this.#options.failOn !== undefined && sql.includes(this.#options.failOn)) {
      throw new Error(`forced failure on: ${this.#options.failOn}`);
    }

    if (sql.includes('INSERT INTO users')) {
      const [email, passwordHash, name] = params as [string, string, string];

      if (this.users.some((u) => u.email === email)) {
        // Shaped like the driver's real error, because that shape is exactly
        // what the service is expected to recognise.
        throw Object.assign(new Error('duplicate key value'), {
          code: '23505',
          constraint: 'users_email_key',
        });
      }

      const row: UserRow = {
        id: String(this.#nextId++),
        email,
        password_hash: passwordHash,
        name,
        created_at: new Date('2026-01-01T00:00:00Z'),
      };
      this.users.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.includes('INSERT INTO portfolios')) {
      const [userId, name] = params as [string, string];
      const row: PortfolioRow = {
        id: String(this.#nextId++),
        user_id: userId,
        name,
        created_at: new Date('2026-01-01T00:00:00Z'),
      };
      this.portfolios.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (sql.includes('FROM users') && sql.includes('WHERE email')) {
      const [email] = params as [string];
      const row = this.users.find((u) => u.email === email);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (sql.includes('FROM users') && sql.includes('WHERE id')) {
      const [id] = params as [string];
      const row = this.users.find((u) => u.id === id);
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    throw new Error(`FakeDatabase received unexpected SQL: ${sql}`);
  }

  /** Snapshot/restore gives the fake real rollback semantics, so a test can
   *  prove the service does not leave a half-registered user behind. */
  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const usersBefore = [...this.users];
    const portfoliosBefore = [...this.portfolios];

    try {
      return await fn(this);
    } catch (error) {
      this.users = usersBefore;
      this.portfolios = portfoliosBefore;
      throw error;
    }
  }
}

/**
 * Asserts that a call rejects with an `AppError` and hands it back narrowed.
 *
 * Beyond typing: a bare `.catch(e => e)` silently passes if the call
 * *succeeds*, since the assertions then run against the resolved value. This
 * fails loudly in that case, which matters for tests whose whole point is that
 * a credential check rejected.
 */
async function expectAppError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the call to reject, but it resolved');
}

const validRegistration = {
  email: 'Alice@Example.com',
  password: 'correct-horse-battery-staple',
  name: '  Alice  ',
};

describe('AuthService.register', () => {
  it('creates the user and their portfolio together', async () => {
    const db = new FakeDatabase();
    const result = await new AuthService(db).register(validRegistration);

    expect(db.users).toHaveLength(1);
    expect(db.portfolios).toHaveLength(1);
    expect(db.portfolios[0]?.user_id).toBe(db.users[0]?.id);
    expect(result.token).toBeTypeOf('string');
  });

  it('normalizes the email and trims the name', async () => {
    const db = new FakeDatabase();
    const result = await new AuthService(db).register(validRegistration);

    expect(result.user.email).toBe('alice@example.com');
    expect(result.user.name).toBe('Alice');
  });

  it('never returns the password hash', async () => {
    const db = new FakeDatabase();
    const result = await new AuthService(db).register(validRegistration);

    expect(JSON.stringify(result)).not.toContain(db.users[0]!.password_hash);
    expect(result.user).not.toHaveProperty('password_hash');
  });

  it('stores a hash, never the plaintext password', async () => {
    const db = new FakeDatabase();
    await new AuthService(db).register(validRegistration);

    const stored = db.users[0]!.password_hash;
    expect(stored).not.toBe(validRegistration.password);
    expect(stored.startsWith('$2b$12$')).toBe(true);
  });

  it('rolls back the user when portfolio creation fails', async () => {
    // The invariant: a user must never exist without the portfolio that every
    // later write locks. Without the transaction this leaves an orphan.
    const db = new FakeDatabase({ failOn: 'INSERT INTO portfolios' });

    await expect(
      new AuthService(db).register(validRegistration),
    ).rejects.toThrow(/forced failure/);

    expect(db.users).toHaveLength(0);
    expect(db.portfolios).toHaveLength(0);
  });

  it('translates the unique-violation into a 409, not a 500', async () => {
    const db = new FakeDatabase();
    const service = new AuthService(db);
    await service.register(validRegistration);

    // Different case, same address -- must still collide.
    const error = await service
      .register({ ...validRegistration, email: 'ALICE@example.com' })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).status).toBe(409);
    expect((error as AppError).code).toBe('EMAIL_ALREADY_REGISTERED');
  });
});

describe('AuthService.login', () => {
  const seeded = async (): Promise<{ db: FakeDatabase; service: AuthService }> => {
    const db = new FakeDatabase();
    const service = new AuthService(db);
    await service.register(validRegistration);
    return { db, service };
  };

  it('accepts the correct password regardless of email case', async () => {
    const { service } = await seeded();
    const result = await service.login({
      email: 'ALICE@EXAMPLE.COM',
      password: validRegistration.password,
    });

    expect(result.user.email).toBe('alice@example.com');
    expect(result.token).toBeTypeOf('string');
  });

  it('rejects a wrong password', async () => {
    const { service } = await seeded();
    const error = await service
      .login({ email: validRegistration.email, password: 'wrong' })
      .catch((e: unknown) => e);

    expect((error as AppError).status).toBe(401);
    expect((error as AppError).code).toBe('INVALID_CREDENTIALS');
  });

  it('reports an unknown email identically to a wrong password', async () => {
    // A different code or message here is a membership oracle: it tells an
    // attacker which addresses are registered, which is the exact thing the
    // timing defence below also exists to prevent.
    const { service } = await seeded();

    const unknownEmail = await expectAppError(
      service.login({ email: 'nobody@example.com', password: 'whatever' }),
    );
    const wrongPassword = await expectAppError(
      service.login({ email: validRegistration.email, password: 'wrong' }),
    );

    expect(unknownEmail.status).toBe(wrongPassword.status);
    expect(unknownEmail.code).toBe(wrongPassword.code);
    expect(unknownEmail.message).toBe(wrongPassword.message);
  });

  it('spends comparable time on an unknown email as on a real one', async () => {
    // Guards ASSUMPTIONS.md #27 specifically. Deleting the dummy-hash
    // comparison is an easy "simplification" that leaves every other test
    // green -- the unknown-email path would return in about a millisecond
    // instead of the ~250ms a real bcrypt comparison costs.
    //
    // Asserted as a generous lower bound rather than a ratio, so the test is
    // not flaky on a loaded machine but still fails outright if the comparison
    // is skipped.
    const { service } = await seeded();

    const started = Date.now();
    await service
      .login({ email: 'nobody@example.com', password: 'whatever' })
      .catch(() => undefined);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThan(50);
  });
});

describe('AuthService.getCurrentUser', () => {
  it('returns the public projection of a known user', async () => {
    const db = new FakeDatabase();
    const service = new AuthService(db);
    const { user } = await service.register(validRegistration);

    expect(await service.getCurrentUser(user.id)).toEqual(user);
  });

  it('rejects a valid token for a user that no longer exists', async () => {
    const db = new FakeDatabase();
    const error = await expectAppError(new AuthService(db).getCurrentUser('999'));

    // 401 rather than 404: the client should discard the token and log in
    // again, which is not what a 404 communicates.
    expect(error.status).toBe(401);
    expect(error.code).toBe('UNAUTHORIZED');
  });
});
