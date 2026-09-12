# Stockfolio

A stock market dashboard (today's movers + search) with a post-login
portfolio tracker for logging trades and viewing FIFO-based gain/loss.

- [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) — architecture, stack, build order
- [`ASSUMPTIONS.md`](./ASSUMPTIONS.md) — every design decision and its trade-offs

## Status

Implementation in progress. Done so far: repo scaffold, database schema (§3),
error handling (§4.2), market data provider (§4.1), auth service and
middleware (§4.4), and the pure FIFO / chronological-sell core (§4.3).
Next: the idempotent write path that wires them into a service, then API
routes (§5).

## Running locally

Requires Node 20+ and a PostgreSQL database. Postgres is used locally as well
as in deployment ([ASSUMPTIONS.md #33](./ASSUMPTIONS.md)); a free hosted tier
such as [Neon](https://neon.tech) works without installing anything locally.

```bash
npm install
cp .env.example .env    # then fill in DATABASE_URL and JWT_SECRET
npm run db:init         # applies server/src/database/schema.sql (safe to re-run)
```

| Command | Does |
|---|---|
| `npm run db:init` | Create the schema. Idempotent. |
| `npm run typecheck` | `tsc --noEmit` across the workspace |
| `npm test` | Vitest |
