import { Decimal } from 'decimal.js';

import type { Candle, Quote, SearchResult } from '../types.js';
import type { ChartResponse, SearchResponse } from './schemas.js';
import { fromYahooSymbol } from './symbols.js';

/**
 * Provider payload -> application domain (IMPLEMENTATION_PLAN.md §4.1).
 *
 * Pure, synchronous, and separate from the HTTP client on purpose: every
 * interesting decision in this file (which field is the name, how a percent is
 * derived, what to do with a gappy candle array) is testable against a
 * captured fixture with no network involved.
 *
 * This is also the layer where native `number` stops. Values arrive from JSON
 * as floats and leave as `Decimal` (ASSUMPTIONS.md #20). The conversion goes
 * via `String(value)` rather than `new Decimal(value)` directly, so the
 * decimal is built from the shortest representation that round-trips the
 * float, not from its full binary expansion -- 1257.5 becomes exactly 1257.5.
 */
const toDecimal = (value: number): Decimal => new Decimal(String(value));

/** Fallback when the provider omits `priceHint`; 2 is correct for INR and USD
 *  equities, which is everything this app can currently record. */
const DEFAULT_PRICE_DECIMALS = 2;

/**
 * Quantize a provider price to the precision the instrument actually quotes to.
 *
 * Yahoo serializes chart OHLC at float32 precision, so a close that traded at
 * 2200.80 comes back as 2200.800048828125. Those trailing digits are an
 * artefact of the wire format, not information -- rounding them off here, at
 * the boundary, is what keeps them from being displayed as a real price or
 * from reaching a valuation path where they would look like meaningful
 * precision.
 *
 * ROUND_HALF_EVEN (banker's rounding) rather than HALF_UP: it is the
 * unbiased choice, and these values are aggregated (a basket average, a chart
 * axis), where consistently rounding .5 away from zero introduces a drift that
 * accumulates in one direction.
 */
const quantize = (value: Decimal, decimals: number): Decimal =>
  value.toDecimalPlaces(decimals, Decimal.ROUND_HALF_EVEN);

export function mapChartResponseToQuote(response: ChartResponse): Quote | null {
  const result = response.chart.result?.[0];
  if (!result) {
    return null;
  }

  const { meta } = result;
  const ref = fromYahooSymbol(meta.symbol);
  if (!ref) {
    return null;
  }

  const decimals = meta.priceHint ?? DEFAULT_PRICE_DECIMALS;

  // Quantized *before* `change` is derived, not after. Rounding the inputs and
  // then subtracting guarantees the three displayed figures agree with each
  // other; subtracting first and rounding the result can leave a change that
  // does not equal the difference of the two prices shown beside it.
  const price = quantize(toDecimal(meta.regularMarketPrice), decimals);
  const previousClose = quantize(toDecimal(meta.chartPreviousClose), decimals);
  const change = price.minus(previousClose);

  return {
    symbol: ref.symbol,
    exchange: ref.exchange,
    // longName is the full legal name, shortName the exchange's abbreviated
    // one; prefer the readable one and fall back rather than showing a bare
    // ticker, which is what an empty name renders as in the UI.
    name: meta.longName ?? meta.shortName ?? ref.symbol,
    currency: meta.currency.toUpperCase(),
    price,
    previousClose,
    change,

    // Derived here rather than read from `regularMarketChangePercent`, which
    // the endpoint also provides. Two reasons: the provided field is a
    // pre-rounded float, and deriving it keeps price/change/percent mutually
    // consistent -- a UI showing a change of +16.50 next to a percent computed
    // from a differently-rounded source is the kind of discrepancy a user
    // reports as a bug.
    //
    // Guarded against a zero previous close (a newly listed instrument, or a
    // provider glitch): division returns 0 rather than NaN/Infinity, matching
    // the rule set for money arithmetic in §4.3.
    changePercent: previousClose.isZero()
      ? new Decimal(0)
      : change.dividedBy(previousClose).times(100),

    volume: meta.regularMarketVolume ?? 0,

    // Epoch *seconds*, not milliseconds -- multiplying is required, and getting
    // it wrong yields a timestamp in 1970 that still renders as a valid date.
    asOf: new Date(meta.regularMarketTime * 1000),
  };
}

export function mapSearchResponse(response: SearchResponse): SearchResult[] {
  const results: SearchResult[] = [];

  for (const quote of response.quotes) {
    // Policy, deliberately here rather than in the schema: drop anything that
    // is not an equity, and anything on an exchange this app cannot record a
    // trade against. Yahoo mixes currencies, indices and futures into the same
    // array, and offering an index as a tradeable search result leads a user
    // into a trade that can never be valued.
    if (quote.quoteType !== undefined && quote.quoteType !== 'EQUITY') {
      continue;
    }

    const ref = fromYahooSymbol(quote.symbol);
    if (!ref) {
      continue;
    }

    results.push({
      symbol: ref.symbol,
      exchange: ref.exchange,
      name: quote.longname ?? quote.shortname ?? ref.symbol,
    });
  }

  return results;
}

export function mapChartResponseToCandles(response: ChartResponse): Candle[] {
  const result = response.chart.result?.[0];
  const series = result?.indicators?.quote[0];
  const timestamps = result?.timestamp;

  if (!result || !series || !timestamps) {
    return [];
  }

  const candles: Candle[] = [];
  const decimals = result.meta.priceHint ?? DEFAULT_PRICE_DECIMALS;

  for (const [index, timestamp] of timestamps.entries()) {
    const open = series.open?.[index];
    const high = series.high?.[index];
    const low = series.low?.[index];
    const close = series.close?.[index];

    // Yahoo pads these arrays to the same length as `timestamp` and writes
    // null at trading halts and, occasionally, the current incomplete session.
    // Skipping incomplete rows rather than coercing null to 0 matters: a 0
    // close would render as a crash to zero on the chart and, worse, would be
    // a plausible-looking number if it ever reached a valuation path.
    if (
      open === null ||
      open === undefined ||
      high === null ||
      high === undefined ||
      low === null ||
      low === undefined ||
      close === null ||
      close === undefined
    ) {
      continue;
    }

    const volume = series.volume?.[index];

    candles.push({
      date: new Date(timestamp * 1000),
      open: quantize(toDecimal(open), decimals),
      high: quantize(toDecimal(high), decimals),
      low: quantize(toDecimal(low), decimals),
      close: quantize(toDecimal(close), decimals),
      volume: volume ?? 0,
    });
  }

  return candles;
}
