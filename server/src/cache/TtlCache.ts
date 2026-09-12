/**
 * In-process cache with request coalescing and stale-while-revalidate
 * (IMPLEMENTATION_PLAN.md §4.5, ASSUMPTIONS.md #24).
 *
 * Explicitly in-process, not distributed — correct for a single instance; a
 * Redis-backed cache is the upgrade path if this ever runs on more than one.
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
  /** Set when the last refresh attempt failed and this value is being served
   *  past its TTL. */
  stale: boolean;
}

export interface Cached<T> {
  value: T;
  stale: boolean;
}

export class TtlCache {
  readonly #entries = new Map<string, Entry<unknown>>();
  /** In-flight loads, keyed the same way. This is the coalescing: concurrent
   *  callers for one key share a single upstream request instead of each
   *  firing their own — which matters most exactly when it hurts most, a cold
   *  cache with a page loading 50 symbols at once. */
  readonly #inFlight = new Map<string, Promise<unknown>>();

  /**
   * `shouldCache` lets a caller refuse to store a particular result.
   *
   * Needed because not every successful response is worth remembering. An
   * empty search result is far more often a transient upstream hiccup than a
   * real answer, and caching it converts a one-second blip into a TTL-long
   * outage for that exact query — the stock genuinely appears not to exist.
   */
  async get<T>(
    key: string,
    ttlMs: number,
    load: () => Promise<T>,
    options: { shouldCache?: (value: T) => boolean } = {},
  ): Promise<Cached<T>> {
    const entry = this.#entries.get(key) as Entry<T> | undefined;

    if (entry && Date.now() < entry.expiresAt) {
      return { value: entry.value, stale: entry.stale };
    }

    // A caller joining an in-flight load must go through the same failure
    // handling as the one that started it. Awaiting the shared promise
    // directly here used to bypass the stale-while-revalidate catch below, so
    // during an upstream outage the initiating request rendered a stale price
    // while a concurrent one got a hard error — the same page behaving
    // differently on two simultaneous loads.
    const existing = this.#inFlight.get(key) as Promise<T> | undefined;
    if (existing) {
      return this.#settle(key, existing, entry);
    }

    const promise = load()
      .then((value) => {
        if (options.shouldCache?.(value) ?? true) {
          this.#entries.set(key, { value, expiresAt: Date.now() + ttlMs, stale: false });
        }
        return value;
      })
      .finally(() => {
        this.#inFlight.delete(key);
      });

    this.#inFlight.set(key, promise);

    return this.#settle(key, promise, entry);
  }

  /**
   * Awaits a load and applies stale-while-revalidate on failure
   * (ASSUMPTIONS.md #16): a failed refresh serves the last good value rather
   * than propagating the error. This is what backs the "price may be delayed"
   * state and is the main defence against the acknowledged instability of an
   * unofficial data source.
   *
   * Shared by the initiating caller and by every caller that coalesced onto
   * its promise, so all of them see the same behaviour.
   */
  async #settle<T>(
    key: string,
    promise: Promise<T>,
    previous: Entry<T> | undefined,
  ): Promise<Cached<T>> {
    try {
      return { value: await promise, stale: false };
    } catch (error) {
      if (previous) {
        // Extend the stale value's life briefly so a provider outage does not
        // turn into one upstream call per request.
        this.#entries.set(key, {
          value: previous.value,
          expiresAt: Date.now() + 30_000,
          stale: true,
        });
        return { value: previous.value, stale: true };
      }
      // Nothing cached to fall back to; the caller has to handle the failure.
      throw error;
    }
  }

  clear(): void {
    this.#entries.clear();
    this.#inFlight.clear();
  }
}

const OPEN_TTL_MS = 60_000;
const CLOSED_TTL_MS = 30 * 60_000;

/**
 * TTL based on whether NSE is open, computed in `Asia/Kolkata` explicitly so
 * behaviour does not depend on the deploy host's timezone (ASSUMPTIONS.md #24).
 *
 * Simplified from the plan: weekday plus the 09:15–15:30 IST window, with no
 * exchange-holiday calendar. A holiday is therefore treated as an open day and
 * polls at 60s until the TTL cost is noticed — it refetches an unchanging
 * price more often than needed, which is wasteful rather than wrong.
 */
export function quoteTtlMs(now: Date = new Date()): number {
  const ist = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const part = (type: string): string =>
    ist.find((p) => p.type === type)?.value ?? '';

  const weekday = part('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return CLOSED_TTL_MS;

  const minutes = Number(part('hour')) * 60 + Number(part('minute'));
  const open = 9 * 60 + 15;
  const close = 15 * 60 + 30;

  return minutes >= open && minutes <= close ? OPEN_TTL_MS : CLOSED_TTL_MS;
}
