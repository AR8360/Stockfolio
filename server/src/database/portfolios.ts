import type { Queryable } from './pool.js';
import type { UserId } from './users.js';

export interface PortfolioRow {
  id: string;
  user_id: string;
  name: string;
  created_at: Date;
}

export const DEFAULT_PORTFOLIO_NAME = 'My Portfolio';

export async function insertPortfolio(
  db: Queryable,
  portfolio: { userId: UserId; name: string },
): Promise<PortfolioRow> {
  const result = await db.query<PortfolioRow>(
    `INSERT INTO portfolios (user_id, name)
     VALUES ($1, $2)
     RETURNING id, user_id, name, created_at`,
    [portfolio.userId, portfolio.name],
  );

  const row = result.rows[0];
  if (!row) {
    throw new Error('insertPortfolio: INSERT ... RETURNING produced no row');
  }

  return row;
}

/**
 * Takes the write lock on a user's portfolio (IMPLEMENTATION_PLAN.md §4.3,
 * ASSUMPTIONS.md #23). Must be called inside a transaction -- the lock is
 * released at commit or rollback, and on a transaction-pooling connection
 * (Neon's pooled endpoint) a statement issued outside one may not even reach
 * the same backend.
 *
 * Defined here rather than in the transactions module because it locks the
 * *portfolio* row: it serializes every write to one user's ledger, whatever
 * instrument that write touches, which is what makes the chronological-sell
 * check see a consistent view.
 *
 * Not used by auth; placed here now because registration creates the row this
 * lock will target, and the two belong together.
 */
export async function lockPortfolioForUser(
  db: Queryable,
  userId: UserId,
): Promise<PortfolioRow | null> {
  const result = await db.query<PortfolioRow>(
    `SELECT id, user_id, name, created_at
     FROM portfolios
     WHERE user_id = $1
     FOR UPDATE`,
    [userId],
  );

  return result.rows[0] ?? null;
}
