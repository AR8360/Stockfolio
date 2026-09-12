import type { Queryable } from './pool.js';

/** All SQL touching `transactions`, `instruments` and `idempotency_keys`.
 *  Every statement parameterized; no interpolation of user input. */

export interface TransactionRow {
  id: string;
  portfolio_id: string;
  instrument_id: string;
  exchange: string;
  type: 'BUY' | 'SELL';
  /** pg returns NUMERIC as a string to avoid float truncation — it stays a
   *  string until the domain layer turns it into a Decimal. */
  quantity: string;
  price: string;
  fees: string;
  currency: string;
  /** `YYYY-MM-DD`: the DATE type parser in pool.ts keeps the wire format. */
  txn_date: string;
  client_request_id: string | null;
  created_at: Date;
}

export interface TransactionWithInstrument extends TransactionRow {
  symbol: string;
  instrument_name: string;
}

export async function upsertInstrument(
  db: Queryable,
  input: { symbol: string; exchange: string; name: string },
): Promise<{ id: string }> {
  // ON CONFLICT rather than select-then-insert: two concurrent first-trades on
  // the same symbol would both find it missing and one would fail the unique
  // constraint. The DO UPDATE refreshes the cached name and is also what makes
  // RETURNING yield a row on the conflict path (DO NOTHING returns none).
  const result = await db.query<{ id: string }>(
    `INSERT INTO instruments (symbol, exchange, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (symbol, exchange)
     DO UPDATE SET name = EXCLUDED.name, updated_at = now()
     RETURNING id`,
    [input.symbol, input.exchange, input.name],
  );

  const row = result.rows[0];
  if (!row) throw new Error('upsertInstrument returned no row');
  return row;
}

/** The ledger for one holding, in the exact order FIFO replay needs — served
 *  straight from `transactions_fifo_replay_idx` with no sort step. */
export async function listHoldingLedger(
  db: Queryable,
  portfolioId: string,
  instrumentId: string,
): Promise<TransactionRow[]> {
  const result = await db.query<TransactionRow>(
    `SELECT id, portfolio_id, instrument_id, exchange, type, quantity, price,
            fees, currency, txn_date, client_request_id, created_at
     FROM transactions
     WHERE portfolio_id = $1 AND instrument_id = $2
     ORDER BY txn_date, created_at, id`,
    [portfolioId, instrumentId],
  );
  return result.rows;
}

/** Every trade in a portfolio, joined to instrument metadata, ordered so the
 *  caller can group by instrument and replay each group directly. */
export async function listPortfolioLedger(
  db: Queryable,
  portfolioId: string,
): Promise<TransactionWithInstrument[]> {
  const result = await db.query<TransactionWithInstrument>(
    `SELECT t.id, t.portfolio_id, t.instrument_id, t.exchange, t.type,
            t.quantity, t.price, t.fees, t.currency, t.txn_date,
            t.client_request_id, t.created_at,
            i.symbol, i.name AS instrument_name
     FROM transactions t
     JOIN instruments i ON i.id = t.instrument_id
     WHERE t.portfolio_id = $1
     ORDER BY t.instrument_id, t.txn_date, t.created_at, t.id`,
    [portfolioId],
  );
  return result.rows;
}

export async function insertTransaction(
  db: Queryable,
  input: {
    portfolioId: string;
    instrumentId: string;
    exchange: string;
    type: 'BUY' | 'SELL';
    quantity: string;
    price: string;
    fees: string;
    currency: string;
    txnDate: string;
    clientRequestId: string | null;
    requestHash: string | null;
  },
): Promise<TransactionRow> {
  const result = await db.query<TransactionRow>(
    `INSERT INTO transactions
       (portfolio_id, instrument_id, exchange, type, quantity, price, fees,
        currency, txn_date, client_request_id, request_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id, portfolio_id, instrument_id, exchange, type, quantity,
               price, fees, currency, txn_date, client_request_id, created_at`,
    [
      input.portfolioId, input.instrumentId, input.exchange, input.type,
      input.quantity, input.price, input.fees, input.currency, input.txnDate,
      input.clientRequestId, input.requestHash,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('insertTransaction returned no row');
  return row;
}

/** Scoped by portfolio as well as id, so one user cannot address another
 *  user's transaction by guessing an id — authorization enforced in the WHERE
 *  clause rather than by a separate check that could be forgotten. */
export async function findTransactionInPortfolio(
  db: Queryable,
  portfolioId: string,
  id: string,
): Promise<TransactionRow | null> {
  const result = await db.query<TransactionRow>(
    `SELECT id, portfolio_id, instrument_id, exchange, type, quantity, price,
            fees, currency, txn_date, client_request_id, created_at
     FROM transactions
     WHERE portfolio_id = $1 AND id = $2`,
    [portfolioId, id],
  );
  return result.rows[0] ?? null;
}

export async function updateTransactionFields(
  db: Queryable,
  portfolioId: string,
  id: string,
  fields: { type: 'BUY' | 'SELL'; quantity: string; price: string; fees: string; txnDate: string },
): Promise<TransactionRow> {
  const result = await db.query<TransactionRow>(
    `UPDATE transactions
     SET type = $3, quantity = $4, price = $5, fees = $6, txn_date = $7
     WHERE portfolio_id = $1 AND id = $2
     RETURNING id, portfolio_id, instrument_id, exchange, type, quantity,
               price, fees, currency, txn_date, client_request_id, created_at`,
    [portfolioId, id, fields.type, fields.quantity, fields.price, fields.fees, fields.txnDate],
  );
  const row = result.rows[0];
  if (!row) throw new Error('updateTransactionFields matched no row');
  return row;
}

export async function deleteTransactionById(
  db: Queryable,
  portfolioId: string,
  id: string,
): Promise<number> {
  const result = await db.query(
    `DELETE FROM transactions WHERE portfolio_id = $1 AND id = $2`,
    [portfolioId, id],
  );
  return result.rowCount ?? 0;
}

/* ----------------------------- idempotency ----------------------------- */

export interface IdempotencyRow {
  user_id: string;
  key: string;
  request_hash: string;
  response_body: unknown;
}

/** Cheap pre-check, outside any transaction (§4.3 step 2). Most retries are
 *  resolved here without opening a transaction or taking a lock at all. */
export async function findIdempotencyKey(
  db: Queryable,
  userId: string,
  key: string,
): Promise<IdempotencyRow | null> {
  const result = await db.query<IdempotencyRow>(
    `SELECT user_id, key, request_hash, response_body
     FROM idempotency_keys WHERE user_id = $1 AND key = $2`,
    [userId, key],
  );
  return result.rows[0] ?? null;
}

/** The same lookup with the row locked (§4.3 step 4). Only meaningful inside a
 *  transaction, and only locks a row that already exists — the first use of a
 *  new key has nothing to lock, which is why the portfolio lock is taken first
 *  and the primary key is the final backstop. */
export async function lockIdempotencyKey(
  db: Queryable,
  userId: string,
  key: string,
): Promise<IdempotencyRow | null> {
  const result = await db.query<IdempotencyRow>(
    `SELECT user_id, key, request_hash, response_body
     FROM idempotency_keys WHERE user_id = $1 AND key = $2
     FOR UPDATE`,
    [userId, key],
  );
  return result.rows[0] ?? null;
}

export async function claimIdempotencyKey(
  db: Queryable,
  userId: string,
  key: string,
  requestHash: string,
): Promise<void> {
  await db.query(
    `INSERT INTO idempotency_keys (user_id, key, request_hash) VALUES ($1,$2,$3)`,
    [userId, key, requestHash],
  );
}

export async function saveIdempotentResponse(
  db: Queryable,
  userId: string,
  key: string,
  body: unknown,
): Promise<void> {
  await db.query(
    `UPDATE idempotency_keys SET response_body = $3 WHERE user_id = $1 AND key = $2`,
    [userId, key, JSON.stringify(body)],
  );
}
