import type { InstrumentRef } from '../types.js';

/**
 * Translation between this application's (symbol, exchange) pair and Yahoo's
 * single suffixed ticker string (IMPLEMENTATION_PLAN.md §4.1).
 *
 * Isolated into its own module, and pure, because it is the one piece of
 * provider encoding that leaks into user-visible behaviour: a wrong suffix
 * does not error, it silently fetches a *different company's* price -- BSE and
 * NSE list overlapping symbols. That failure mode is invisible in a running
 * app and obvious in a unit test, so it gets to be unit-testable.
 */

const EXCHANGE_TO_SUFFIX: Readonly<Record<string, string>> = {
  NSE: '.NS',
  BSE: '.BO',
};

/** Reverse map, derived rather than written out twice -- the two drifting
 *  apart is exactly the silent-wrong-company bug described above. */
const SUFFIX_TO_EXCHANGE: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(EXCHANGE_TO_SUFFIX).map(([exchange, suffix]) => [
    suffix,
    exchange,
  ]),
);

export const SUPPORTED_EXCHANGES = Object.keys(EXCHANGE_TO_SUFFIX);

export function isSupportedExchange(exchange: string): boolean {
  return Object.hasOwn(EXCHANGE_TO_SUFFIX, exchange.toUpperCase());
}

/** "RELIANCE" + "NSE" -> "RELIANCE.NS" */
export function toYahooSymbol(ref: InstrumentRef): string {
  const exchange = ref.exchange.toUpperCase();
  const suffix = EXCHANGE_TO_SUFFIX[exchange];

  if (suffix === undefined) {
    // Not an AppError: an unsupported exchange reaching this function is a
    // programming error (routes validate the exchange before calling), not a
    // user-facing condition. Throwing plainly means it surfaces as a 500 and
    // gets logged with a stack, which is the correct treatment for a bug.
    throw new Error(`Unsupported exchange for Yahoo provider: ${ref.exchange}`);
  }

  return `${ref.symbol.toUpperCase()}${suffix}`;
}

/**
 * "RELIANCE.NS" -> { symbol: "RELIANCE", exchange: "NSE" }
 *
 * Returns `null` rather than throwing for an unrecognized suffix, because this
 * runs over *search results*, where Yahoo returns instruments from markets
 * this app does not support (US equities, currencies, indices). Those are
 * filtered out, not errors.
 */
export function fromYahooSymbol(yahooSymbol: string): InstrumentRef | null {
  const dotIndex = yahooSymbol.lastIndexOf('.');
  if (dotIndex <= 0) {
    // No suffix at all: a US-listed ticker. Not supported on the live
    // dashboard today (ASSUMPTIONS.md #1).
    return null;
  }

  const suffix = yahooSymbol.slice(dotIndex);
  const exchange = SUFFIX_TO_EXCHANGE[suffix];
  if (exchange === undefined) {
    return null;
  }

  return {
    symbol: yahooSymbol.slice(0, dotIndex).toUpperCase(),
    exchange,
  };
}
