# Assumptions & Trade-offs

Every deliberate design decision made while scoping and planning Stockfolio,
with the reasoning and the alternative considered. Organized roughly in the
order these decisions came up.

---

## Product scope

**1. Market coverage: NSE/BSE only, live.**
Indian markets are what's personally relevant and tradeable via the chosen
data source. US markets have better free-API support, but supporting both on
the *live dashboard* roughly doubles integration surface (two data sources,
two currencies, two market-hours windows, disambiguated search) for a feature
that's read-only. The portfolio tracker's schema and trade-entry flow *do*
support recording trades in either market/currency — only the live
gainers/losers/search dashboard is India-only. Adding US market data later is
additive (a new `MarketDataProvider` implementation), not a rewrite, because
the data-fetching layer is abstracted behind an interface for exactly this
reason.

**2. Cost-basis method: FIFO, not average cost.**
FIFO (sell the oldest lot first) matches how Indian tax/brokerage statements
actually compute realized gains, and produces a correct per-sale realized
gain on partial sells. Average cost is simpler to implement (one blended
number per holding) but gives a *different*, less accurate number on partial
sells — acceptable for a casual tracker, not accurate for anything
tax-adjacent. FIFO was chosen deliberately despite the extra implementation
cost (an ordered lot queue, chronological-sell validation) because
correctness here is a real differentiator, not just polish.

**3. Trade granularity: date only, no intraday time.**
FIFO lot accounting only needs day-level ordering; intraday execution time
adds no accounting value.

**4. Realized vs. unrealized gain/loss shown separately, plus a total.**
A single combined "gain/loss" number is ambiguous — realized gain is locked
in (from closed positions), unrealized is a paper gain that moves with the
current price. Showing both separately is a correctness/clarity requirement
for a portfolio tracker, not a nice-to-have.

**5. Fully-sold positions drop from the "current holdings" view** but remain
visible in trade history and continue to contribute to realized gain/loss.

**6. Explicitly out of scope:** news feed, watchlists, multiple portfolios
per user, cash-balance tracking, email verification, password reset. Each
was excluded to keep the build focused on the two features actually asked
for (dashboard + portfolio tracker) rather than replicating a full platform
like Moneycontrol.

**7. Whole-share quantities only** — no fractional shares, matching how NSE
actually trades.

**8. Trades are editable and deletable** by the user. A strictly append-only
ledger is the more "pure" accounting model, but not being able to fix a
typo'd price is bad UX with no real benefit for a personal tracker (not a
tax/audit tool).

**9. Ticker validation at trade entry:** a trade is only accepted if the
ticker resolves to a real quote from the market-data provider, reusing the
same lookup logic as search. Prevents garbage tickers from silently breaking
portfolio valuation later.

**10. New user with no trades sees a "log your first trade" prompt**, not a
blank table.

**11. Desktop-first, reasonably responsive but not a design priority.** This
is being evaluated as an architecture/code exercise, not a UI/UX one; time
went into backend correctness instead of breakpoints.

---

## Data source

**12. Yahoo Finance's unofficial endpoints, `.NS` suffix for NSE tickers.**
No official support or SLA, and technically against Yahoo's terms of service
for programmatic/scaled use — a real risk, accepted deliberately for this
build. The alternative, NSE's own public endpoints, is official but
aggressively rate-limits and blocks non-browser-like requests (session
cookies, specific headers, frequent failures from server/cloud IPs) — a
genuine reliability risk for a hosted backend on a tight timeline. A
production version of this product would need a licensed data vendor, not a
scraped/unofficial source.

**13. "Today's movers" computed in application code, not fetched as a
ready-made list.** Yahoo's unofficial endpoints don't expose a
gainers/losers/most-active endpoint for NSE, so the app maintains a fixed
basket of Nifty 50 constituents, fetches quotes for all of them, and computes
the top 5 in each category itself. A real exchange-provided movers feed would
be more accurate and wouldn't need a fixed, potentially-stale basket.

**14. Provider responses validated through a schema (Zod) at the boundary,
before entering the rest of the app.** An external API is untrusted input in
the same sense a user's form submission is. Isolating provider quirks behind
one adapter file means a schema change or a known bug (e.g., a symbol the
provider's own search returns but its detail endpoint fails to resolve) is
fixed in one place, not special-cased throughout the app.

**15. Prices reflect last-traded price, fetched live on every page load, no
persistent caching beyond a short in-process TTL.** During market hours this
is close to live (subject to provider delay); after hours it's the day's
close, which is correct behavior, not a bug, since the price genuinely
cannot move while the market is closed.

**16. On a failed live fetch, the app serves the last successfully cached
price for that key, labeled as possibly delayed, rather than an error or
blank field.** Backed by the in-process cache's stale-while-revalidate
behavior. Protects the demo against the acknowledged instability of the
unofficial data source (assumption 12).

---

## Architecture

**17. Monolith deployment — one Node process serves both the API and the
built frontend.** The alternative (frontend and backend as separate hosted
services) is more representative of how larger teams deploy, and forces CORS
configuration to be correct from day one rather than deferred — a real
argument in its favor. It was set aside for this build specifically because
of the timeline: it doubles the deploy surface (two services, two sets of
environment variables, cross-origin configuration) for a single-developer,
1–2 day demo where that realism doesn't pay for itself. Splitting later is a
deployment change, not an application-code rewrite.

**18. Backend: Node.js + Express, not a framework that abstracts the backend
away (e.g. Next.js API routes).** Chosen specifically because the target
company's stack includes Node — an explicit Express layer (routes, middleware,
auth, error handling all hand-wired) demonstrates backend fundamentals more
directly than a framework that handles routing/serving implicitly.

**19. TypeScript, strict mode, across both frontend and backend.** A
financial app is exactly where a silently-`any`-typed value corrupting a
decimal is most costly. Adopted as a cheap, high-value addition to the stack
rather than a scope trade-off.

**20. Money values (quantity, price, fees, and all derived gain/loss
figures) are stored as `NUMERIC` in the database and computed through a
decimal library in application code — never native `number`/`float`.**
Floating-point arithmetic is not acceptable for money; this isn't a
stylistic choice; it's close to a correctness requirement once gain/loss is
being computed and compared.

**21. Single `AppError` class + one central Express error-handling
middleware**, normalizing explicit throws, validation errors, and generic
errors into one JSON response shape. Adopted because it strictly reduces
total code (no per-route try/catch) rather than adding scope — routes just
throw and the middleware handles translation and logging (only 5xx logged as
an actual error; 4xx is expected traffic).

**22. Full idempotency-key system for trade submission**, not just a
disabled-submit-button guard: client-generated key per logical submission,
server-side replay of the stored response on a genuine retry, a `409` on
key-reuse-with-a-different-body, wrapped in a database transaction with a row
lock closing the race window, and a database unique constraint as the final
backstop. This is materially more build effort than the frontend-only
alternative (which only guards against a UI double-click) — chosen
deliberately for correctness and to demonstrate the full pattern, not because
the simpler version was insufficient for the actual demo's traffic pattern.

**23. Row-level locking on the portfolio (`SELECT ... FOR UPDATE`) at the
start of every write transaction**, serializing writes to one user's
portfolio so concurrent buy/sell requests can't both read a stale ledger
state and both write inconsistently. Built alongside the idempotency
transaction (assumption 22), since the transaction wrapper already exists at
that point — a comparatively cheap addition once idempotency is committed to.

**24. Market-hours-aware in-process caching**, TTL ~60 seconds while NSE is
open, hours-long while closed, computed against `Asia/Kolkata` explicitly
(not server local time, so behavior doesn't depend on the deploy host's
timezone). Reduces live API calls, backs the stale-price fallback
(assumption 16), and protects the free-tier data source's rate limits.
Explicitly in-process, not distributed — correct for a single instance; a
Redis-backed cache would be the production upgrade path if this ever ran on
multiple instances.

**25. Rate limiting on public routes**, tighter specifically on the search
endpoint. Search is the cheapest endpoint to call repeatedly (autocomplete
usage naturally fires many requests) and the most likely path to exhaust the
upstream provider's quota.

**26. JWT-based auth (stateless, 7-day expiry) + bcrypt, not server-side
sessions.** No infrastructure (session store) needed for a single backend
instance. Trade-off accepted: no way to revoke a token before it expires.
Acceptable for a personal portfolio tracker; would need to change (e.g.
short-lived token + refresh-token pattern) for anything handling real money
movement or needing "log out everywhere."

**27. Timing-attack-resistant login:** on an unrecognized email, the code
still runs a `bcrypt.compare` against a precomputed dummy hash (computed once
at startup, not per request) before responding "Invalid email or password" —
so response time doesn't leak whether an email is registered. Small, cheap,
adopted outright as standard practice.

**28. No global frontend state store (Redux/Zustand).** Each page owns its
own fetch/loading/error state; an explicit per-page state machine
(`loading | error | empty | stale | success`) rather than one boolean, so the
UI can distinguish "still loading" from "loaded, nothing here" from "loaded,
but possibly stale." A global store would add indirection with no problem to
solve at this app's size — the one genuinely cross-cutting piece of state
(auth) is scoped to its own context instead.

**29. Live-as-you-type search**, not explicit submit-to-search. Requires
debounce (300ms) and request cancellation (`AbortController`) as a minimum,
with a monotonic sequence guard (protecting against a slow, non-aborted stale
response overwriting a newer result) as a nice-to-have if time allows. Chosen
over the simpler explicit-submit alternative because it's consistent with
the level of engineering rigor applied elsewhere in this build, and it's the
more polished-feeling experience in a live review.

**30. `/health` checks actual database connectivity**, not just that the
process is running — meaningful on a host where the process can be up while
the DB pool hasn't finished connecting or the DB is temporarily unreachable.

**31. Testing: three tiers, no browser-level E2E.** Pure-function tests
(FIFO calculation, return/XIRR) with no mocks; service-layer tests against a
fake database that responds based on actual SQL executed (not a mocked
method call), specifically covering the idempotency-replay and
concurrency-locking logic; integration tests proving bad input is rejected
by validation before reaching the database or market-data layer at all. E2E
(Playwright/Cypress) was considered and excluded — for a single-developer
project, the three tiers above catch the money-correctness bugs that matter
more cheaply than an E2E suite would, which mostly catches UI-wiring issues
that manual testing during development already surfaces.

**32. No formal migration framework** — a single idempotent SQL setup script
instead. Appropriate for one developer, one environment. Would need to
change (e.g. to a proper migration tool with rollback/versioning) the moment
a second developer or a second environment (staging) enters the picture.

---

## Known gaps — acknowledged, not accidental

- **No idempotency-key cleanup job.** The `idempotency_keys(created_at)`
  index anticipates one (a scheduled deletion of old records), but it isn't
  implemented.
- **Single portfolio per user**, even though the schema (`portfolios` as a
  child table of `users`, not folded flat) already supports more — exposing
  multiple portfolios in the UI/API is a natural extension, not a schema
  change.
- **No JWT revocation before natural expiry.**
- **No distributed rate-limit store** — in-process only, correct for one
  instance, would need a shared store (e.g. Redis) across multiple instances.
- **US/global market data not wired up on the live dashboard**, though the
  portfolio tracker's data model already supports recording trades in
  multiple currencies/markets.
