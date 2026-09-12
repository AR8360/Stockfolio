import { describe, expect, it } from 'vitest';

import {
  mapChartResponseToCandles,
  mapChartResponseToQuote,
  mapSearchResponse,
} from './mapper.js';
import { chartResponseSchema, searchResponseSchema } from './schemas.js';

import chartReliance from './__fixtures__/chart-reliance.json' with { type: 'json' };
import chartUnknown from './__fixtures__/chart-unknown-symbol.json' with { type: 'json' };
import searchReliance from './__fixtures__/search-reliance.json' with { type: 'json' };

/**
 * Tier 1 (IMPLEMENTATION_PLAN.md §8): pure functions, no mocks, no network.
 *
 * The inputs are payloads captured from the live endpoints rather than
 * hand-written objects. A hand-written fixture tests the shape we *believe*
 * the provider returns, which is the belief the schema already encodes -- so
 * it would pass even if both were wrong together. Parsing the captured file
 * through the real schema first means these tests also fail if the schema
 * drifts from reality.
 */

describe('schemas accept real captured payloads', () => {
  it('parses a live chart response', () => {
    expect(chartResponseSchema.safeParse(chartReliance).success).toBe(true);
  });

  it('parses the error envelope returned for an unknown symbol', () => {
    const parsed = chartResponseSchema.safeParse(chartUnknown);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.chart.result).toBeNull();
      expect(parsed.data.chart.error).not.toBeNull();
    }
  });

  it('parses a live search response', () => {
    expect(searchResponseSchema.safeParse(searchReliance).success).toBe(true);
  });
});

describe('mapChartResponseToQuote', () => {
  const quote = mapChartResponseToQuote(chartResponseSchema.parse(chartReliance));

  it('strips the provider suffix and resolves the exchange', () => {
    expect(quote?.symbol).toBe('RELIANCE');
    expect(quote?.exchange).toBe('NSE');
  });

  it('derives change as price minus previous close, exactly', () => {
    // Chosen because it is a float-subtraction trap: in native arithmetic
    // 1257.5 - 1274 yields -16.499999999999996.
    expect(quote?.change.toString()).toBe('-16.5');
  });

  it('derives percent change from the same two values it displays', () => {
    const expected = quote!.change
      .dividedBy(quote!.previousClose)
      .times(100)
      .toString();
    expect(quote?.changePercent.toString()).toBe(expected);
  });

  it('interprets regularMarketTime as epoch seconds', () => {
    // The bug this guards against is treating the value as milliseconds, which
    // produces a 1970 date that still renders as a valid timestamp.
    expect(quote?.asOf.getUTCFullYear()).toBeGreaterThan(2000);
  });

  it('returns null rather than throwing when the result set is empty', () => {
    expect(
      mapChartResponseToQuote(chartResponseSchema.parse(chartUnknown)),
    ).toBeNull();
  });

  it('returns a zero percent change instead of NaN on a zero previous close', () => {
    const zeroed = structuredClone(chartReliance);
    // Deliberate fixture surgery: force the divide-by-zero branch.
    (zeroed as any).chart.result[0].meta.chartPreviousClose = 0;

    const parsed = chartResponseSchema.parse(zeroed);
    const result = mapChartResponseToQuote(parsed);

    expect(result?.changePercent.toString()).toBe('0');
    expect(result?.changePercent.isNaN()).toBe(false);
  });
});

describe('mapSearchResponse', () => {
  const results = mapSearchResponse(searchResponseSchema.parse(searchReliance));

  it('returns only instruments on exchanges this app supports', () => {
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(['NSE', 'BSE']).toContain(result.exchange);
    }
  });

  it('never returns a provider-suffixed symbol', () => {
    for (const result of results) {
      expect(result.symbol).not.toContain('.');
    }
  });

  it('drops non-equity instrument types', () => {
    const mapped = mapSearchResponse({
      quotes: [
        { symbol: 'RELIANCE.NS', quoteType: 'EQUITY', longname: 'Reliance' },
        { symbol: 'NIFTY50.NS', quoteType: 'INDEX', longname: 'Nifty 50' },
      ],
    });

    expect(mapped.map((r) => r.symbol)).toEqual(['RELIANCE']);
  });
});

describe('mapChartResponseToCandles', () => {
  it('skips rows where the provider wrote null instead of coercing to zero', () => {
    const parsed = chartResponseSchema.parse({
      chart: {
        error: null,
        result: [
          {
            meta: chartResponseSchema.parse(chartReliance).chart.result![0]!.meta,
            timestamp: [1_700_000_000, 1_700_086_400, 1_700_172_800],
            indicators: {
              quote: [
                {
                  open: [100, null, 102],
                  high: [105, null, 107],
                  low: [99, null, 101],
                  close: [104, null, 106],
                  volume: [1000, null, 1200],
                },
              ],
            },
          },
        ],
      },
    });

    const candles = mapChartResponseToCandles(parsed);

    expect(candles).toHaveLength(2);
    expect(candles.map((c) => c.close.toString())).toEqual(['104', '106']);
  });

  it('strips float32 serialization noise using the provider price hint', () => {
    // The literal below is what Yahoo actually returned for a TCS close that
    // traded at 2200.80 -- caught by running the provider against the live
    // endpoint, not by any fixture.
    const base = chartResponseSchema.parse(chartReliance);
    const parsed = chartResponseSchema.parse({
      chart: {
        error: null,
        result: [
          {
            meta: { ...base.chart.result![0]!.meta, priceHint: 2 },
            timestamp: [1_700_000_000],
            indicators: {
              quote: [
                {
                  open: [2200.800048828125],
                  high: [2215.199951171875],
                  low: [2198.10009765625],
                  close: [2200.800048828125],
                  volume: [1000],
                },
              ],
            },
          },
        ],
      },
    });

    const [candle] = mapChartResponseToCandles(parsed);

    expect(candle?.close.toString()).toBe('2200.8');
    expect(candle?.high.toString()).toBe('2215.2');
    expect(candle?.low.toString()).toBe('2198.1');
  });

  it('returns an empty array when there is no series at all', () => {
    expect(
      mapChartResponseToCandles(chartResponseSchema.parse(chartUnknown)),
    ).toEqual([]);
  });
});
