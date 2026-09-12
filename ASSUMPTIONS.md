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

*Implementation note.* Because `txn_date` is the primary FIFO sort key, a
one-day shift silently reorders the ledger and changes which lot a sale
consumes — a wrong realized gain with no error anywhere. Two defences: the
driver is configured to return `DATE` columns as plain `YYYY-MM-DD` strings
rather than JS `Date`s at *local* midnight (which invents a timezone a DATE
column does not have), and the domain formats day keys with UTC getters.

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

*Amended during schema implementation.* Originally this was to be enforced only
by Zod at the route boundary, on the grounds that a blanket database CHECK
would bake an Indian-market rule into a ledger meant to carry US trades later
(assumption #1). That reasoning was right about the blanket version and wrong
about the conclusion: every other money rule in this schema (`quantity > 0`,
`price > 0`, `fees >= 0`) is enforced at both layers, and singling this one out
for application-only enforcement is inconsistent without being safer.

It is now a conditional CHECK — integral quantity required when the exchange is
NSE or BSE, unconstrained otherwise — so the rule is market-specific rather
than global, and admitting a fractional-share market later is an additive edit
instead of a constraint drop plus table rewrite.

This required one structural change: a Postgres CHECK cannot reference another
table, and `exchange` lives on `instruments`. So `transactions` now carries a
denormalized `exchange` column. The usual drift risk from denormalizing is
closed by a composite foreign key — `(instrument_id, exchange)` references
`(id, exchange)` on `instruments` — which makes a disagreeing row impossible to
insert rather than merely discouraged. Cost is one redundant unique constraint
on `instruments (id, exchange)` to serve as the FK target.

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

*Amended during provider implementation.* The plan assumed this would be one
batch call to `/v7/finance/quote` for the whole basket. That endpoint now
returns **401 Unauthorized** — Yahoo moved it behind a crumb/cookie handshake.
Verified against the live endpoint, not inferred.

The replacement is `/v8/finance/chart`, which is still unauthenticated and
whose `meta` block happens to carry everything the movers calculation needs
(`regularMarketPrice`, `regularMarketVolume`, `chartPreviousClose`). The cost
is one request per symbol instead of one per basket — roughly 50 upstream calls
per cache miss for a Nifty 50 basket. That is affordable only because of the
market-hours-aware cache with request coalescing (#24), which turns it into 50
calls per TTL window rather than per page load; it makes that cache
load-bearing rather than merely an optimization.

The alternative considered was implementing the crumb/cookie handshake to keep
using the batch endpoint. Rejected: it is a deliberate access control, so
working around it is both more hostile to the provider than simply using a
public endpoint and more fragile — it is the part most likely to be changed
again, and it would fail as a 401 in production rather than at build time.

This is the abstraction in #14 paying for itself: the change was confined to
one adapter, and the `MarketDataService` interface did not move.

**13a. Provider prices are quantized at the boundary to the instrument's own
quoted precision.** Yahoo serializes chart OHLC at float32 precision, so a
close that traded at 2200.80 arrives as `2200.800048828125`. The `meta.priceHint`
field (2 for INR equities) states the real precision, and values are rounded to
it in the mapper, using banker's rounding since these figures get aggregated.
Found by running the provider against the live API — the captured fixtures did
not show it, because the quote-level fields are already clean and only the
historical series carries the artefact. This never touches cost basis (which
comes from user-entered prices), but it would have rendered as a nonsense price
and would have put fake precision into the valuation path.

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

*Precision fixed during FIFO implementation.* Decimal precision is set to **34
significant digits** (IEEE decimal128) rather than the library default of 20.
Inputs are `NUMERIC(18,4)` and need at most 22; the headroom is for division,
since allocating a lot's cost across a partial sale produces a repeating
decimal that is then multiplied and summed across lots.

One consequence is worth stating rather than discovering later: **exact cost
conservation is not attainable at unbounded precision.** When a lot's unit cost
repeats, the per-lot allocation stays exact (`taken + remaining == total` holds
for every individual lot), but the *running total* across lots eventually needs
one more digit than the precision allows and is rounded. The residue lands
around 1e-31 — 27 orders of magnitude below the 4 decimal places ever stored or
displayed. The test asserts conservation at money scale plus a hard 1e-20
bound, which still fails loudly on a real accounting bug (a dropped lot or a
double-counted fee moves the total by whole currency units).

**20a. Trade fees: capitalized on the buy, deducted on the sell.** The plan
specifies a `fees` column but not its accounting treatment. A buy's fees are
added to the lot's cost and carried proportionally as that lot is consumed, so
the fee is recovered across exactly the sales that dispose of those shares; a
sell's fees are deducted from proceeds. The effect is that realized gain
reflects what the round trip actually cost, which is the figure a user
reconciles against a contract note — rather than a gross figure with the fees
accounted for somewhere else, or not at all.

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

*Verified against the deployed database, not assumed.* The connection string
points at Neon's **pooled** endpoint, which is PgBouncer in transaction-pooling
mode — a mode that does not support every Postgres feature, so `FOR UPDATE`
working here was worth proving before building on it. Two concurrent clients
were made to contend for the same portfolio row: the second blocked while the
first held the lock (hitting a deliberate 2s `statement_timeout` rather than
acquiring it), then took the lock in 121ms once the first committed.

The constraint this places on §4.3: every lock must be taken and released
inside a single explicit transaction, because transaction pooling pins a server
connection only for the duration of one transaction. Session-scoped state
(advisory locks held across transactions, `LISTEN`/`NOTIFY`, named prepared
statements) is not available. The plan's design already works this way, so
nothing needs to change — but a future addition reaching for a session-level
lock would fail intermittently and only under concurrency, which is the worst
way to find out.

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

*Measured, not assumed.* A single-shot comparison against the live database
showed a 2.0x difference (638ms known vs 319ms unknown), which looks exactly
like the leak this defence is meant to close. It was first-call warmup —
connection setup and JIT — landing entirely on whichever path ran first.
Re-measured warmed up, with 12 interleaved samples alternating which path goes
first: **median 335.3ms known vs 328.3ms unknown, a ratio of 1.021x**, with the
observed ranges fully overlapping (321–349 vs 319–356). Indistinguishable.

Two things worth keeping from that: a single timing sample cannot tell a real
leak from warmup, so this property needs interleaved medians to be checked at
all; and the unit test guarding it asserts a lower bound on the unknown-email
path rather than a ratio between the two, precisely because a ratio computed
from few samples is dominated by that noise. The test was verified to fail
(0ms vs the 50ms floor) when the dummy comparison is removed — and notably,
the test asserting that both paths return an identical response still passed
under that mutation, so the timing assertion is the only thing covering it.

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

**33. PostgreSQL for local development too, not SQLite.** IMPLEMENTATION_PLAN.md
§7 deliberately left this open ("SQLite locally if it meaningfully simplifies
onboarding... decide during setup"). Decided at setup: Postgres in both places.

SQLite has no `SELECT ... FOR UPDATE` (its locking is whole-database, not
row-level), no `JSONB`, and — most quietly dangerous — no real `NUMERIC` type;
`NUMERIC(18,4)` there is a type *affinity* that falls back to storing an IEEE
float. So the three things this build exists to demonstrate — decimal-exact
money (#20), the row-locked write transaction (#23), and the idempotency
system built on top of it (#22) — are precisely the things SQLite cannot model
faithfully. Choosing it locally would mean the code paths most worth being
confident about are the only ones never exercised during development, and the
divergence would surface as a wrong number in production rather than an error.
That is the "schema portability becomes friction" case §7 anticipated.

Cost of the decision: a contributor needs a Postgres instance before
`npm run db:init` does anything. Mitigated by the fact that a free hosted tier
(Neon) satisfies it with a connection string and no local install — so the
onboarding step SQLite was meant to remove is a signup, not a database
administration task.

---

## Bugs found by the code-review pass

These four were found by a dedicated review of the whole implementation diff,
after the app was already deployed and working. None was caught by the test
suite at the time, which is the point of recording them: each one shows a
category of mistake the existing tests could not see.

**34. `PATCH` on a trade returned 500 where `POST` returned 400.**
*What broke:* the whole-share rule (#7) is enforced by a Zod refinement on the
create schema, a service check, and a database CHECK. The **update** schema had
none of them. `updateTransactionSchema` cannot express the rule, because the
exchange is not editable and so is absent from a PATCH body, and the rule is
exchange-specific. A fractional quantity therefore passed validation, reached
the database, tripped `transactions_whole_shares_on_indian_exchanges`, and
surfaced as Postgres error 23514 — which the error middleware did not
recognise, so it fell through to the generic 500 branch.

*Why it mattered:* a user correcting their own typo got a server error, and it
was logged at error level as a 5xx incident rather than as expected 4xx traffic.

*How it was found:* reading the create and update schemas side by side during
review and noticing the asymmetry, then confirming it against the running API
rather than assuming.

*Fix:* the service now checks whole shares against the *stored* exchange, which
it has and the schema does not. Separately the error middleware maps Postgres
constraint violations (23514 CHECK, 23503 foreign key, 23502 NOT NULL) to 400,
so no constraint violation can ever surface as a 500 again. Unique violations
(23505) are deliberately excluded — those carry per-table meaning and are
already translated by the services that can say what they mean.

*Verified:* `POST` and `PATCH` with `quantity: "1.5"` on an NSE trade both now
return 400 with a field-level message, against the live database.

**35. Concurrent cache callers bypassed stale-while-revalidate.**
*What broke:* `TtlCache` coalesces concurrent loads for one key onto a single
upstream call (#24). The caller that *joined* an in-flight load awaited the
shared promise directly, outside the `try/catch` that implements the stale
fallback (#16).

*Why it mattered:* during an upstream outage the request that initiated the
load was served the last good price marked stale and rendered normally, while a
simultaneous request for the same symbol got a hard 502 — the same page
behaving differently on two loads a millisecond apart, in exactly the situation
the stale fallback exists to smooth over.

*How it was found:* review, by following the two paths through the cache and
noticing only one of them was wrapped in the failure handling.

*Fix:* both paths now go through one shared `#settle` step, so the initiating
caller and every coalesced caller get identical behaviour.

*Verified:* by the existing cache tests covering coalescing and the stale
fallback, which now exercise the shared path.

**36. Dashboard gainers and losers overlapped on a short basket.**
*What broke:* `gainers` took `slice(0, 5)` and `losers` took `slice(-5)` of the
same sorted array. Those overlap whenever fewer than ten quotes resolve, and
with five or fewer, *every* stock appears in both lists — so a stock up 5% is
displayed as a top loser.

*Why it mattered:* this is reachable in normal operation, not a hypothetical.
`getQuotes` deliberately drops failed constituents rather than failing the
basket (#16), so a degraded upstream renders a short list rather than an
error — which is precisely when the display would be wrong.

*How it was found:* review, then confirmed by simulating the ranking on a
three-quote basket.

*Fix:* the sorted list is split at its midpoint before each end is taken, so
the two lists can never share an entry.

*Verified:* live, against the real dashboard — 48 constituents sampled, zero
overlap between the two lists.

**37. A build artifact was committed.**
*What broke:* `web/tsconfig.tsbuildinfo`, TypeScript's incremental-build cache,
was tracked in git. It was swept in by a directory-wide `git add web` when the
frontend was first committed.

*Why it mattered:* it changes on every typecheck, so it shows as modified after
any build and produces spurious diffs and merge conflicts; it also embeds
absolute paths from the machine that generated it.

*How it was found:* review of the diff's file list rather than its content.

*Fix:* untracked, and `*.tsbuildinfo` added to `.gitignore`.

---

## Tooling adopted after the first deploy

**38. ESLint, type-aware.** There were four `eslint-disable` comments in the
repo and no ESLint installed, so they suppressed nothing — a detail a reviewer
notices. Type-aware rules were chosen deliberately over a syntax-only config:
`no-floating-promises`, `no-misused-promises` and the unsafe-`any` family all
require type information, and those are the mistakes that produce a silently
swallowed error or a wrong number rather than a crash.

It found real problems on its first run: a floating `navigate()` in the header
and in the login flow, where react-router v7 returns a promise whose rejection
would have been silent; and `async` submit handlers passed straight to
`onSubmit`, where React expects a void return, so a rejection escaping them
would surface as an unhandled rejection rather than a handled error. Build-tool
configs sit outside both tsconfig projects and are linted for syntax only
rather than excluded, so a genuine mistake in them is still caught.

**39. CI on every push.** `.github/workflows/ci.yml` runs lint, typecheck, both
test suites and a production build. It needs **no secrets**, which is a
consequence of the testing design rather than a convenience: Tier 1 is pure,
Tier 2 uses a fake driver, Tier 3 stubs its dependencies, and the frontend runs
in happy-dom, so no tier touches a real database or network. The build step is
included specifically to catch build-layout breakage — the class of bug that
only appears in a compiled tree and would otherwise be discovered on the deploy
after merge, which is exactly how the two deploy-only bugs were found.

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
- **`sslmode=require` in `DATABASE_URL` will change meaning on the next major
  `pg` upgrade.** The driver currently treats `prefer`/`require`/`verify-ca` as
  aliases for `verify-full`, and warns on every connection that pg v9 will
  adopt standard libpq semantics — under which `require` encrypts but does
  *not* verify the server certificate, silently weakening the connection. The
  fix is one word in the connection string (`sslmode=verify-full`), but it
  belongs with the pg upgrade rather than before it, since doing it now pins
  behaviour the current driver already gives. Minor future-maintenance item,
  noted so the warning is not mistaken for noise later.
- **No distributed rate-limit store** — in-process only, correct for one
  instance, would need a shared store (e.g. Redis) across multiple instances.
- **US/global market data not wired up on the live dashboard**, though the
  portfolio tracker's data model already supports recording trades in
  multiple currencies/markets.
