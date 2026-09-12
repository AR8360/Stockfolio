import { describe, expect, it } from 'vitest';

import { TtlCache } from './TtlCache.js';

/** Tier 1: pure, no network, no clock manipulation beyond real short TTLs. */

describe('TtlCache', () => {
  it('serves a cached value within the TTL without calling the loader again', async () => {
    const cache = new TtlCache();
    let calls = 0;
    const load = async () => {
      calls += 1;
      return 'v';
    };

    await cache.get('k', 60_000, load);
    await cache.get('k', 60_000, load);

    expect(calls).toBe(1);
  });

  it('coalesces concurrent loads for the same key into one upstream call', async () => {
    // The property that makes a 50-symbol dashboard affordable: without it, a
    // cold cache fires one upstream request per concurrent caller.
    const cache = new TtlCache();
    let calls = 0;
    const load = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return 'v';
    };

    const results = await Promise.all([
      cache.get('k', 60_000, load),
      cache.get('k', 60_000, load),
      cache.get('k', 60_000, load),
    ]);

    expect(calls).toBe(1);
    expect(results.map((r) => r.value)).toEqual(['v', 'v', 'v']);
  });

  it('serves the last good value, marked stale, when a refresh fails', async () => {
    const cache = new TtlCache();
    let attempt = 0;
    const load = async () => {
      attempt += 1;
      if (attempt === 1) return 'good';
      throw new Error('upstream down');
    };

    await cache.get('k', 1, load);
    await new Promise((r) => setTimeout(r, 10)); // let the entry expire

    const second = await cache.get('k', 1, load);

    expect(second.value).toBe('good');
    expect(second.stale).toBe(true);
  });

  it('propagates the failure when there is nothing cached to fall back to', async () => {
    const cache = new TtlCache();
    await expect(
      cache.get('k', 60_000, async () => {
        throw new Error('upstream down');
      }),
    ).rejects.toThrow('upstream down');
  });

  it('does not store a result the caller refuses via shouldCache', async () => {
    // Regression: an empty search result was cached as authoritative, so one
    // transient upstream hiccup made a stock appear not to exist for the whole
    // TTL. Yahoo really does intermittently return only foreign listings for a
    // query that normally has NSE/BSE ones, which the mapper filters to [].
    const cache = new TtlCache();
    const responses = [[] as string[], ['INFY']];
    let calls = 0;
    const load = async () => {
      calls += 1;
      return responses[Math.min(calls - 1, responses.length - 1)]!;
    };
    const shouldCache = (v: string[]) => v.length > 0;

    const first = await cache.get('search:infosys', 60_000, load, { shouldCache });
    expect(first.value).toEqual([]);

    // The empty result must not have been stored, so this refetches.
    const second = await cache.get('search:infosys', 60_000, load, { shouldCache });
    expect(second.value).toEqual(['INFY']);
    expect(calls).toBe(2);

    // The non-empty result is cached normally.
    await cache.get('search:infosys', 60_000, load, { shouldCache });
    expect(calls).toBe(2);
  });
});
