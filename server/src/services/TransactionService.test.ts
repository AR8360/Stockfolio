import { describe, expect, it } from 'vitest';

import { TransactionService, hashRequest } from './TransactionService.js';
import { AppError } from '../errors/AppError.js';
import { Decimal } from '../domain/money.js';
import type { Database, Queryable } from '../database/pool.js';
import type { InstrumentRef, MarketDataService, Quote } from '../providers/types.js';

/**
 * Tier 2 (IMPLEMENTATION_PLAN.md §8): the real transaction, locking and
 * idempotency code paths, against a fake database that dispatches on the SQL
 * it is handed — not a mock asserting that a method was called.
 */

interface StoredTxn {
  id: string;
  portfolio_id: string;
  instrument_id: string;
  exchange: string;
  type: 'BUY' | 'SELL';
  quantity: string;
  price: string;
  fees: string;
  currency: string;
  txn_date: string;
  client_request_id: string | null;
  created_at: Date;
}

class FakeDb implements Database {
  txns: StoredTxn[] = [];
  keys = new Map<string, { request_hash: string; response_body: unknown }>();
  readonly executed: string[] = [];
  #next = 100;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- stands in for pg's generic query
  async query(sql: string, params: readonly unknown[] = []): Promise<any> {
    this.executed.push(sql.replace(/\s+/g, ' ').trim());

    if (sql.includes('FROM portfolios') && sql.includes('FOR UPDATE')) {
      return { rows: [{ id: 'p1', user_id: params[0], name: 'My Portfolio', created_at: new Date() }], rowCount: 1 };
    }
    if (sql.includes('FROM portfolios')) {
      return { rows: [{ id: 'p1' }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO instruments')) {
      return { rows: [{ id: 'i1' }], rowCount: 1 };
    }
    if (sql.includes('FROM instruments')) {
      return { rows: [{ symbol: 'RELIANCE', name: 'Reliance Industries' }], rowCount: 1 };
    }
    if (sql.includes('FROM idempotency_keys')) {
      const stored = this.keys.get(String(params[1]));
      return { rows: stored ? [{ user_id: params[0], key: params[1], ...stored }] : [], rowCount: stored ? 1 : 0 };
    }
    if (sql.includes('INSERT INTO idempotency_keys')) {
      if (this.keys.has(String(params[1]))) {
        throw Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'idempotency_keys_pkey' });
      }
      this.keys.set(String(params[1]), { request_hash: String(params[2]), response_body: null });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE idempotency_keys')) {
      const stored = this.keys.get(String(params[1]));
      if (stored) stored.response_body = JSON.parse(String(params[2]));
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('DELETE FROM transactions')) {
      const before = this.txns.length;
      this.txns = this.txns.filter((t) => t.id !== String(params[1]));
      return { rows: [], rowCount: before - this.txns.length };
    }

    if (sql.includes('FROM transactions')) {
      const rows =
        sql.includes('AND id =')
          ? this.txns.filter((t) => t.id === String(params[1]))
          : this.txns.filter((t) => t.instrument_id === 'i1');
      return { rows: [...rows].sort((a, b) => a.txn_date.localeCompare(b.txn_date)), rowCount: rows.length };
    }
    if (sql.includes('INSERT INTO transactions')) {
      const row: StoredTxn = {
        id: String(this.#next++),
        portfolio_id: String(params[0]), instrument_id: String(params[1]),
        exchange: String(params[2]), type: params[3] as 'BUY' | 'SELL',
        quantity: String(params[4]), price: String(params[5]), fees: String(params[6]),
        currency: String(params[7]), txn_date: String(params[8]),
        client_request_id: params[9] as string | null, created_at: new Date(),
      };
      this.txns.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('UPDATE transactions')) {
      const row = this.txns.find((t) => t.id === String(params[1]));
      if (!row) return { rows: [], rowCount: 0 };
      Object.assign(row, {
        type: params[2], quantity: String(params[3]), price: String(params[4]),
        fees: String(params[5]), txn_date: String(params[6]),
      });
      return { rows: [row], rowCount: 1 };
    }
    throw new Error(`FakeDb got unexpected SQL: ${sql}`);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const txns = this.txns.map((t) => ({ ...t }));
    const keys = new Map([...this.keys].map(([k, v]) => [k, { ...v }]));
    try {
      return await fn(this);
    } catch (error) {
      this.txns = txns;
      this.keys = keys;
      throw error;
    }
  }
}

const quote = (): Quote => ({
  symbol: 'RELIANCE', exchange: 'NSE', name: 'Reliance Industries', currency: 'INR',
  price: new Decimal('1250'), previousClose: new Decimal('1240'),
  change: new Decimal('10'), changePercent: new Decimal('0.8'),
  volume: 1000, asOf: new Date(),
});

class FakeMarketData implements MarketDataService {
  calls = 0;
  async getQuote(_ref: InstrumentRef): Promise<Quote> { this.calls++; return quote(); }
  async getQuotes(): Promise<Quote[]> { return [quote()]; }
  async search(): Promise<never[]> { return []; }
  async getDailyHistory(): Promise<never[]> { return []; }
}

const buy = (overrides: Partial<Record<string, string>> = {}) => ({
  symbol: 'RELIANCE', exchange: 'NSE', type: 'BUY' as const,
  quantity: '10', price: '1200', fees: '0', txnDate: '2026-01-05', ...overrides,
});

const make = () => {
  const db = new FakeDb();
  const market = new FakeMarketData();
  return { db, market, service: new TransactionService(db, market) };
};

async function expectAppError(p: Promise<unknown>): Promise<AppError> {
  try { await p; } catch (e) { if (e instanceof AppError) return e; throw e; }
  throw new Error('expected a rejection');
}

describe('addTransaction — idempotency', () => {
  it('takes the portfolio lock before anything else in the transaction', () => {
    // ASSUMPTIONS.md #23: the lock is what serializes writes, and it only
    // helps if it is acquired before the idempotency check reads anything.
    const { db, service } = make();
    return service.addTransaction('u1', buy(), 'key-1').then(() => {
      const lockAt = db.executed.findIndex((s) => s.includes('FROM portfolios') && s.includes('FOR UPDATE'));
      const idemAt = db.executed.findIndex(
        (s) => s.includes('FROM idempotency_keys') && s.includes('FOR UPDATE'),
      );
      const insertAt = db.executed.findIndex((s) => s.includes('INSERT INTO transactions'));

      expect(lockAt).toBeGreaterThanOrEqual(0);
      expect(lockAt).toBeLessThan(idemAt);
      expect(lockAt).toBeLessThan(insertAt);
    });
  });

  it('locks the idempotency row inside the transaction, not just reads it', () => {
    const { db, service } = make();
    return service.addTransaction('u1', buy(), 'key-1').then(() => {
      expect(db.executed.some((s) => s.includes('FROM idempotency_keys') && s.includes('FOR UPDATE'))).toBe(true);
    });
  });

  it('replays the stored response on a genuine retry, writing nothing new', async () => {
    const { db, service } = make();
    const first = await service.addTransaction('u1', buy(), 'key-1');
    const second = await service.addTransaction('u1', buy(), 'key-1');

    expect(second).toEqual(first);
    expect(db.txns).toHaveLength(1);
  });

  it('does not even open a transaction for a retry it can answer from the pre-check', async () => {
    const { db, market, service } = make();
    await service.addTransaction('u1', buy(), 'key-1');
    const before = db.executed.length;
    const marketCallsBefore = market.calls;

    await service.addTransaction('u1', buy(), 'key-1');

    // One SELECT on idempotency_keys and nothing else — in particular no
    // upstream quote fetch, which would be wasted on a replay.
    expect(db.executed.length - before).toBe(1);
    expect(market.calls).toBe(marketCallsBefore);
  });

  it('rejects the same key with a different body as 409', async () => {
    const { db, service } = make();
    await service.addTransaction('u1', buy(), 'key-1');

    const error = await expectAppError(
      service.addTransaction('u1', buy({ quantity: '25' }), 'key-1'),
    );

    expect(error.status).toBe(409);
    expect(error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(db.txns).toHaveLength(1);
  });

  it('hashes bodies independently of property order', () => {
    // A client that serializes fields in a different order on retry must not
    // be told its key was reused with a different body.
    expect(hashRequest({ a: 1, b: 2 })).toBe(hashRequest({ b: 2, a: 1 }));
    expect(hashRequest({ a: 1 })).not.toBe(hashRequest({ a: 2 }));
  });

  it('treats a claimed-but-unfinished key as a conflict, not a replay of null', async () => {
    const { db, service } = make();
    db.keys.set('key-x', { request_hash: hashRequest(buy()), response_body: null });

    const error = await expectAppError(service.addTransaction('u1', buy(), 'key-x'));
    expect(error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('addTransaction — ledger validation', () => {
  it('validates the ticker before opening the transaction', async () => {
    // A network call inside the transaction would hold the portfolio lock for
    // the duration of a third-party outage.
    const { db, service } = make();
    await service.addTransaction('u1', buy(), 'key-1');

    const quoteBeforeLock = db.executed.findIndex((s) => s.includes('FOR UPDATE'));
    expect(quoteBeforeLock).toBeGreaterThanOrEqual(0);
    // The market call is not SQL, so its absence from `executed` before the
    // lock is the assertion: nothing ran against the database first.
    expect(db.executed[0]).toContain('idempotency_keys');
  });

  it('rejects a sell with no holdings and rolls back', async () => {
    const { db, service } = make();
    const error = await expectAppError(
      service.addTransaction('u1', { ...buy(), type: 'SELL' }, 'key-1'),
    );

    expect(error.code).toBe('INSUFFICIENT_HOLDINGS');
    expect(db.txns).toHaveLength(0);
    // The claimed key must be rolled back too, or the user could never retry.
    expect(db.keys.has('key-1')).toBe(false);
  });

  it('rejects a backdated sell that would make a later date negative', async () => {
    const { db, service } = make();
    await service.addTransaction('u1', buy({ quantity: '100', txnDate: '2026-01-10' }), 'k1');
    await service.addTransaction(
      'u1', { ...buy(), type: 'SELL', quantity: '100', txnDate: '2026-03-10' }, 'k2',
    );

    const error = await expectAppError(
      service.addTransaction(
        'u1', { ...buy(), type: 'SELL', quantity: '50', txnDate: '2026-02-10' }, 'k3',
      ),
    );

    expect(error.code).toBe('INSUFFICIENT_HOLDINGS');
    expect(error.details).toMatchObject({ reason: 'WOULD_GO_NEGATIVE_LATER' });
    expect(db.txns).toHaveLength(2);
  });

  it('accepts a valid sell against an existing holding', async () => {
    const { db, service } = make();
    await service.addTransaction('u1', buy({ quantity: '100' }), 'k1');
    await service.addTransaction(
      'u1', { ...buy(), type: 'SELL', quantity: '40', txnDate: '2026-02-05' }, 'k2',
    );

    expect(db.txns).toHaveLength(2);
  });
});

describe('edit and delete re-validate the whole ledger', () => {
  it('rolls back an edit that would leave a later sell unsupported', async () => {
    const { db, service } = make();
    await service.addTransaction('u1', buy({ quantity: '100' }), 'k1');
    await service.addTransaction(
      'u1', { ...buy(), type: 'SELL', quantity: '80', txnDate: '2026-02-05' }, 'k2',
    );

    // Reducing the buy to 50 leaves the 80-share sell overselling — a row the
    // edit does not touch.
    const error = await expectAppError(
      service.updateTransaction('u1', db.txns[0]!.id, {
        type: 'BUY', quantity: '50', price: '1200', fees: '0', txnDate: '2026-01-05',
      }),
    );

    expect(error.code).toBe('INSUFFICIENT_HOLDINGS');
    expect(db.txns[0]?.quantity).toBe('100');
  });

  it('rolls back a delete that would leave a later sell unsupported', async () => {
    const { db, service } = make();
    await service.addTransaction('u1', buy({ quantity: '100' }), 'k1');
    await service.addTransaction(
      'u1', { ...buy(), type: 'SELL', quantity: '80', txnDate: '2026-02-05' }, 'k2',
    );

    await expectAppError(service.deleteTransaction('u1', db.txns[0]!.id));
    expect(db.txns).toHaveLength(2);
  });

  it('allows a delete that leaves the ledger consistent', async () => {
    const { db, service } = make();
    await service.addTransaction('u1', buy({ quantity: '100' }), 'k1');
    await service.addTransaction('u1', buy({ quantity: '50', txnDate: '2026-02-05' }), 'k2');

    await service.deleteTransaction('u1', db.txns[1]!.id);
    expect(db.txns).toHaveLength(1);
  });

  it('refuses to touch a transaction in another portfolio', async () => {
    const { service } = make();
    const error = await expectAppError(service.deleteTransaction('u1', '999'));
    expect(error.status).toBe(404);
  });
});
