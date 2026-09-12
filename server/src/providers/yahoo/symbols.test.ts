import { describe, expect, it } from 'vitest';

import { fromYahooSymbol, toYahooSymbol } from './symbols.js';

describe('toYahooSymbol', () => {
  it('suffixes NSE and BSE distinctly', () => {
    expect(toYahooSymbol({ symbol: 'RELIANCE', exchange: 'NSE' })).toBe('RELIANCE.NS');
    expect(toYahooSymbol({ symbol: 'RELIANCE', exchange: 'BSE' })).toBe('RELIANCE.BO');
  });

  it('normalizes case so a lowercase entry cannot miss', () => {
    expect(toYahooSymbol({ symbol: 'tcs', exchange: 'nse' })).toBe('TCS.NS');
  });

  it('throws on an exchange it cannot encode', () => {
    // Loudly, rather than defaulting to a suffix: guessing here fetches a
    // real price for the wrong instrument, which no downstream layer can detect.
    expect(() => toYahooSymbol({ symbol: 'AAPL', exchange: 'NASDAQ' })).toThrow();
  });
});

describe('fromYahooSymbol', () => {
  it('round-trips every supported exchange', () => {
    for (const exchange of ['NSE', 'BSE']) {
      const encoded = toYahooSymbol({ symbol: 'INFY', exchange });
      expect(fromYahooSymbol(encoded)).toEqual({ symbol: 'INFY', exchange });
    }
  });

  it('returns null for an unsuffixed (US) ticker', () => {
    expect(fromYahooSymbol('AAPL')).toBeNull();
  });

  it('returns null for a suffix this app does not support', () => {
    expect(fromYahooSymbol('BARC.L')).toBeNull();
  });

  it('splits on the last dot, so a dotted ticker keeps its dot', () => {
    // Real NSE tickers contain dots (e.g. M&M.NS, BAJAJ-AUTO.NS variants).
    // Splitting on the first dot would silently truncate the symbol.
    expect(fromYahooSymbol('A.B.NS')).toEqual({ symbol: 'A.B', exchange: 'NSE' });
  });
});
