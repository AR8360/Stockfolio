# Instructions for Claude Code

This repo is implemented from `IMPLEMENTATION_PLAN.md` and `ASSUMPTIONS.md`.
Read both fully before writing any code — every architectural decision,
including the ones that look like extra effort (FIFO lot accounting, full
idempotency-key system, row-level locking, three-tier testing), was chosen
deliberately and is explained in ASSUMPTIONS.md. Do not simplify or skip
these without flagging it first.

## Build order

Follow the section order in IMPLEMENTATION_PLAN.md:
1. Schema (§3)
2. Backend layering: routes → services → database → providers (§4), in that
   internal order: provider isolation and error-handling middleware first
   (§4.1–4.2, they're dependencies for everything else), then auth (§4.4),
   then the FIFO/idempotency/concurrency logic (§4.3) last, since it depends
   on the rest being stable
3. API routes (§5)
4. Frontend (§6), in the stated order: API client + auth context → layout →
   read-only pages → search → write-path portfolio pages last
5. Tests as you go, not after — Tier 1 (pure function) tests for
   `calculateFifoPosition` should exist before it's wired into any service

Do not build everything in one pass. Implement and pause for review after
each major section (schema, then backend core, then API layer, then
frontend), rather than delivering the whole app at once.

## Code quality expectations

- TypeScript strict mode, both frontend and backend — no `any` without a
  comment explaining why it's unavoidable
- Every money value (quantity, price, fees, gain/loss) uses a decimal
  library, never native `number` arithmetic
- Every external input — HTTP request bodies/params/query, and the market
  data provider's responses — validated through a Zod schema at the
  boundary before use
- Clear separation of concerns per §4 of the plan: routes don't contain
  business logic, services don't touch Express types, services don't
  contain raw SQL scattered inline (isolate DB access behind clear functions)
- Functions doing non-obvious things (FIFO lot consumption, the
  chronological-sell check, the idempotency transaction) get a short comment
  explaining *why*, not just what — this code needs to be defensible in a
  review conversation, not just working

## Security

- Passwords: bcrypt, never stored or logged in plaintext
- JWT secret and all API keys via environment variables, never hardcoded,
  never committed (`.env` is gitignored — verify nothing secret lands in a
  commit)
- Timing-attack-resistant login (§4.4) — implement the dummy-hash comparison
  as specified, don't skip it
- SQL via parameterized queries only, never string-concatenated
- If the Security Guidance plugin is active, treat its warnings as blocking
  before a section is considered done, not advisory

## Testing

Implement all three tiers from §8 — pure function, fake-DB service layer,
integration — as each relevant piece of backend logic is built, not
retroactively at the end. The FIFO calculation tests are the highest
priority in the whole repo: this is where a silent bug produces a wrong
number, not a crash.

## What NOT to do

- Don't silently swap FIFO for average-cost accounting because it's simpler
  — this was a deliberate, reasoned choice (ASSUMPTIONS.md #2)
- Don't drop the full idempotency-key system for a simpler debounce/disable-button
  version — also deliberate (ASSUMPTIONS.md #22)
- Don't add features not in IMPLEMENTATION_PLAN.md §1 (news, watchlists,
  multiple portfolios, cash tracking) without flagging it as a scope change first
- Don't skip writing ASSUMPTIONS.md-worthy reasoning into code comments where
  a future reader (a reviewer, or you next week) would reasonably ask "why
  was it built this way"
