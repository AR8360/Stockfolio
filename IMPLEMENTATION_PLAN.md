# Stockfolio — Implementation Plan

A stock market dashboard with a public "today's movers + search" home page, and a
post-login portfolio tracker for manually logging buy/sell trades and viewing
computed gain/loss.

This document describes the architecture and build order. `ASSUMPTIONS.md`
covers every design decision and its trade-offs in detail — this doc assumes
those decisions and focuses on how they get built.

---

## 1. Scope

**In scope:**
- Public dashboard: today's top gainers / losers / most active (NSE), stock search, stock detail page
- Auth: email + password signup/login
- Portfolio tracker: record buy/sell trades, view current holdings, realized + unrealized gain/loss, FIFO-based cost accounting
- Deployed, working demo on a free host

**Explicitly out of scope** (see ASSUMPTIONS.md for reasoning):
- News feed
- Watchlists (stocks saved without owning)
- Multiple portfolios per user
- Cash balance tracking
- US/global markets on the live dashboard (portfolio schema supports it; not wired up)
- Email verification / password reset
- Browser-level E2E tests

---

## 2. Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript, strict mode, both frontend and backend |
| Backend | Node.js + Express |
| Frontend | React (Vite) |
| Database | PostgreSQL (SQLite locally if simpler — see §7) |
| Validation | Zod, at every route boundary and every external API boundary |
| Money/decimal math | A decimal library (e.g. `decimal.js`) — never native `number` for money |
| Auth | JWT (stateless, 7-day expiry) + bcrypt |
| Market data | Yahoo Finance unofficial endpoints, `.NS` suffix for NSE tickers |
| Deployment | Single Node process (monolith) — Express serves the built frontend + the API |

**Why TypeScript strict + a decimal library, together:** this is a money app. A
silently-`any`-typed value or a native-float rounding error is the costliest
class of bug here — it doesn't crash, it just produces a wrong gain/loss
number that looks plausible. Both are cheap to adopt from the start and
expensive to retrofit.

**Why monolith:** one deploy, one thing that can go down, no CORS/env-var
mismatch between two hosted services. Correct trade-off for a 1–2 day demo;
see ASSUMPTIONS.md for the split-deployment alternative considered.

---

## 3. Database schema

```
users
  id, email (unique, lowercase-enforced), password_hash, name, created_at

portfolios
  id, user_id (fk), name, created_at
  -- one portfolio auto-created per user at registration;
  -- schema supports more, UI/API only ever uses one

instruments
  id, symbol, exchange, name, updated_at
  UNIQUE (symbol, exchange)
  -- local cache of external stock metadata, upserted on every trade touching a stock
  -- decouples the ledger from live provider data

transactions
  id, portfolio_id (fk), instrument_id (fk), type (BUY|SELL),
  quantity NUMERIC(18,4), price NUMERIC(18,4), fees NUMERIC(18,4) DEFAULT 0,
  currency, txn_date, client_request_id (uuid), request_hash (char(64)), created_at
  CHECK (quantity > 0), CHECK (price > 0), CHECK (fees >= 0)
  UNIQUE (portfolio_id, client_request_id)   -- idempotency backstop

idempotency_keys
  user_id, key (uuid), request_hash (char(64)), response_body (jsonb), created_at
  UNIQUE (user_id, key)
```

**Indexing:**
- `transactions(portfolio_id, instrument_id, txn_date, created_at, id)` — matches
  the exact ordering FIFO replay needs, so the DB serves it without a sort step
- `idempotency_keys(created_at)` — supports a future cleanup job (not built; noted as a gap)

**Migration approach:** a single idempotent SQL file (`CREATE TABLE IF NOT EXISTS`),
run via a setup script. No migration framework — appropriate for one developer,
one environment. See ASSUMPTIONS.md for when this would need to change.

---

## 4. Backend architecture

```
routes/      → HTTP only: parse request, validate with Zod, call a service, respond
services/    → business logic: auth, transactions, portfolio calculation, dashboard
database/    → connection pool, transaction helpers
providers/   → external market-data API client, isolated behind an interface
```

**Rule:** a layer only imports from the layer directly below it. Routes never
touch the DB driver directly. Services never touch Express's `Request`/`Response`.
This is what makes services independently unit-testable without booting the app.

### 4.1 Provider isolation

The Yahoo Finance client sits behind a `MarketDataService` interface. Every
response is parsed through a Zod schema before entering the app — an external
API is untrusted input, same as a form submission. If Yahoo changes a field
name or shape, this turns a silent bad value into a caught, typed error at
one seam, instead of a crash three layers deeper in the FIFO calculator.

Build order: capture real API responses first, write Zod schemas against the
actual shape (not documentation), then the HTTP client, then the
provider→app type mapper, then wire into `MarketDataService`.

### 4.2 Error handling

One `AppError` class (`{code, status, details?}`). A single Express error
middleware normalizes three sources — explicit `AppError` throws, `ZodError`s
(reshaped via `.flatten().fieldErrors`), and generic/malformed-request errors
— into one response shape: `{ error: { code, message, details? } }`. Routes
just `throw`; no per-route try/catch. Only 5xx gets logged as an error.

Write this before the first real route — every route is then written against
an error contract that already exists.

### 4.3 Money correctness and concurrency (the core hard logic)

Built last, because it depends on schema, error handling, and the provider
adapter already being stable.

**FIFO position and gain/loss** (`calculateFifoPosition`):
- Pure function: takes the full ordered trade history for one holding, returns
  current quantity, cost basis of remaining shares (oldest lots first),
  realized gain (per sale, against the specific lots consumed), unrealized
  gain (remaining lots vs. current price)
- On a SELL, consume from the oldest lot(s) first; a sell spanning multiple
  lots produces a realized gain computed per-lot, summed
- Written and unit-tested in complete isolation before being wired into
  either the write path (validating a sell) or the read path (computing
  the dashboard) — same function, two call sites, not two implementations

**Chronological / backdated-sell validation** (`assertChronologicalSell`):
- A SELL must not be valid today but retroactively make some *later* date's
  running balance negative (relevant because trades aren't necessarily
  entered in date order)
- Algorithm: build a map of net daily quantity deltas, sort by date, single
  forward scan tracking (a) quantity available on the transaction date and
  (b) the minimum running quantity from that date onward. Valid only if both
  are ≥ requested quantity.
- Computed in application code (not SQL) — the per-holding ledger is small
  (bounded by one user's trade count for one stock), and this keeps the logic
  unit-testable in isolation without a live DB

**Idempotency (double-submission protection):**
1. Client generates a UUID once per logical submission attempt (lazily, right
   before the request fires — not on form-open), sent as an `Idempotency-Key`
   header. Regenerated only when the user changes a field; kept the same
   across a failed/retried submission.
2. Server: cheap outside-transaction check — does `(user_id, key)` exist in
   `idempotency_keys`? If yes and request-body hash matches → replay the
   stored response, no new write.
3. If the key exists but the body hash differs → `409 IDEMPOTENCY_KEY_REUSED`.
4. The full check-then-insert sequence runs inside one DB transaction with
   `SELECT ... FOR UPDATE` on the idempotency row, closing the race window
   between two near-simultaneous requests with the same key.
5. `UNIQUE (portfolio_id, client_request_id)` on `transactions` as the final backstop.

**Concurrency locking on the ledger:**
- `SELECT id FROM portfolios WHERE user_id = $1 FOR UPDATE` at the start of
  every write transaction — serializes all writes to one user's portfolio, so
  the chronological-sell check always sees a consistent view. Cheap to add
  since the idempotency transaction is already open at this point.

**Money type discipline:**
- `NUMERIC(18,4)` columns, never `FLOAT`/`DOUBLE`, for quantity/price/fees
- All arithmetic in application code goes through a decimal library, never
  native `number` — division explicitly returns `0` rather than `NaN`/`Infinity`
  on a divide-by-zero (e.g. a holding with zero total cost)

### 4.4 Authentication

JWT (stateless, 7-day expiry) + bcrypt password hashing. No sessions store —
appropriate for a single backend instance with no revocation requirement at
this stage (documented trade-off in ASSUMPTIONS.md).

**Timing-attack resistance:** on login, if the email isn't found, still run
`bcrypt.compare` against a precomputed dummy hash (computed once at module
load, not per-request) before returning "Invalid email or password." Without
this, response-time difference between "email not found" and "email found,
wrong password" leaks which emails are registered.

Build order: `AuthService` (register/login/getCurrentUser) as pure,
unit-testable service methods first, then the thin route wrapper, then
`authenticate` middleware — kept deliberately dumb (verifies JWT, attaches
`request.userId`, no DB call) so every downstream route decides for itself
whether it needs to re-fetch the user.

### 4.5 Caching

- In-process cache with request coalescing (concurrent callers for the same
  key share one in-flight promise, not duplicate upstream calls)
- Stale-while-revalidate: if a refetch fails, return the last good cached
  value marked `stale: true` rather than propagating an error — this is what
  backs the dashboard's "price may be delayed" fallback state
- Market-hours-aware TTL: ~60s while NSE is open (9:15–15:30 IST, weekdays),
  hours-long otherwise, computed against `Asia/Kolkata` explicitly (not
  server local time, since the deploy host's timezone shouldn't matter)

### 4.6 Rate limiting

Shared limiter on public routes; a tighter, dedicated limiter on `/api/stocks/search`
specifically — it's the cheapest endpoint to call repeatedly (autocomplete-style
usage naturally fires many requests) and the most likely path to exhaust the
upstream free-tier quota.

---

## 5. API surface

| Route | Auth | Notes |
|---|---|---|
| `GET /health` | none | checks real DB connectivity, not just process-alive |
| `POST /api/auth/register`, `/login` | none | |
| `GET /api/stocks/overview` | none | today's gainers/losers/most-active, computed from a fixed NSE basket |
| `GET /api/stocks/search` | none | tighter rate limit |
| `GET /api/stocks/:exchange/:symbol[/history]` | none | |
| `GET /api/portfolio/holdings`, `/summary` | required | realized + unrealized split |
| `POST /api/portfolio/transactions` | required | idempotency-key protected |
| `PATCH/DELETE /api/portfolio/transactions/:id` | required | edit/delete for user corrections |

**Response envelope, consistent everywhere:** `{ data: {...} }` on success,
`{ error: { code, message, details? } }` on failure. Every route validates
`body`/`query`/`params` through a Zod schema — `.strict()`, rejecting unknown
fields rather than silently dropping them — before any service call.

**"Today's movers" data source:** Yahoo's unofficial endpoints don't expose a
ready-made "movers" list for NSE, so: maintain a fixed basket of Nifty 50
constituents, fetch quotes for all of them, compute top 5 gainers / losers /
most-active by volume in application code.

---

## 6. Frontend

Build order: API client + auth context first (every page depends on both),
then layout/routing shell, then read-only pages (home, stock detail), then
search, then the write-path portfolio pages last (highest stakes, built once
every underlying pattern is proven).

- **`api/client.ts`** — thin fetch wrapper, throws a typed `ApiError` whenever
  the response envelope's `error` key is present
- **Auth context** — token persistence, current-user state, route guard
- **State management:** no global store (Redux/Zustand). Each page owns its
  own fetch/loading/error state via hooks, with `AbortController` cleanup on
  unmount. Explicit per-page state machine — `loading | error | empty | stale | success`
  — rather than one boolean, so the UI can distinguish "still loading" from
  "loaded, nothing here" from "loaded, but this might be stale."
- **Search:** live-as-you-type. 300ms debounce, `AbortController` cancellation
  on every keystroke (so an irrelevant in-flight request is actually cancelled,
  not just ignored), and — time permitting — a monotonic sequence guard so a
  slow, non-aborted stale response can't overwrite a newer result.
- **Trade form idempotency key:** generated lazily via
  `idempotencyKey.current ??= crypto.randomUUID()` right before submission,
  invalidated only on field change — not on a failed submit, so a retry after
  a network blip correctly reuses the key.
- **Submit-button guard:** disabled while a request is in flight, in addition
  to the full idempotency system — belt-and-suspenders against double-clicks.

**Empty state:** new user with no trades sees a prompt to add their first
trade, not a blank table.

---

## 7. Local development

- `.env.example` documenting required variables: `DATABASE_URL`, `JWT_SECRET`,
  `STOCK_API_*` (if a key is needed), `CORS_ORIGIN`
- Environment parsed and validated once at boot (fails fast on a missing/malformed
  var, rather than failing confusingly on the first request that needs it)
- `pnpm install && pnpm db:init && pnpm dev` (or npm-equivalent) — single
  command to get running locally, documented in the repo README
- SQLite for local dev if it meaningfully simplifies onboarding; Postgres for
  deployment. If schema portability between the two becomes friction, use
  Postgres locally too (e.g. via Docker) instead — decide during setup, note
  the choice in ASSUMPTIONS.md.

---

## 8. Testing (no E2E)

**Tier 1 — pure functions, no mocks:**
- `calculateFifoPosition`: simple buy-then-sell, partial sell across multiple
  lots, backdated sell that would make a future date negative, sell exceeding
  holdings (rejected), sell exactly exhausting a lot boundary
- Return/XIRR calculation, against a known textbook case

**Tier 2 — service layer, fake DB (not a mocked method call):**
- Transaction service: idempotency replay path, `409` on key-reuse-with-different-body,
  the portfolio row lock. A lightweight fake `Pool`/`PoolClient` that responds
  based on the actual SQL being executed, so the test exercises the real
  transaction/locking code path.

**Tier 3 — integration:**
- Boot the real app with stub DB/market-data dependencies that should *never*
  be called; confirm bad input (missing auth, malformed decimal, non-positive
  price, future-dated trade) is rejected by validation before reaching either
  dependency. A stub method being called is itself a test failure.

**Not built:** browser-level E2E (Playwright/Cypress) — low ROI for a
single-developer project relative to the three tiers above.

---

## 9. Deployment

- Single Node process (Express serves API + built frontend static files)
- Free host: Render (or equivalent) for the process, a free Postgres tier
  (e.g. Neon) if SQLite's persistence on the host isn't reliable across restarts
- `GET /health` used as the platform's health check, verifying real DB connectivity
- Environment variables set in the host's dashboard, validated at boot

---

## 10. Known gaps (deliberately out of scope, not oversights)

See ASSUMPTIONS.md for full reasoning on each:
- No email verification / password reset
- No JWT revocation before expiry
- No idempotency-key cleanup job (index anticipates it, job not built)
- Single portfolio per user only (schema supports more)
- No US/global market data live (portfolio schema supports it)
- No E2E test suite
- No rate-limit cleanup/distributed store (in-process only — fine for one instance)
