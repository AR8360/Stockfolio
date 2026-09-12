import { TtlCache, quoteTtlMs } from '../cache/TtlCache.js';
import type {
  Candle,
  HistoryRange,
  InstrumentRef,
  MarketDataService,
  Quote,
  SearchResult,
} from './types.js';

/**
 * Caching decorator around any `MarketDataService` (IMPLEMENTATION_PLAN.md §4.5).
 *
 * A wrapper rather than caching inside the Yahoo adapter, so caching policy is
 * testable without the network and the adapter stays a pure translation layer.
 * It also means a future provider gets the same caching for free.
 *
 * This is load-bearing, not an optimization: with Yahoo's batch quote endpoint
 * behind a 401 (ASSUMPTIONS.md #13), the movers basket costs one upstream
 * request per symbol, and the coalescing here is what turns a 50-symbol page
 * load into 50 calls per TTL window rather than per request.
 */
export class CachedMarketDataService implements MarketDataService {
  readonly #inner: MarketDataService;
  readonly #cache = new TtlCache();

  constructor(inner: MarketDataService) {
    this.#inner = inner;
  }

  async getQuote(ref: InstrumentRef): Promise<Quote> {
    const { value } = await this.#cache.get(
      `quote:${ref.exchange}:${ref.symbol}`,
      quoteTtlMs(),
      () => this.#inner.getQuote(ref),
    );
    return value;
  }

  /** Fans out through `getQuote`, so every symbol goes through the cache and
   *  duplicate concurrent requests for the same symbol coalesce. Failures are
   *  dropped per-symbol rather than failing the basket. */
  async getQuotes(refs: readonly InstrumentRef[]): Promise<Quote[]> {
    const settled = await Promise.allSettled(refs.map((ref) => this.getQuote(ref)));
    const quotes = settled.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));

    if (quotes.length === 0 && refs.length > 0) {
      // Nothing resolved and nothing cached: report the failure rather than an
      // empty basket, which would render as "no movers today".
      return this.#inner.getQuotes(refs);
    }
    return quotes;
  }

  async search(query: string): Promise<SearchResult[]> {
    // Short TTL regardless of market hours: search results are metadata, not
    // prices, and the value here is absorbing autocomplete keystroke bursts
    // for the same prefix (ASSUMPTIONS.md #25).
    const { value } = await this.#cache.get(
      `search:${query.toLowerCase()}`,
      5 * 60_000,
      () => this.#inner.search(query),
    );
    return value;
  }

  async getDailyHistory(ref: InstrumentRef, range: HistoryRange): Promise<Candle[]> {
    // Daily candles only change once a day; the cost of a stale one is at most
    // today's incomplete bar.
    const { value } = await this.#cache.get(
      `history:${ref.exchange}:${ref.symbol}:${range}`,
      15 * 60_000,
      () => this.#inner.getDailyHistory(ref, range),
    );
    return value;
  }
}
