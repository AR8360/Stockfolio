import { NIFTY_50 } from '../data/nifty50.js';
import type { MarketDataService, Quote } from '../providers/types.js';

/**
 * Today's movers (IMPLEMENTATION_PLAN.md §5, ASSUMPTIONS.md #13).
 *
 * Computed in application code from a fixed basket, because the provider has
 * no movers feed for NSE.
 */

export interface MoverDto {
  symbol: string;
  exchange: string;
  name: string;
  price: string;
  change: string;
  changePercent: string;
  volume: number;
}

export interface OverviewDto {
  gainers: MoverDto[];
  losers: MoverDto[];
  mostActive: MoverDto[];
  /** How many basket constituents actually resolved — surfaced rather than
   *  hidden, so a partially-degraded dashboard is visibly partial. */
  sampled: number;
  asOf: string | null;
}

const TOP_N = 5;

export class DashboardService {
  readonly #marketData: MarketDataService;

  constructor(marketData: MarketDataService) {
    this.#marketData = marketData;
  }

  async getOverview(): Promise<OverviewDto> {
    // `getQuotes` drops individual failures rather than failing the basket, so
    // one delisted constituent cannot blank the whole page.
    const quotes = await this.#marketData.getQuotes(NIFTY_50);

    const byChange = [...quotes].sort((a, b) =>
      b.changePercent.comparedTo(a.changePercent),
    );
    const byVolume = [...quotes].sort((a, b) => b.volume - a.volume);

    const asOf = quotes.reduce<Date | null>(
      (latest, q) => (latest === null || q.asOf > latest ? q.asOf : latest),
      null,
    );

    return {
      gainers: byChange.slice(0, TOP_N).map(toDto),
      // Taken from the tail and reversed so the biggest loser is first,
      // matching how gainers read.
      losers: byChange.slice(-TOP_N).reverse().map(toDto),
      mostActive: byVolume.slice(0, TOP_N).map(toDto),
      sampled: quotes.length,
      asOf: asOf?.toISOString() ?? null,
    };
  }
}

function toDto(quote: Quote): MoverDto {
  return {
    symbol: quote.symbol,
    exchange: quote.exchange,
    name: quote.name,
    price: quote.price.toString(),
    change: quote.change.toString(),
    changePercent: quote.changePercent.toDecimalPlaces(2).toString(),
    volume: quote.volume,
  };
}
