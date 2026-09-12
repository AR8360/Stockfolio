/**
 * Thin fetch wrapper (IMPLEMENTATION_PLAN.md §6).
 *
 * Every response carries `{ data }` or `{ error }`, so this is the one place
 * that unwraps the envelope and turns a failure into a typed throw. Pages then
 * use ordinary try/catch and never inspect status codes.
 */

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const TOKEN_KEY = 'stockfolio.token';

export const tokenStore = {
  get: (): string | null => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      // Private mode or blocked site data — the app still works, the session
      // just does not survive a reload.
      return null;
    }
  },
  set: (token: string): void => {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* ignore */
    }
  },
  clear: (): void => {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
  },
};

export interface RequestOptions {
  // `| undefined` on each: the shared tsconfig sets exactOptionalPropertyTypes,
  // so an explicitly-passed `undefined` is not the same as an absent property.
  // Callers build these objects conditionally, so both must be allowed.
  method?: string | undefined;
  body?: unknown;
  /** Passed through from a page's AbortController so an in-flight request is
   *  actually cancelled on unmount or on the next keystroke, not merely
   *  ignored when it lands. */
  signal?: AbortSignal | undefined;
  headers?: Record<string, string> | undefined;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const token = tokenStore.get();

  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      signal: options.signal ?? null,
      headers: {
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch (error) {
    // An aborted request is not a failure to report — it is the caller having
    // moved on — so it is rethrown untouched for the caller to ignore.
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'NETWORK', 'Could not reach the server. Check your connection.');
  }

  if (response.status === 204) return undefined as T;

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(response.status, 'BAD_RESPONSE', 'The server returned an unreadable response.');
  }

  const envelope = payload as { data?: T; error?: { code: string; message: string; details?: unknown } };

  if (envelope.error) {
    throw new ApiError(response.status, envelope.error.code, envelope.error.message, envelope.error.details);
  }
  if (!response.ok) {
    throw new ApiError(response.status, 'UNKNOWN', 'Something went wrong.');
  }

  return envelope.data as T;
}

/* ------------------------------- types -------------------------------- */

export interface User { id: string; email: string; name: string; createdAt: string }
export interface AuthResult { user: User; token: string }

export interface Mover {
  symbol: string; exchange: string; name: string;
  price: string; change: string; changePercent: string; volume: number;
}
export interface Overview {
  gainers: Mover[]; losers: Mover[]; mostActive: Mover[];
  sampled: number; asOf: string | null;
}
export interface SearchHit { symbol: string; exchange: string; name: string }
export interface Quote {
  symbol: string; exchange: string; name: string; currency: string;
  price: string; previousClose: string; change: string; changePercent: string;
  volume: number; asOf: string;
}
export interface Holding {
  symbol: string; exchange: string; name: string; currency: string;
  quantity: string; averageCost: string; costBasis: string;
  currentPrice: string | null; marketValue: string | null;
  unrealizedGain: string | null; unrealizedGainPercent: string | null;
  realizedGain: string; priceStale: boolean;
}
export interface Summary {
  costBasis: string; marketValue: string | null; unrealizedGain: string | null;
  realizedGain: string; totalGain: string | null; holdingCount: number; pricesStale: boolean;
}
export interface Transaction {
  id: string; symbol: string; exchange: string; name?: string;
  type: 'BUY' | 'SELL'; quantity: string; price: string; fees: string;
  currency: string; txnDate: string; createdAt: string;
}
