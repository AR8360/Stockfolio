import { calculateFifoPosition } from '../domain/fifo.js';
import { Decimal, ZERO, safeDivide, toMoneyScale } from '../domain/money.js';
import { notFound } from '../errors/AppError.js';
import type { Database } from '../database/pool.js';
import { lockPortfolioForUser } from '../database/portfolios.js';
import {
  listPortfolioLedger,
  type TransactionWithInstrument,
} from '../database/transactions.js';
import type { InstrumentRef, MarketDataService, Quote } from '../providers/types.js';
import { toFifoTrade, parseDate } from './TransactionService.js';

/**
 * The read path (IMPLEMENTATION_PLAN.md §4.3, §5).
 *
 * Uses the same `calculateFifoPosition` as the write path — one implementation,
 * two call sites, so a displayed number can never disagree with a validated
 * one.
 */

export interface Holding {
  symbol: string;
  exchange: string;
  name: string;
  currency: string;
  quantity: string;
  averageCost: string;
  costBasis: string;
  currentPrice: string | null;
  marketValue: string | null;
  unrealizedGain: string | null;
  unrealizedGainPercent: string | null;
  realizedGain: string;
  /** True when the price shown came from cache after a failed refresh
   *  (ASSUMPTIONS.md #16) or could not be fetched at all. */
  priceStale: boolean;
}

export interface PortfolioSummary {
  costBasis: string;
  marketValue: string | null;
  /** Kept separate from realized, never merged into one figure
   *  (ASSUMPTIONS.md #4). */
  unrealizedGain: string | null;
  realizedGain: string;
  totalGain: string | null;
  holdingCount: number;
  pricesStale: boolean;
}

export class PortfolioService {
  readonly #db: Database;
  readonly #marketData: MarketDataService;

  constructor(db: Database, marketData: MarketDataService) {
    this.#db = db;
    this.#marketData = marketData;
  }

  async getHoldings(userId: string): Promise<Holding[]> {
    const { holdings } = await this.#compute(userId);
    return holdings;
  }

  async getSummary(userId: string): Promise<PortfolioSummary> {
    const { holdings, closedRealized } = await this.#compute(userId);

    const costBasis = holdings.reduce((t, h) => t.plus(h.costBasis), ZERO);
    const realizedGain = holdings
      .reduce((t, h) => t.plus(h.realizedGain), ZERO)
      .plus(closedRealized);

    // Any missing price makes the total unknowable rather than merely smaller —
    // reporting a partial sum as the portfolio value would understate it
    // silently, which is worse than saying the value is unavailable.
    const anyMissing = holdings.some((h) => h.marketValue === null);
    const marketValue = anyMissing
      ? null
      : holdings.reduce((t, h) => t.plus(h.marketValue ?? '0'), ZERO);

    const unrealizedGain = marketValue === null ? null : marketValue.minus(costBasis);

    return {
      costBasis: costBasis.toString(),
      marketValue: marketValue?.toString() ?? null,
      unrealizedGain: unrealizedGain?.toString() ?? null,
      realizedGain: realizedGain.toString(),
      totalGain: unrealizedGain === null ? null : unrealizedGain.plus(realizedGain).toString(),
      holdingCount: holdings.length,
      pricesStale: holdings.some((h) => h.priceStale),
    };
  }

  async listTransactions(userId: string): Promise<TransactionWithInstrument[]> {
    const portfolio = await this.#portfolio(userId);
    const rows = await listPortfolioLedger(this.#db, portfolio);
    // Most recent first for display; the FIFO replay does its own ordering.
    return [...rows].sort((a, b) => b.txn_date.localeCompare(a.txn_date));
  }

  async #portfolio(userId: string): Promise<string> {
    // Deliberately not FOR UPDATE: this is the read path and must not block or
    // be blocked by concurrent writes.
    const result = await this.#db.query<{ id: string }>(
      `SELECT id FROM portfolios WHERE user_id = $1`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) throw notFound('Portfolio not found');
    return row.id;
  }

  async #compute(userId: string): Promise<{ holdings: Holding[]; closedRealized: Decimal }> {
    const portfolioId = await this.#portfolio(userId);
    const rows = await listPortfolioLedger(this.#db, portfolioId);

    const byInstrument = new Map<string, TransactionWithInstrument[]>();
    for (const row of rows) {
      const existing = byInstrument.get(row.instrument_id);
      if (existing) existing.push(row);
      else byInstrument.set(row.instrument_id, [row]);
    }

    // One batched fetch for every instrument, rather than a quote lookup per
    // holding — the provider fans out and the cache coalesces duplicates.
    const refs: InstrumentRef[] = [...byInstrument.values()]
      .map((group) => group[0])
      .filter((row): row is TransactionWithInstrument => row !== undefined)
      .map((row) => ({ symbol: row.symbol, exchange: row.exchange }));

    const quotes = await this.#quotes(refs);

    const holdings: Holding[] = [];
    let closedRealized = ZERO;

    for (const group of byInstrument.values()) {
      const first = group[0];
      if (!first) continue;

      const quote = quotes.get(quoteKey(first.symbol, first.exchange));
      const position = calculateFifoPosition(
        group.map(toFifoTrade),
        quote ? { currentPrice: quote.price } : {},
      );

      if (position.quantity.isZero()) {
        // Fully-sold positions leave the holdings view but keep contributing
        // realized gain (ASSUMPTIONS.md #5).
        closedRealized = closedRealized.plus(position.realizedGain);
        continue;
      }

      holdings.push({
        symbol: first.symbol,
        exchange: first.exchange,
        name: first.instrument_name,
        currency: first.currency,
        quantity: position.quantity.toString(),
        averageCost: toMoneyScale(position.averageCost).toString(),
        costBasis: toMoneyScale(position.costBasis).toString(),
        currentPrice: quote?.price.toString() ?? null,
        marketValue: position.marketValue === null ? null : toMoneyScale(position.marketValue).toString(),
        unrealizedGain:
          position.unrealizedGain === null ? null : toMoneyScale(position.unrealizedGain).toString(),
        unrealizedGainPercent:
          position.unrealizedGain === null
            ? null
            : toMoneyScale(
                safeDivide(position.unrealizedGain, position.costBasis).times(100),
              ).toString(),
        realizedGain: toMoneyScale(position.realizedGain).toString(),
        priceStale: quote === undefined,
      });
    }

    holdings.sort((a, b) => a.symbol.localeCompare(b.symbol));
    return { holdings, closedRealized };
  }

  async #quotes(refs: readonly InstrumentRef[]): Promise<Map<string, Quote>> {
    const map = new Map<string, Quote>();
    if (refs.length === 0) return map;

    try {
      for (const quote of await this.#marketData.getQuotes(refs)) {
        map.set(quoteKey(quote.symbol, quote.exchange), quote);
      }
    } catch {
      // A total provider failure degrades the page to cost-basis-only rather
      // than failing it. The holdings, quantities and realized gain are all
      // computed from the ledger and remain correct without a price; only the
      // market-value columns go null and the rows are flagged stale
      // (ASSUMPTIONS.md #16).
    }

    return map;
  }
}

const quoteKey = (symbol: string, exchange: string): string => `${exchange}:${symbol}`;

export { parseDate, lockPortfolioForUser };
