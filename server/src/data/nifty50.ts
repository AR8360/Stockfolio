import type { InstrumentRef } from '../providers/types.js';

/**
 * Fixed Nifty 50 basket used to compute "today's movers" (ASSUMPTIONS.md #13).
 *
 * Yahoo's unofficial endpoints expose no gainers/losers/most-active feed for
 * NSE, so the app fetches this basket and ranks it in application code. The
 * cost of a fixed list is that it goes stale as the index is rebalanced; a
 * real exchange-provided movers feed would not need it.
 */
export const NIFTY_50: readonly InstrumentRef[] = [
  'RELIANCE', 'TCS', 'HDFCBANK', 'ICICIBANK', 'INFY', 'HINDUNILVR', 'ITC',
  'SBIN', 'BHARTIARTL', 'KOTAKBANK', 'LT', 'AXISBANK', 'ASIANPAINT', 'MARUTI',
  'BAJFINANCE', 'HCLTECH', 'SUNPHARMA', 'TITAN', 'ULTRACEMCO', 'WIPRO',
  'NESTLEIND', 'ONGC', 'NTPC', 'POWERGRID', 'TATAMOTORS', 'TATASTEEL',
  'JSWSTEEL', 'ADANIENT', 'ADANIPORTS', 'COALINDIA', 'GRASIM', 'HINDALCO',
  'DRREDDY', 'CIPLA', 'BRITANNIA', 'EICHERMOT', 'HEROMOTOCO', 'BAJAJ-AUTO',
  'DIVISLAB', 'INDUSINDBK', 'TECHM', 'APOLLOHOSP', 'BPCL', 'TATACONSUM',
  'SBILIFE', 'HDFCLIFE', 'BAJAJFINSV', 'UPL', 'SHRIRAMFIN', 'LTIM',
].map((symbol) => ({ symbol, exchange: 'NSE' }));
