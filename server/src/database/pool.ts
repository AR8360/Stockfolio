import pg from 'pg';

import { env } from '../config/env.js';

/**
 * Return `DATE` columns as plain `YYYY-MM-DD` strings rather than JS `Date`s.
 *
 * By default the driver turns a DATE into a `Date` at *local* midnight. A
 * DATE column carries no timezone, so that invents one — and on a host west of
 * UTC, reading `txn_date` back and formatting it in UTC yields the previous
 * day. For this application that is not a cosmetic bug: `txn_date` is the
 * primary FIFO sort key, so a silent one-day shift reorders the ledger and
 * changes which lot a sale consumes, producing a wrong realized gain with no
 * error anywhere.
 *
 * Keeping the wire format means the value crosses into the domain layer
 * exactly as stored, and the caller converts explicitly and unambiguously
 * (`new Date(value + 'T00:00:00Z')`).
 *
 * 1082 is the OID for DATE. Set once, at module load, before any pool exists.
 */
const PG_DATE_OID = 1082;
pg.types.setTypeParser(PG_DATE_OID, (value: string) => value);

/**
 * Database access seam (IMPLEMENTATION_PLAN.md §4).
 *
 * Services depend on the `Database` interface below, never on `pg.Pool`
 * directly. That is what makes the Tier 2 tests in §8 possible: a fake that
 * responds based on the SQL it is handed exercises the real transaction and
 * locking code paths, rather than asserting that a mocked method was called.
 */

/** The subset of pg's client surface this application actually uses. Narrow on
 *  purpose -- a fake has to implement only this, and widening it is a
 *  deliberate act rather than something that happens by accident. */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<pg.QueryResult<R>>;
}

export interface Database extends Queryable {
  /**
   * Runs `fn` inside a single transaction, committing on return and rolling
   * back on throw.
   *
   * Callers get a `Queryable` bound to one connection, which is the part that
   * matters: `FOR UPDATE` only holds for the transaction that took it, and the
   * deployment target is a PgBouncer pooler in transaction-pooling mode, where
   * a server connection is pinned only for the duration of one transaction.
   * Issuing BEGIN and the locked SELECT through the pool separately could send
   * them to different backends and silently lose the lock.
   */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

export function createDatabase(pool: pg.Pool): Database {
  return {
    query: (sql, params) => pool.query(sql, params as unknown[]),

    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        // Rollback is itself allowed to fail -- if the connection died, the
        // transaction is already gone and the original error is the one worth
        // propagating. Swallowing a rollback failure here keeps the real cause
        // from being masked by a secondary one.
        try {
          await client.query('ROLLBACK');
        } catch {
          /* connection is unusable; release() below discards it */
        }
        throw error;
      } finally {
        // Must run on every path. A leaked client is invisible until the pool
        // is exhausted, at which point every request hangs rather than errors.
        client.release();
      }
    },
  };
}

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  // Modest ceiling: the free Postgres tier caps connections, and a single Node
  // process serving a demo does not need more. Exceeding the provider's limit
  // fails as a connection error under load, which looks like an application
  // bug and is not one.
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

export const db: Database = createDatabase(pool);

/** Used by `GET /health` (§5, ASSUMPTIONS.md #30) -- a real round trip, so the
 *  check fails while the pool is still connecting or the database is
 *  unreachable, rather than reporting healthy because the process is alive. */
export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await db.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
