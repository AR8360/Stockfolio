import type { Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { AuthService } from './services/AuthService.js';
import { DashboardService } from './services/DashboardService.js';
import { PortfolioService } from './services/PortfolioService.js';
import { TransactionService } from './services/TransactionService.js';
import { signAccessToken } from './auth/tokens.js';
import type { Database, Queryable } from './database/pool.js';
import type { MarketDataService } from './providers/types.js';

/**
 * Tier 3 (IMPLEMENTATION_PLAN.md §8): boot the real app with stub
 * dependencies that should *never* be called.
 *
 * The assertion is inverted from a normal integration test. Every request here
 * is invalid, and the test passes only if validation rejects it before the
 * database or the market data provider is touched at all — a stub being called
 * is itself a failure. That is what proves bad input cannot reach the ledger
 * or burn an upstream API call.
 */

class ExplodingDatabase implements Database {
  calls: string[] = [];

  async query(sql: string): Promise<never> {
    this.calls.push(sql.replace(/\s+/g, ' ').trim().slice(0, 60));
    throw new Error('database was reached by a request that should have been rejected');
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    this.calls.push('BEGIN');
    return fn(this);
  }
}

class ExplodingMarketData implements MarketDataService {
  calls: string[] = [];

  async getQuote(): Promise<never> {
    this.calls.push('getQuote');
    throw new Error('market data provider was reached');
  }
  async getQuotes(): Promise<never> {
    this.calls.push('getQuotes');
    throw new Error('market data provider was reached');
  }
  async search(): Promise<never> {
    this.calls.push('search');
    throw new Error('market data provider was reached');
  }
  async getDailyHistory(): Promise<never> {
    this.calls.push('getDailyHistory');
    throw new Error('market data provider was reached');
  }
}

let server: Server;
let baseUrl: string;
const db = new ExplodingDatabase();
const marketData = new ExplodingMarketData();

beforeAll(async () => {
  const app = createApp({
    marketData,
    auth: new AuthService(db),
    transactions: new TransactionService(db, marketData),
    portfolio: new PortfolioService(db, marketData),
    dashboard: new DashboardService(marketData),
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { resolve(); });
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${String(port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function resetStubs(): void {
  db.calls = [];
  marketData.calls = [];
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  resetStubs();
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

/**
 * A genuinely signed token, not a placeholder.
 *
 * `authenticate` is deliberately dumb — it verifies the JWT and attaches the
 * id without any database call (§4.4) — so a real token gets these requests
 * past auth and makes *validation* the thing under test. With a fake token
 * every case below would return 401 and the test would pass whether or not
 * the validation it claims to cover still exists.
 */
const AUTH = { Authorization: `Bearer ${signAccessToken('1')}` };
const KEY = { 'Idempotency-Key': '11111111-1111-1111-1111-111111111111' };

describe('unauthenticated requests are rejected before any dependency', () => {
  for (const path of [
    '/api/portfolio/holdings',
    '/api/portfolio/summary',
    '/api/portfolio/transactions',
  ]) {
    it(`rejects ${path} with no token`, async () => {
      resetStubs();
      const response = await fetch(`${baseUrl}${path}`);

      expect(response.status).toBe(401);
      expect(db.calls).toEqual([]);
      expect(marketData.calls).toEqual([]);
    });
  }

  it('rejects a forged alg:none token without a database lookup', async () => {
    resetStubs();
    const response = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: 'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.' },
    });

    expect(response.status).toBe(401);
    expect(db.calls).toEqual([]);
  });
});

describe('malformed trade input is rejected before the database or provider', () => {
  const valid = {
    symbol: 'RELIANCE',
    exchange: 'NSE',
    type: 'BUY',
    quantity: '10',
    price: '1200',
    fees: '0',
    txnDate: '2026-01-05',
  };

  const cases: Array<[string, Record<string, unknown>]> = [
    ['non-positive price', { ...valid, price: '0' }],
    ['negative-looking price', { ...valid, price: '-5' }],
    ['zero quantity', { ...valid, quantity: '0' }],
    ['fractional quantity on NSE', { ...valid, quantity: '1.5' }],
    ['too many decimal places', { ...valid, price: '12.123456' }],
    ['future-dated trade', { ...valid, txnDate: '2099-01-01' }],
    ['malformed date', { ...valid, txnDate: '05-01-2026' }],
    ['unsupported exchange', { ...valid, exchange: 'NASDAQ' }],
    ['unknown trade type', { ...valid, type: 'HOLD' }],
    ['negative fees', { ...valid, fees: '-1' }],
    ['unknown field (strict)', { ...valid, sneaky: 1 }],
  ];

  for (const [label, body] of cases) {
    it(`rejects ${label}`, async () => {
      const response = await post('/api/portfolio/transactions', body, { ...AUTH, ...KEY });

      expect(response.status).toBe(400);
      expect(db.calls).toEqual([]);
      expect(marketData.calls).toEqual([]);
    });
  }

  it('rejects a missing Idempotency-Key before validating the body', async () => {
    const response = await post('/api/portfolio/transactions', valid, AUTH);

    expect(response.status).toBe(400);
    expect(db.calls).toEqual([]);
    expect(marketData.calls).toEqual([]);
  });

  it('rejects a non-UUID Idempotency-Key', async () => {
    const response = await post('/api/portfolio/transactions', valid, {
      ...AUTH,
      'Idempotency-Key': 'not-a-uuid',
    });

    expect(response.status).toBe(400);
    expect(db.calls).toEqual([]);
  });
});

describe('malformed auth input is rejected before the database', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['short password', { email: 'a@b.com', password: 'short', name: 'A' }],
    ['invalid email', { email: 'not-an-email', password: 'longenough1', name: 'A' }],
    ['missing name', { email: 'a@b.com', password: 'longenough1' }],
    ['unknown field', { email: 'a@b.com', password: 'longenough1', name: 'A', admin: true }],
  ];

  for (const [label, body] of cases) {
    it(`rejects register with ${label}`, async () => {
      const response = await post('/api/auth/register', body);

      expect(response.status).toBe(400);
      expect(db.calls).toEqual([]);
    });
  }

  it('rejects a malformed JSON body as 400, not 500', async () => {
    resetStubs();
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{oops',
    });

    expect(response.status).toBe(400);
    expect(db.calls).toEqual([]);
  });
});

describe('malformed stock lookups are rejected before the provider', () => {
  it('rejects an unsupported exchange in the path', async () => {
    resetStubs();
    const response = await fetch(`${baseUrl}/api/stocks/NASDAQ/AAPL`);

    expect(response.status).toBe(400);
    expect(marketData.calls).toEqual([]);
  });

  it('rejects an empty search term', async () => {
    resetStubs();
    const response = await fetch(`${baseUrl}/api/stocks/search?q=`);

    expect(response.status).toBe(400);
    expect(marketData.calls).toEqual([]);
  });

  it('rejects an unknown history range', async () => {
    resetStubs();
    const response = await fetch(`${baseUrl}/api/stocks/NSE/TCS/history?range=99y`);

    expect(response.status).toBe(400);
    expect(marketData.calls).toEqual([]);
  });
});

describe('error envelope', () => {
  it('returns the documented shape for an unknown route', async () => {
    const response = await fetch(`${baseUrl}/api/nope`);
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toBeTypeOf('string');
  });
});
