# Stockfolio

A stock market dashboard (today's movers + search) with a post-login
portfolio tracker for logging trades and viewing FIFO-based gain/loss.

- [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) — architecture, stack, build order
- [`ASSUMPTIONS.md`](./ASSUMPTIONS.md) — every design decision and its trade-offs

## What it does

**Public dashboard** — top gainers, losers and most-active stocks, computed in
application code from a fixed Nifty 50 basket, plus live-as-you-type search and
a stock detail page with six months of history.

**Portfolio tracker** (after login) — log buy/sell trades, see current holdings
with cost basis and market value, and realized vs. unrealized gain/loss kept
separate. Cost accounting is **FIFO**: a sale consumes the oldest lots first and
its realized gain is computed per lot, which is what Indian brokerage and tax
statements report — not a blended average.

## Running locally

Requires Node 20+ and a PostgreSQL database. Postgres is used locally as well as
in deployment ([ASSUMPTIONS.md #33](./ASSUMPTIONS.md)); a free hosted tier such
as [Neon](https://neon.tech) works without installing anything.

```bash
npm install
cp .env.example .env    # then fill in DATABASE_URL and JWT_SECRET
npm run db:init         # creates the schema; safe to re-run
npm run build           # build the frontend, then compile the server
npm start               # one process serving API + UI on :3000
```

For iterative work, run the two dev servers instead — Vite proxies `/api` to the
API process, so the frontend uses the same same-origin paths it will in
production:

```bash
npm run dev:api         # API on :3000
npm run dev:web         # Vite on :5173, proxying /api
```

| Command | Does |
|---|---|
| `npm run db:init` | Create the schema. Idempotent. |
| `npm run build` | Build frontend, then compile the server |
| `npm start` | Run the built app (API + static frontend, one process) |
| `npm test` | Vitest — 140 tests across both workspaces |
| `npm run typecheck` | `tsc --noEmit` across both workspaces |
| `npm run lint` | ESLint, type-aware |
| `npm run verify` | lint + typecheck + test + build — what CI runs |

## Deploying

[`render.yaml`](./render.yaml) is a Render blueprint for the single-process
deployment. It builds, applies the schema, and health-checks `/health` (which
verifies a real database round trip, not just that the process is alive).

1. Create a free Postgres database at [Neon](https://neon.tech) and copy its
   connection string.
2. In Render, **New → Blueprint**, and point it at this repository. It reads
   `render.yaml`.
3. Set `DATABASE_URL` to the Neon connection string. `JWT_SECRET` is generated
   by Render automatically; nothing secret is committed.
4. Deploy. The build runs `db:init`, so a fresh database needs no manual step.

Render's free tier sleeps after inactivity, so the first request after an idle
period takes roughly 50 seconds to wake the process.

## Testing and CI

The pipeline is **ESLint (type-aware) → typecheck → both test suites →
production build**, run by `npm run verify` locally and by
[CI](.github/workflows/ci.yml) on every push and pull request. It needs no
secrets — no test tier touches a real database or network — though it does
supply obvious placeholder values for `DATABASE_URL` and `JWT_SECRET`, because
the env module validates configuration at load and several test files import it
transitively.

Three tiers, no browser E2E ([ASSUMPTIONS.md #31](./ASSUMPTIONS.md)):

- **Tier 1 — pure functions, no mocks.** FIFO lot accounting and the
  backdated-sell check, plus the market data mapper against payloads captured
  from the live provider.
- **Tier 2 — service layer against a fake database** that dispatches on the SQL
  it is handed, so the real transaction, row-locking and idempotency paths are
  exercised rather than a mocked method call.
- **Tier 3 — integration.** Boots the real app with stub dependencies that
  should *never* be called, then sends only invalid requests. A stub being
  reached is itself a failure, which is what proves bad input cannot touch the
  ledger or burn an upstream API call. It authenticates with a genuinely
  signed token — the first version used a placeholder, so every request was
  rejected at auth and the tests would have passed with every Zod schema in the
  app deleted.

Plus component tests for the search dropdown, which use `userEvent` rather than
`fireEvent` so the real pointer sequence (mousedown → blur → mouseup → click)
is exercised.

The FIFO tests are the highest-priority in the repo, because a bug there
produces a wrong *number* rather than a crash. Several were verified by
mutation — deliberately breaking the implementation to confirm the test fails.
The dropdown regression test was written twice for this reason: the first
version passed against the known-broken component, because a synthetic click
completes faster than the race it was meant to catch.

## Notable implementation details

- **Money is never a float.** `NUMERIC(18,4)` columns, `decimal.js` in
  application code, and money values stay strings from the HTTP request all the
  way to the column.
- **Double-submission protection** is a full idempotency-key system: a
  client-generated key, server-side replay of the stored response, `409` on
  key-reuse-with-a-different-body, a row-locked transaction, and a database
  unique constraint as the final backstop.
- **Concurrent writes are serialized** by a `SELECT … FOR UPDATE` on the user's
  portfolio row, so the chronological-sell check always sees a consistent view.
- **Editing or deleting a trade re-validates the whole holding**, because a
  change can invalidate trades it does not touch — reducing an early buy can
  leave a later sell overselling.
- **Market data is treated as untrusted input**, parsed through Zod at one seam,
  with a market-hours-aware cache that serves the last good price when a refresh
  fails rather than failing the page.
