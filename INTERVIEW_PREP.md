# Stockfolio — how it works, and what went wrong building it

This is a walkthrough of the hard parts of this project, written so you can
explain them out loud. Every number in here is a real number from this
codebase — from its test suite, from live runs against the deployed database,
or from the actual bug reports. Nothing is a textbook example.

Each section starts with the plain-language version and then goes into detail.
If you only read the plain parts, you will still be able to answer "what does
this do and why".

---

## 1. FIFO cost-basis accounting

### The plain version

When you sell shares, you need to know **what those particular shares cost you**,
so you can say how much you made. That sounds obvious until you have bought the
same stock more than once at different prices.

Buy one share at ₹10. Buy another at ₹12. Now sell one for ₹15.

**Which one did you sell?**

There is no physical answer — shares are fungible, you did not sell a specific
piece of paper. So it is an accounting convention, and you have to pick one:

- **FIFO** ("first in, first out"): you sold the oldest share, the ₹10 one.
- **Average cost**: you blend them into one price of ₹11 and sell at that.

These give **different answers**, and that difference is the whole point.

| | FIFO | Average cost |
|---|---|---|
| Cost of the share sold | ₹10 | ₹11 |
| Realized gain on the sale | **+₹5** | +₹4 |
| Cost basis of the share still held | **₹12** | ₹11 |

This project uses FIFO, because that is what Indian brokerage and tax statements
report — so the number this app shows matches the number the user's broker
shows. Average cost is less code (one blended number per holding instead of a
queue of lots) and quietly disagrees with their contract note.

### The real sequence, run live against the deployed app

Every figure below was produced by the deployed application and read back from
its own API. Nothing here is illustrative.

**Step 1 — buy 1 share at ₹10, then 1 more at ₹12.**

```
qty 2 | avgCost 11 | costBasis 22 | realized 0
```

Two shares, ₹22 invested. Note the average cost is ₹11 — that figure is real
and useful to display, but it is *not* what the app uses to compute gains.

**Step 2 — sell 1 share at ₹15.**

```
qty 1 | avgCost 12 | costBasis 12 | realized 5
```

This single line is the proof that the app is doing FIFO:

- **Realized gain is ₹5**, not ₹4. It sold the ₹10 share, the oldest one.
- **The remaining share's cost basis is ₹12**, not ₹11. The expensive share is
  what is left.

If this were average-cost accounting, both numbers would differ — ₹4 realized
and ₹11 remaining. So a single two-buy, one-sell sequence is enough to
demonstrate which method is in use, which makes it a good thing to show someone.

**Step 3 — sell the remaining share, also at ₹15.**

```
holdings: []          ← position closed, gone from the table
realized: 8           ← cumulative
```

The second sale consumed the ₹12 share, so it realized ₹3. Added to the first
sale's ₹5, cumulative realized gain is **₹8**.

The holdings table is now empty, but the ₹8 has not vanished — a fully-sold
position leaves the holdings view and keeps contributing to realized gain.
Otherwise selling everything would make your profit disappear from the screen,
which would be alarming and wrong.

**Step 4 — try to sell one more.**

```json
{
  "error": {
    "code": "INSUFFICIENT_HOLDINGS",
    "message": "Only 0 shares were held on 2026-09-12; cannot sell 1",
    "details": {
      "reason": "NOT_HELD_ON_DATE",
      "date": "2026-09-12",
      "available": "0",
      "requested": "1"
    }
  }
}
```

Rejected, with the date and the actual available quantity, before anything is
written.

### Why *that* error message, and not the other one

Worth knowing, because there are **two** different insufficient-holdings errors
in this codebase and it is a fair question why this one fired.

The other message — `Cannot sell 1 shares: 1 more than held on 2026-09-12` —
comes from the FIFO calculator itself, when it replays the ledger and runs out
of lots mid-sale. It is the last line of defence.

The one that actually fires comes from a separate check that runs **first**,
before the trade is inserted. That check exists for a subtler problem than
"you have nothing left" — see below — and because it runs first, it produces the
better message: it knows the balance on that specific date, so it can say
*"only 0 shares were held"* rather than *"you are 1 short"*.

Both are real. The calculator's version is what you would see if the earlier
check were ever bypassed.

### The subtler problem: selling backwards in time

Trades are not necessarily entered in date order — the app lets you record a
trade you forgot, or fix one you typed wrong. That creates a validation problem
that a naive "do you have enough right now" check misses entirely:

```
Jan 10   BUY  100
Mar 10   SELL 100     ← already recorded; balance is now 0
Feb 10   SELL  50     ← being added now
```

On 10 February the user genuinely held 100 shares, so the sale looks fine on its
own date. But the 10 March sale already disposed of all of them, so accepting
this leaves the ledger at **−50 shares from March onward**.

The check has to look *forward* from the sell's date, not just at it. It
collapses the ledger into a net change per day, walks the days in order once,
and requires that the running balance never dips below the quantity being sold
at any point from that date on.

### Where fees go

The ₹10/₹12/₹15 sequence has no fees, so here is the convention on a larger
trade that does — also run live:

- **Buy fees are added to the lot's cost.** You paid them to acquire the shares.
- **Sell fees are subtracted from proceeds.** You paid them to dispose of them.

```
BUY  20 TCS @ 2,100, fees 35
SELL  8 TCS @ 2,400, fees 12
```

| Step | Working | Result |
|---|---|---|
| Lot cost | (20 × 2,100) + 35 | **42,035** |
| Cost per share | 42,035 ÷ 20 | **2,101.75** |
| Sale proceeds | (8 × 2,400) − 12 | **19,188** |
| Cost of the 8 sold | 42,035 × 8/20 | **16,814** |
| **Realized gain** | 19,188 − 16,814 | **+2,374** |
| Remaining 12 shares' cost | 42,035 − 16,814 | **25,221** |
| Market value @ 2,200.80 | 12 × 2,200.80 | **26,409.60** |
| **Unrealized gain** | 26,409.60 − 25,221 | **+1,188.60** |
| **Total gain** | 2,374 + 1,188.60 | **+3,562.60** |

When a lot is only partly sold, its fee goes with it proportionally — which is
why the cost of the 8 shares is 16,814 and not 16,800.

### Realized vs unrealized — why they are never merged

- **Realized** gain is locked in. You sold; the money is real.
- **Unrealized** gain is on paper. It moves with the price, and you have not
  actually got it.

A single combined "gain" number is ambiguous, so the app always shows both plus
a total. In the ₹10/₹12/₹15 sequence, after the first sale the summary read:

```
costBasis 12 | unrealizedGain 2188.8 | realizedGain 5 | totalGain 2193.8
```

The unrealized figure is large because the ledger says one share at a cost of
₹12 while the live market price of the symbol used for the test was ₹2,200.80.
That is the app being *correct* — it values what you hold at what it is worth
today, regardless of the toy price the share was booked at.

### Why money is never a floating-point number

In most languages `0.1 + 0.2` does not equal `0.3`; it equals
`0.30000000000000004`. That is not a language bug — it is how binary
floating-point works. It is fine for physics and fatal for money.

This project never uses native numbers for money. Values are strings in the HTTP
request, `NUMERIC(18,4)` in the database, and a decimal library in between.
There is a test asserting three lots of `0.1` total exactly `0.3`.

A concrete trap from the test suite: `1257.5 − 1274` in native floating point
gives `-16.499999999999996`. The app reports `-16.5`.

---

## 2. The idempotency system

### The plain version

A user clicks "Add trade". The request goes to the server, the server saves it —
and then the network drops before the reply gets back. The user sees a spinner
that never resolves, so they click again.

Have they now bought the shares twice?

In a naive system, yes. The first request succeeded; the user just never heard
about it. The second request looks like a completely new, valid trade.

**Idempotency** means: doing the same thing twice has the same effect as doing
it once. The mechanism is a unique ID attached to the *attempt*, so the server
can recognise a repeat and say "I already did that, here is the answer I gave
you last time" instead of doing it again.

### The five layers, and why each one alone is not enough

**Layer 1 — the client generates a key.** Before submitting, the browser makes
a UUID and sends it as an `Idempotency-Key` header.

Two details matter more than they look:

- It is generated **lazily**, right before the first submit — not when the form
  opens. A key created on form-open would be stale if the user sat there editing.
- It is **not regenerated when a submit fails.** This is the whole point. A
  failed submit might be a request that actually succeeded and whose reply was
  lost. Reusing the key is what makes the retry safe. It is only thrown away
  when a form field changes, because that makes it a genuinely different request.

*Not sufficient alone:* the client can't stop two browser tabs, and a client is
untrusted anyway.

**Layer 2 — the server replays.** The server keeps a table of keys it has seen,
with the response it sent. A repeat key means: return the stored response, write
nothing. The user gets the same trade back, not a second one.

*Not sufficient alone:* it is a check-then-act. Two simultaneous requests can
both check, both find nothing, and both proceed.

**Layer 3 —409 on a mismatch.** The stored row also holds a SHA-256 hash of the
request body. Same key, *same* body is a genuine retry → replay it. Same key,
*different* body is a client bug → reject with `409`, because replaying the old
response would silently discard the trade the user thinks they just made.

The hash is computed over key-sorted fields, so a client that serializes its
JSON in a different order on retry is not wrongly accused of changing the body.

*Not sufficient alone:* still doesn't solve the simultaneous-request race.

**Layer 4 — the row-locked transaction.** The whole check-then-write sequence
runs inside one database transaction that starts by taking a lock (see §3). The
key row is claimed *before* the work is done, so a concurrent request carrying
the same key has something to block on.

*Not sufficient alone — and this is the subtle bit worth knowing:* `SELECT …
FOR UPDATE` can only lock a row that **already exists**. For the very first use
of a brand-new key there is no row to lock, so two simultaneous first-requests
can both read "no key found". That specific gap is closed by the portfolio lock
(which always has a row) and by layer 5.

**Layer 5 — the database constraint.** `UNIQUE (portfolio_id,
client_request_id)` on the transactions table, and `PRIMARY KEY (user_id, key)`
on the idempotency table. If everything above somehow fails, the database
rejects the duplicate write itself.

This is the only layer that holds even when the application logic is wrong,
because it does not depend on the application logic being right.

### The line to remember

> The three mechanisms are layered, not redundant — each one covers a window the
> others leave open.

There is also a plain disabled submit button while a request is in flight. That
guards against a double-click and nothing else; it is the belt alongside the
braces, not a substitute.

### How it was tested

Against a fake database that responds based on **the actual SQL it is handed**,
not a mock that just records method calls. That distinction matters: it means
the test exercises the real transaction, the real lock ordering and the real
rollback, so a change that breaks any of them fails the test. Tests assert,
among other things, that a genuine retry does not even open a transaction
(it is answered by a cheap pre-check), and that a failed trade rolls back the
claimed key so the user *can* retry.

---

## 3. Concurrency locking — a different problem

### The plain version

Idempotency answers "is this the same request twice?"

Locking answers a different question: **"what if two genuinely different
requests arrive at the same instant?"**

Concretely: a user has 100 shares. They submit a sell of 60 and a sell of 60 at
the same moment from two tabs. Both requests read the ledger, both see 100
shares available, both conclude their sell is valid, both write. The user has
now sold 120 shares they never owned.

These are *different* requests, so idempotency does not help — it would
correctly treat them as two distinct trades.

### The fix

Every write transaction begins with:

```sql
SELECT id FROM portfolios WHERE user_id = $1 FOR UPDATE
```

`FOR UPDATE` locks that row. The second request **blocks** on that line until
the first transaction commits — and by the time it proceeds, it reads a ledger
that already includes the first sale, so its own validation correctly rejects it.

This serializes all writes to one user's ledger. Different users never contend,
so it costs nothing in normal use.

### How it was verified — and what that revealed

This was not assumed. Two database clients were made to contend for the same
portfolio row against the **real deployed database**:

```
B blocked while A held the lock: true  (2,059ms, code 57014)
B acquired the lock after A committed: true  (121ms)
```

The `57014` is a deliberate 2-second statement timeout firing — that is how
"blocked" was turned into something observable rather than a hang. Then A
committed and B got through in 121ms.

**The constraint this revealed:** the database is Neon, and the connection
string points at its *pooled* endpoint — PgBouncer in **transaction pooling
mode**. In that mode a server connection is pinned to a client only for the
duration of one transaction.

So the lock works, but only because every lock here is taken and released
inside a single explicit transaction. Session-scoped things are **not**
available: advisory locks held across transactions, `LISTEN`/`NOTIFY`, named
prepared statements.

That is worth saying out loud in an interview, because it is the difference
between "I used a lock" and "I know what my lock actually depends on". A future
change that reached for a session-level lock would fail intermittently and only
under concurrency — the worst way to find out.

---

## 4. Mutation testing — the tests that were lying

### The plain version

A passing test suite tells you the tests pass. It does **not** tell you the
tests would notice if the code broke.

**Mutation testing** checks that: you deliberately break the implementation and
confirm a test fails. If everything still passes, the test was decorative.

### The specific case in this project

The FIFO calculator has a rule that looks like a micro-optimisation:

> When a sale consumes a lot **completely**, charge it the lot's exact remaining
> cost, rather than recomputing the cost proportionally.

Three mutations were tried against the FIFO test suite:

| Mutation | Caught? |
|---|---|
| Remove the defensive sort (trust the caller's ordering) | **Yes** — 4 tests failed |
| Stop adding buy fees into the lot cost | **Yes** — 4 tests failed |
| **Remove the full-consumption exactness rule** | **No — all 26 tests passed** |

So that rule had **zero real coverage**. It could have been deleted and nothing
would have noticed.

### Finding out whether the rule mattered at all

The honest next question is not "how do I write a test" but "does this rule
actually do anything?" A search over 11,200 combinations of lot cost and
quantity found **2,250 that diverge** — cases where `cost × qty ÷ qty` does not
return `cost`, because the intermediate needs more digits than the available
precision.

Then a search for a case reachable through the *normal* FIFO flow found one:

```
BUY  3 shares @ 33.33, fees 1     (total cost 100.99, unit cost repeats)
SELL 1
SELL 2                            ← closes the lot
```

| | Value charged to the closing sale |
|---|---|
| With the exactness rule | `67.32666666666666666666666666666667` |
| Without it | `67.326666666666666666666666666666` **65** |

A sliver of cost — about 1e-32 — destroyed as the lot is dropped. There is now a
test pinning that exact value, and it was **verified to fail** when the rule is
removed.

### The honest footnote

The original code comment claimed those residues would "accumulate". They do
not — each lot is closed exactly once, so the error cannot compound. The comment
was corrected to say what is actually true: the rule costs one comparison and
makes "a closed lot has contributed exactly its cost" true **by construction
rather than by arithmetic luck**.

### A related finding: perfect conservation is impossible

You would like this invariant to hold exactly:

> cost consumed by sales + cost remaining in open lots = cost of everything bought

It does not, and cannot, at unlimited precision. Per-lot allocation is exact,
but the *running total* across lots eventually needs a 35th significant digit
and gets rounded. The residue lands around **1e-31** — twenty-seven orders of
magnitude below the 4 decimal places ever stored or displayed.

So the test asserts conservation **at money scale, plus a hard 1e-20 bound**.
That still fails loudly on a real accounting bug — a dropped lot or a
double-counted fee moves the total by whole rupees, not by 1e-31.

Knowing the difference between "precision noise" and "a bug" is the actual
skill here.

---

## 5. Every real bug in this project, in the order found

### 1. The market data provider's batch endpoint had been taken away

**What:** the plan assumed one batch call to Yahoo's `/v7/finance/quote` to fetch
all 50 index constituents for the "today's movers" dashboard. That endpoint now
returns **401 Unauthorized** — Yahoo moved it behind a cookie/token handshake.

**How found:** the build order says to write the response schemas against
payloads *captured from the live endpoint*, not from documentation. Doing that
literally meant hitting the endpoint on day one and getting a 401.

**Fix:** switched to `/v8/finance/chart`, still unauthenticated, whose metadata
block happens to carry everything the movers calculation needs. Cost: one
request per symbol instead of one per basket — about 50 upstream calls per cache
miss.

**Why the alternative was rejected:** implementing the handshake to keep using
the batch endpoint would be working around a deliberate access control, and it
is the part most likely to be changed again — failing as a 401 in production
rather than at build time.

**What it demonstrates:** the provider abstraction paying for itself. The change
was confined to one adapter file; the interface the rest of the app uses did not
move. It also made the cache **load-bearing** rather than an optimisation.

### 2. Historical prices arrived with fake precision

**What:** a TCS closing price that really traded at `2200.80` came back from the
provider as `2200.800048828125` — the provider serializes historical prices at
32-bit float precision.

**How found:** running the provider against the live API rather than only
against saved fixtures. The saved fixtures did not show it, because only the
*historical* series carries the artefact — the current-price fields are clean.

**Fix:** the provider's own `priceHint` field (value `2` for Indian equities)
states the real precision, and values are rounded to it at the boundary, using
banker's rounding since these get aggregated. Verified live: `last close 2200.8`.

**Why it mattered:** it never touches cost basis (that comes from user-entered
prices), but it would have rendered as a nonsense price and put fake precision
into the valuation path.

### 3. Deploy-only bug: the frontend was invisible in production

**What:** the server locates the built frontend relative to its own file. That
path is correct when running from source (`server/src`) and **wrong** after
compilation (`server/dist/src`), where it resolved to a directory that does not
exist.

**How found:** booting the *production build* locally rather than trusting that
development-mode success would carry over.

**Symptom it would have caused:** the deployed app would serve the API perfectly
and return a JSON 404 for **every single page**. Invisible until deploy.

**Fix:** search upward for the built frontend instead of assuming a fixed depth.

### 4. Deploy-only bug: the database setup script could not find its own schema

**What:** the TypeScript compiler compiles `.ts` files and copies nothing else,
so `schema.sql` does not exist in the compiled output. The setup script resolved
a path that only works when run from source.

**How found:** running the exact deploy sequence — `npm ci`, build, `db:init` —
in a clean clone before deploying.

**Why it mattered most:** `db:init` is what creates the tables. This would have
failed on the very first deploy, at the step everything else depends on.

**Fix:** search upward for the file; verified working from both layouts.

### 5. Clicking a search result did nothing

**What:** the search dropdown showed correct results, and clicking one silently
did nothing.

**The mechanism:** a click is three events — `mousedown`, then `mouseup`, then
`click`. Pressing down on a result **blurred the search input**, the blur handler
closed the dropdown, and the link was removed from the page before `mouseup`
arrived. The click landed on nothing.

The original code tried to paper over this by delaying the close by 150ms. That
made the bug **timing-dependent instead of fixing it**. Measured:

| 100ms after blur | list still present |
|---|---|
| **160ms after blur** | **list gone** |

Any press held longer than 150ms missed — which is ordinary for a deliberate
click.

**Why it survived testing:** an automated click completes in about a
millisecond, so it never hit the race. It passed every check before shipping.

**Fix:** cancel the blur on `mousedown`, so the input never loses focus. No
window to miss and no timer to tune. Verified with a press held 800ms, and with
a real browser click.

### 6. One search term returned nothing for five minutes

**What:** found while verifying bug 5 — searching "infosys" returned no results,
while "reliance" and "tcs" worked.

**The cause, in two parts.** The provider intermittently returns only foreign
listings for a query that normally has Indian ones (the US listing plus two
European lines, and no NSE/BSE entries). The mapper correctly filters those out,
because they are not tradeable here — leaving an empty result. **And then the
app cached that empty result as authoritative for five minutes**, turning a
one-second upstream blip into a sustained "this stock does not exist".

**Diagnostic honesty:** the first diagnosis was "it's the cache". Then a fresh
server with an empty cache *still* returned zero, which revealed the upstream
flakiness underneath. Both were real; the cache was amplifying the other.

**Fix:** never cache an empty search result. Retrying costs one upstream call on
a query that found nothing; caching it costs a search that visibly does not
work. The upstream was then sampled 12 times and returned Indian listings every
time — confirming the blip is *rare*, which is exactly what made caching it
dangerous.

### 7. Editing a trade returned a server error instead of a validation error

*(First of four found by a dedicated code-review pass.)*

**What:** creating a trade with a fractional quantity on an Indian exchange
returns a clean `400`. **Editing** an existing trade to the same value returned
`500`.

**Why:** the whole-share rule is enforced in three places for creates — a schema
refinement, a service check, and a database constraint. The update schema had
none of them, and *could not*: the exchange is not editable, so it is not in the
request body, and the rule depends on the exchange. The value reached the
database, tripped the constraint, and the error handler did not recognise that
error class, so it fell through to a generic 500.

**How found:** reading the create and update schemas side by side, then
confirming against the running API rather than assuming.

**Fix:** the service checks whole shares against the *stored* exchange, which it
has and the schema does not. Separately, the error middleware now maps database
constraint violations to `400` as a backstop, so no constraint violation can
surface as a 500 again.

### 8. Two simultaneous page loads behaved differently during an outage

**What:** the cache merges concurrent requests for the same symbol into one
upstream call. But the request that *joined* an existing call skipped the
failure handling that serves the last known price when the provider is down.

**The symptom:** during an outage, the request that started the fetch showed a
stale-but-labelled price and rendered fine; a simultaneous request for the same
symbol got a hard error. The same page, two loads a millisecond apart, different
outcomes.

**Fix:** both paths now share one handler.

### 9. A stock that was up 5% was listed as a top loser

**What:** "top gainers" took the first five of a sorted list and "top losers"
took the last five — of the same list. Those overlap whenever fewer than ten
stocks resolve, and with five or fewer, **every** stock appears in both lists.

**Why it was reachable:** the dashboard deliberately drops constituents that
fail to fetch rather than failing the whole page. So a degraded upstream renders
a *short list* — which is precisely when the display goes wrong.

**Fix:** split the sorted list at its midpoint before taking each end, so the
lists can never share an entry. Verified live: 48 stocks sampled, zero overlap.

### 10. A build artifact was committed to the repository

**What:** TypeScript's incremental-build cache file was tracked in git, swept in
by a directory-wide `git add`. It changes on every build, so it produces
spurious diffs and merge conflicts, and it embeds absolute paths from the
machine that generated it.

**Fix:** untracked and gitignored.

### Bugs that were in the *tests*, not the code

Worth mentioning separately, because they are the more interesting ones:

- **The test suite silently doubled.** A production build left compiled copies of
  every test in the output directory and the runner collected both trees — 204
  tests reported where there were 102. Worse than the miscount: the stale copies
  would keep passing after their source changed.

- **The integration tests tested nothing.** They authenticated with a placeholder
  string as the token, so every request was rejected at the authentication layer
  before any validation ran. The assertions checked that the stubs went
  untouched — which they did, for entirely the wrong reason. **Those tests would
  have passed with every validation schema in the app deleted.** Fixed by signing
  a genuine token, so requests get past auth and validation is actually the thing
  under test.

- **The regression test for bug 5 did not catch bug 5.** The first version passed
  against the known-broken component — for the identical reason the original bug
  survived review: an automated click completes faster than the 150ms race
  window. Fixed by holding the simulated press for 300ms, and confirmed to fail
  when the fix is reverted.

Three of this project's problems share one root cause: **an automated check that
completes faster than the condition it is supposed to observe.** That is the
single most transferable lesson in this repo.

---

## 6. Questions you are likely to be asked

**"Why FIFO and not average cost?"** Because it matches what Indian brokerage
and tax statements report, so the number the app shows matches the user's
broker. Average cost is less code and gives a different, less accurate figure on
partial sales. Concretely: 650 versus 600 on the example in §1.

**"Isn't a full idempotency system overkill for a demo?"** Yes, for the traffic
this demo will see. It was chosen to demonstrate the complete pattern, and that
is an honest answer. The simpler alternative — a disabled submit button — only
guards against a double-click; it does nothing about a lost response, which is
the failure that actually duplicates a trade.

**"What happens if the market data provider goes down?"** The portfolio still
works completely: quantities, cost basis and realized gain all come from the
user's own ledger, not from the provider. Only market value and unrealized gain
go blank, and the affected rows are flagged as delayed. A failed refresh serves
the last known price rather than an error.

**"How do you know the locking actually works?"** Because it was tested against
the real deployed database, not assumed — see §3, including the pooler
constraint that test revealed.

**"What would you do differently with more time?"** In order: a background job
to clean up old idempotency keys (the index anticipates it, the job is not
built); a shared cache and rate-limit store so the app can run on more than one
instance; a proper migration tool instead of a single idempotent setup script;
and a structured logger instead of console output.

**"What is the weakest part of this codebase?"** The frontend has far less test
coverage than the backend, and the one bug that reached production was a
frontend bug. There is now a component test for that specific regression, but
the ratio is still lopsided — deliberately, because the money-correctness logic
is where a silent wrong answer costs the most.
