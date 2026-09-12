import { upstreamUnavailable } from '../../errors/AppError.js';

/**
 * Minimal HTTP client for Yahoo's unofficial endpoints
 * (IMPLEMENTATION_PLAN.md §4.1).
 *
 * Its entire job is: make the request, enforce a timeout, hand back parsed
 * JSON or throw a typed error. It deliberately knows nothing about quotes,
 * symbols or schemas -- that separation is what lets the mapper and schemas be
 * tested against fixtures without stubbing `fetch`.
 */

/** Yahoo returns 403 to requests that do not look like a browser. This is the
 *  "technically against their terms of service" part of ASSUMPTIONS.md #12,
 *  stated plainly rather than buried: the product accepts that risk knowingly
 *  for a demo, and a production build would use a licensed vendor instead. */
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const DEFAULT_TIMEOUT_MS = 8_000;

export interface YahooClientOptions {
  timeoutMs?: number;
  /** Injectable for tests -- a fake here is how the provider gets exercised
   *  without network access, per the "stub that should never be called"
   *  integration approach in §8. */
  fetchImpl?: typeof fetch;
}

export class YahooHttpClient {
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: YahooClientOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  /**
   * Returns the parsed body as `unknown` -- never a typed value. Handing back
   * `unknown` forces every caller through a Zod schema before use, which is
   * the boundary rule (ASSUMPTIONS.md #14) expressed as a type rather than as
   * a convention someone has to remember.
   *
   * `allowErrorStatus` exists because Yahoo signals "no such symbol" with a
   * 404 whose *body* carries the real detail. For those calls the status is
   * not the outcome, so the body must be parsed rather than thrown away.
   */
  async getJson(
    url: string,
    options: { allowErrorStatus?: boolean } = {},
  ): Promise<unknown> {
    // AbortSignal.timeout rather than a manual setTimeout + clearTimeout: it
    // cannot leak a pending timer if the request settles first.
    let response: Response;
    try {
      response = await this.#fetch(url, {
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: {
          'User-Agent': BROWSER_USER_AGENT,
          Accept: 'application/json',
        },
      });
    } catch (cause) {
      // Network failure, DNS failure or timeout. Collapsed into one typed
      // error because no caller can act differently on the distinction, and
      // the cache's stale-while-revalidate path (§4.5) treats them alike.
      throw upstreamUnavailable(
        cause instanceof Error && cause.name === 'TimeoutError'
          ? 'Market data request timed out'
          : 'Could not reach the market data provider',
      );
    }

    if (!response.ok && options.allowErrorStatus !== true) {
      throw upstreamUnavailable(
        `Market data provider returned ${String(response.status)}`,
      );
    }

    try {
      return await response.json();
    } catch {
      // A non-JSON body on a 200 usually means an interstitial or a block
      // page. Reported as upstream-unavailable rather than an internal error:
      // it is the provider misbehaving, not this application.
      throw upstreamUnavailable(
        'Market data provider returned an unreadable response',
      );
    }
  }
}
