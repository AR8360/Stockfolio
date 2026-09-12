import { createHash } from 'node:crypto';

import { AppError, ErrorCodes, notFound } from '../errors/AppError.js';
import { assertChronologicalSell } from '../domain/chronological.js';
import { calculateFifoPosition, type FifoTrade } from '../domain/fifo.js';
import { Decimal } from '../domain/money.js';
import type { Database, Queryable } from '../database/pool.js';
import { lockPortfolioForUser } from '../database/portfolios.js';
import {
  claimIdempotencyKey,
  deleteTransactionById,
  findIdempotencyKey,
  findTransactionInPortfolio,
  insertTransaction,
  listHoldingLedger,
  lockIdempotencyKey,
  saveIdempotentResponse,
  updateTransactionFields,
  upsertInstrument,
  type TransactionRow,
} from '../database/transactions.js';
import type { MarketDataService } from '../providers/types.js';

/**
 * The write path (IMPLEMENTATION_PLAN.md §4.3).
 *
 * Every mutation runs inside one transaction that begins by locking the user's
 * portfolio row, so all writes to one ledger are serialized and the
 * chronological-sell check always sees a consistent view (ASSUMPTIONS.md #23).
 */

export interface AddTransactionInput {
  symbol: string;
  exchange: string;
  type: 'BUY' | 'SELL';
  quantity: string;
  price: string;
  fees: string;
  txnDate: string;
}

export interface UpdateTransactionInput {
  type: 'BUY' | 'SELL';
  quantity: string;
  price: string;
  fees: string;
  txnDate: string;
}

export interface TransactionDto {
  id: string;
  symbol: string;
  exchange: string;
  type: 'BUY' | 'SELL';
  quantity: string;
  price: string;
  fees: string;
  currency: string;
  txnDate: string;
  createdAt: string;
}

export class TransactionService {
  readonly #db: Database;
  readonly #marketData: MarketDataService;

  constructor(db: Database, marketData: MarketDataService) {
    this.#db = db;
    this.#marketData = marketData;
  }

  async addTransaction(
    userId: string,
    input: AddTransactionInput,
    idempotencyKey: string,
  ): Promise<TransactionDto> {
    const requestHash = hashRequest(input);

    // Step 2 of §4.3: the cheap check, deliberately outside any transaction.
    // A genuine retry — the common case — is answered here without opening a
    // transaction or taking the portfolio lock at all.
    const existing = await findIdempotencyKey(this.#db, userId, idempotencyKey);
    if (existing) {
      return replayOrConflict(existing.request_hash, requestHash, existing.response_body);
    }

    // Ticker validation (ASSUMPTIONS.md #9) happens BEFORE the transaction
    // opens. It is a network call to an unofficial third-party API with an 8s
    // timeout; making it inside the transaction would hold the portfolio lock —
    // and block every other write by this user — for the duration of someone
    // else's outage.
    const quote = await this.#marketData.getQuote({
      symbol: input.symbol,
      exchange: input.exchange,
    });

    const dto = await this.#db.transaction(async (tx) => {
      const portfolio = await lockPortfolioForUser(tx, userId);
      if (!portfolio) throw notFound('Portfolio not found');

      // Re-checked under the lock (§4.3 step 4). The pre-check above is not
      // authoritative: two requests carrying the same key can both pass it,
      // and only one of them can be holding the portfolio lock here.
      const locked = await lockIdempotencyKey(tx, userId, idempotencyKey);
      if (locked) {
        return replayOrConflict(locked.request_hash, requestHash, locked.response_body);
      }

      // Claim the key before doing the work, so a concurrent request with the
      // same key has a row to block on rather than racing to insert one.
      await claimIdempotencyKey(tx, userId, idempotencyKey, requestHash);

      const instrument = await upsertInstrument(tx, {
        symbol: input.symbol,
        exchange: input.exchange,
        name: quote.name,
      });

      const ledger = await listHoldingLedger(tx, portfolio.id, instrument.id);

      if (input.type === 'SELL') {
        // The forward-looking check: a sell can be valid on its own date and
        // still make a later date negative, because trades are not entered in
        // date order. Run before the insert so the error names the conflicting
        // date rather than surfacing as a generic replay failure.
        assertChronologicalSell(ledger.map(toLedgerEntry), {
          quantity: new Decimal(input.quantity),
          date: parseDate(input.txnDate),
        });
      }

      const inserted = await insertTransaction(tx, {
        portfolioId: portfolio.id,
        instrumentId: instrument.id,
        exchange: input.exchange,
        type: input.type,
        quantity: input.quantity,
        price: input.price,
        fees: input.fees,
        currency: quote.currency,
        txnDate: input.txnDate,
        clientRequestId: idempotencyKey,
        requestHash,
      });

      // Authoritative full-ledger replay. `assertChronologicalSell` gives the
      // better error message; this is what actually guarantees the stored
      // ledger is consistent, using the same function the read path uses — so
      // the two can never disagree about what is valid.
      assertLedgerReplays([...ledger, inserted]);

      const result = toDto(inserted, input.symbol, quote.name);
      await saveIdempotentResponse(tx, userId, idempotencyKey, result);
      return result;
    });

    return dto;
  }

  /**
   * Edits are not idempotency-protected: they are not the double-submission
   * risk a create is (§5 scopes the key to POST), and they are naturally
   * idempotent anyway — applying the same patch twice yields the same row.
   * They still take the portfolio lock and still re-validate the whole ledger.
   */
  async updateTransaction(
    userId: string,
    transactionId: string,
    patch: UpdateTransactionInput,
  ): Promise<TransactionDto> {
    return this.#db.transaction(async (tx) => {
      const portfolio = await lockPortfolioForUser(tx, userId);
      if (!portfolio) throw notFound('Portfolio not found');

      const before = await findTransactionInPortfolio(tx, portfolio.id, transactionId);
      if (!before) throw notFound('Transaction not found');

      // Whole-share rule, checked here rather than in the Zod schema.
      //
      // The route schema cannot do it: the exchange is not editable, so a
      // PATCH body does not carry one, and the rule is exchange-specific
      // (ASSUMPTIONS.md #7). Without this the value reaches the database, trips
      // the CHECK constraint, and surfaces as a 500 for what is a user typo —
      // while the identical value on POST returns a clean 400.
      assertWholeShares(before.exchange, patch.quantity);

      const updated = await updateTransactionFields(tx, portfolio.id, transactionId, patch);

      // Re-read and replay the whole holding. An edit can invalidate trades it
      // does not touch — reducing an early BUY can leave a later SELL
      // overselling — so validating the edited row alone is not enough. A throw
      // here rolls the edit back.
      const ledger = await listHoldingLedger(tx, portfolio.id, updated.instrument_id);
      assertLedgerReplays(ledger);

      return toDto(updated, ...(await this.#instrumentNames(tx, updated.instrument_id)));
    });
  }

  async deleteTransaction(userId: string, transactionId: string): Promise<void> {
    await this.#db.transaction(async (tx) => {
      const portfolio = await lockPortfolioForUser(tx, userId);
      if (!portfolio) throw notFound('Portfolio not found');

      const existing = await findTransactionInPortfolio(tx, portfolio.id, transactionId);
      if (!existing) throw notFound('Transaction not found');

      const removed = await deleteTransactionById(tx, portfolio.id, transactionId);
      if (removed === 0) throw notFound('Transaction not found');

      // Deleting a BUY can leave later SELLs unsupported. Same replay, same
      // rollback-on-throw.
      const ledger = await listHoldingLedger(tx, portfolio.id, existing.instrument_id);
      assertLedgerReplays(ledger);
    });
  }

  async #instrumentNames(tx: Queryable, instrumentId: string): Promise<[string, string]> {
    const result = await tx.query<{ symbol: string; name: string }>(
      `SELECT symbol, name FROM instruments WHERE id = $1`,
      [instrumentId],
    );
    const row = result.rows[0];
    return [row?.symbol ?? '', row?.name ?? ''];
  }
}

/**
 * Canonical SHA-256 of the request body (§4.3).
 *
 * Keys are sorted so that two JSON bodies differing only in property order
 * hash the same — otherwise a client that serializes fields in a different
 * order on retry would be told its key was reused with a different body.
 */
export function hashRequest(input: object): string {
  const entries = Object.entries(input).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonical = JSON.stringify(entries);
  return createHash('sha256').update(canonical).digest('hex');
}

function replayOrConflict(
  storedHash: string,
  requestHash: string,
  storedBody: unknown,
): TransactionDto {
  if (storedHash !== requestHash) {
    // Same key, different body: a client bug, not a retry. Replaying the old
    // response would silently discard the new trade the user thinks they made.
    throw new AppError({
      status: 409,
      code: ErrorCodes.IDEMPOTENCY_KEY_REUSED,
      message: 'This idempotency key was already used with a different request body',
    });
  }

  if (storedBody === null || storedBody === undefined) {
    // The key is claimed but the original request has not finished. Retrying
    // is the right client action, so this is a 409 rather than a replay of
    // nothing.
    throw new AppError({
      status: 409,
      code: ErrorCodes.IDEMPOTENCY_KEY_REUSED,
      message: 'A request with this idempotency key is still in progress',
    });
  }

  return storedBody as TransactionDto;
}

/** Mirrors `transactions_whole_shares_on_indian_exchanges` and the create-path
 *  Zod refinement, so all three enforce one rule rather than three subtly
 *  different ones. */
const WHOLE_SHARE_EXCHANGES = new Set(['NSE', 'BSE']);

function assertWholeShares(exchange: string, quantity: string): void {
  if (!WHOLE_SHARE_EXCHANGES.has(exchange)) return;
  if (new Decimal(quantity).isInteger()) return;

  throw new AppError({
    status: 400,
    code: ErrorCodes.VALIDATION_FAILED,
    message: `${exchange} trades whole shares only`,
    details: { quantity: [`${exchange} trades whole shares only`] },
  });
}

function assertLedgerReplays(rows: readonly TransactionRow[]): void {
  // Throws INSUFFICIENT_HOLDINGS if any sell in the ledger oversells at its
  // point in the replay. Called for its throw, not its return value.
  calculateFifoPosition(rows.map(toFifoTrade));
}

export function toFifoTrade(row: TransactionRow): FifoTrade {
  return {
    id: row.id,
    type: row.type,
    quantity: new Decimal(row.quantity),
    price: new Decimal(row.price),
    fees: new Decimal(row.fees),
    date: parseDate(row.txn_date),
    createdAt: row.created_at,
  };
}

function toLedgerEntry(row: TransactionRow) {
  return { type: row.type, quantity: new Decimal(row.quantity), date: parseDate(row.txn_date) };
}

/** `YYYY-MM-DD` at UTC midnight. Explicit `T00:00:00Z` rather than
 *  `new Date('2026-01-05')` semantics changing under us, and never local
 *  midnight — see the DATE parser note in database/pool.ts. */
export function parseDate(value: string): Date {
  return new Date(`${value.slice(0, 10)}T00:00:00Z`);
}

function toDto(row: TransactionRow, symbol: string, _name: string): TransactionDto {
  return {
    id: row.id,
    symbol,
    exchange: row.exchange,
    type: row.type,
    quantity: row.quantity,
    price: row.price,
    fees: row.fees,
    currency: row.currency,
    txnDate: row.txn_date.slice(0, 10),
    createdAt: row.created_at.toISOString(),
  };
}
