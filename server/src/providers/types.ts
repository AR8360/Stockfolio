import type { Decimal } from 'decimal.js';

/**
 * The application-facing market data contract (IMPLEMENTATION_PLAN.md §4.1).
 *
 * Nothing in these types mentions Yahoo. That is the point: this interface is
 * the seam that makes adding US market data later "a new implementation, not a
 * rewrite" (ASSUMPTIONS.md #1), and it is also what lets services be tested
 * without network access by substituting a fake.
 *
 * Money is `Decimal`, never `number`. The conversion happens inside the
 * adapter, at the moment the untrusted payload is parsed, so a native float
 * from an external API never reaches the FIFO calculator (ASSUMPTIONS.md #20).
 * Making that the *type* of the boundary rather than a convention means
 * forgetting it is a compile error.
 */

/** An instrument identified the way this application identifies it -- symbol
 *  plus exchange -- rather than the way a provider happens to encode it. */
export interface InstrumentRef {
  /** Bare, uppercase, no provider suffix: "RELIANCE", not "RELIANCE.NS". */
  symbol: string;
  /** "NSE" | "BSE" today; the type stays open for other markets. */
  exchange: string;
}

export interface Quote extends InstrumentRef {
  name: string;
  /** ISO 4217, uppercase. */
  currency: string;
  price: Decimal;
  previousClose: Decimal;
  change: Decimal;
  changePercent: Decimal;
  /** A share count, not a money value, so `number` is correct here. */
  volume: number;
  /** When the provider says this price was current -- not when we fetched it.
   *  The distinction matters after hours, where the two differ by many hours
   *  and only the former is meaningful to display (ASSUMPTIONS.md #15). */
  asOf: Date;
}

export interface SearchResult extends InstrumentRef {
  name: string;
}

export interface Candle {
  /** Trading day, no intraday component (ASSUMPTIONS.md #3). */
  date: Date;
  open: Decimal;
  high: Decimal;
  low: Decimal;
  close: Decimal;
  volume: number;
}

export interface MarketDataService {
  /**
   * Throws `UNKNOWN_SYMBOL` (404) when the instrument does not resolve, and
   * `UPSTREAM_UNAVAILABLE` (502) when the provider itself failed. Callers need
   * to distinguish these: the first is a user error at trade entry
   * (ASSUMPTIONS.md #9), the second is a transient condition the cache should
   * paper over (ASSUMPTIONS.md #16).
   */
  getQuote(ref: InstrumentRef): Promise<Quote>;

  /** Batch form. Implementations are free to fan out; callers should prefer
   *  this over looping `getQuote` so the adapter can coalesce and cache. */
  getQuotes(refs: readonly InstrumentRef[]): Promise<Quote[]>;

  search(query: string): Promise<SearchResult[]>;

  getDailyHistory(ref: InstrumentRef, range: HistoryRange): Promise<Candle[]>;
}

export const HISTORY_RANGES = ['1mo', '3mo', '6mo', '1y', '5y'] as const;
export type HistoryRange = (typeof HISTORY_RANGES)[number];
