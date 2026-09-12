import { AppError, ErrorCodes, upstreamUnavailable } from '../../errors/AppError.js';
import type {
  Candle,
  HistoryRange,
  InstrumentRef,
  MarketDataService,
  Quote,
  SearchResult,
} from '../types.js';
import { YahooHttpClient } from './client.js';
import {
  mapChartResponseToCandles,
  mapChartResponseToQuote,
  mapSearchResponse,
} from './mapper.js';
import { chartResponseSchema, searchResponseSchema } from './schemas.js';
import { toYahooSymbol } from './symbols.js';

const CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const SEARCH_BASE = 'https://query2.finance.yahoo.com/v1/finance/search';

/**
 * `MarketDataService` backed by Yahoo's unofficial endpoints
 * (IMPLEMENTATION_PLAN.md §4.1).
 *
 * This class is the only file in the application that knows Yahoo exists.
 * Everything above it consumes the interface in `providers/types.ts`, which is
 * what makes "add US markets later" an additive change (ASSUMPTIONS.md #1) and
 * what makes the services independently testable.
 *
 * No caching here, deliberately. The market-hours-aware cache with request
 * coalescing (§4.5) wraps this class rather than living inside it, so caching
 * policy can be tested without the network and this adapter stays a pure
 * translation layer.
 */
export class YahooMarketDataProvider implements MarketDataService {
  readonly #http: YahooHttpClient;

  constructor(http: YahooHttpClient = new YahooHttpClient()) {
    this.#http = http;
  }

  async getQuote(ref: InstrumentRef): Promise<Quote> {
    const response = await this.#fetchChart(ref, {
      range: '1d',
      interval: '1d',
    });

    const quote = mapChartResponseToQuote(response);
    if (!quote) {
      throw unknownSymbol(ref);
    }

    return quote;
  }

  /**
   * One request per symbol, because Yahoo's batch quote endpoint
   * (`/v7/finance/quote`) now returns 401 -- it was moved behind a
   * crumb/cookie handshake. The plan (§5) assumed one call for the whole
   * Nifty 50 basket; that is no longer available unauthenticated.
   *
   * `allSettled`, not `all`: the movers dashboard is a summary over a basket,
   * and one delisted or failing constituent must not blank the entire page.
   * Failures are dropped here and the caller works with what resolved -- the
   * degraded-but-useful behaviour assumption #16 asks for.
   */
  async getQuotes(refs: readonly InstrumentRef[]): Promise<Quote[]> {
    const settled = await Promise.allSettled(
      refs.map((ref) => this.getQuote(ref)),
    );

    const quotes: Quote[] = [];
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        quotes.push(outcome.value);
      }
    }

    // If *nothing* resolved, this is not a partially degraded basket -- the
    // provider is down, and reporting an empty movers list as success would
    // render as "the market has no gainers today", which is worse than an
    // honest error.
    if (quotes.length === 0 && refs.length > 0) {
      throw upstreamUnavailable();
    }

    return quotes;
  }

  async search(query: string): Promise<SearchResult[]> {
    const url = new URL(SEARCH_BASE);
    url.searchParams.set('q', query);
    url.searchParams.set('quotesCount', '10');
    // Explicitly zero: the news payload is large, and news is out of scope
    // (ASSUMPTIONS.md #6). No reason to pay for bytes we discard.
    url.searchParams.set('newsCount', '0');

    const body = await this.#http.getJson(url.toString());
    const parsed = searchResponseSchema.safeParse(body);

    if (!parsed.success) {
      // A shape change in the provider is an upstream failure, not a 500. The
      // parse error is attached as the cause so the log identifies which field
      // moved -- the whole point of validating at this seam.
      throw upstreamUnavailable('Market data provider returned an unexpected search response');
    }

    return mapSearchResponse(parsed.data);
  }

  async getDailyHistory(
    ref: InstrumentRef,
    range: HistoryRange,
  ): Promise<Candle[]> {
    const response = await this.#fetchChart(ref, { range, interval: '1d' });
    return mapChartResponseToCandles(response);
  }

  async #fetchChart(
    ref: InstrumentRef,
    params: { range: string; interval: string },
  ): Promise<ReturnType<typeof chartResponseSchema.parse>> {
    const url = new URL(`${CHART_BASE}/${toYahooSymbol(ref)}`);
    url.searchParams.set('range', params.range);
    url.searchParams.set('interval', params.interval);

    // allowErrorStatus: an unknown symbol comes back as 404 with a meaningful
    // JSON body. Treating the status as the outcome would turn a user typo at
    // trade entry into a 502, which is both the wrong status and the wrong
    // message (ASSUMPTIONS.md #9 needs this to be a clean validation failure).
    const body = await this.#http.getJson(url.toString(), {
      allowErrorStatus: true,
    });

    const parsed = chartResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw upstreamUnavailable('Market data provider returned an unexpected response');
    }

    // The provider reports "no such symbol" inside the body, on both 200 and
    // 404 responses, so this check -- not the HTTP status -- is what
    // distinguishes a bad ticker from a broken provider.
    if (parsed.data.chart.error !== null || parsed.data.chart.result === null) {
      throw unknownSymbol(ref);
    }

    return parsed.data;
  }
}

function unknownSymbol(ref: InstrumentRef): AppError {
  return new AppError({
    status: 404,
    code: ErrorCodes.UNKNOWN_SYMBOL,
    message: `No market data found for ${ref.symbol} on ${ref.exchange}`,
  });
}
