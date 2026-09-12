-- Stockfolio schema (IMPLEMENTATION_PLAN.md §3)
--
-- Idempotent by design: every statement is IF NOT EXISTS, so `npm run db:init`
-- is safe to re-run against an existing database. There is no migration
-- framework and no versioning here -- a deliberate trade-off for one developer
-- and one environment (ASSUMPTIONS.md #32). The moment a second environment or
-- a second developer exists, this file stops being sufficient, because it can
-- create objects but never *alter* them.

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  name          TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Lowercase is enforced in the database, not just normalized in the service
  -- layer. Email uniqueness is the one constraint an auth bug can violate in a
  -- way that is unrecoverable later: once A@x.com and a@x.com both exist as
  -- separate accounts, no amount of application-side fixing tells you which
  -- one a given password belongs to. The alternative (a CITEXT column) needs
  -- an extension and makes case-insensitivity invisible at the call site; this
  -- makes any un-normalized insert fail loudly instead.
  CONSTRAINT users_email_lowercase CHECK (email = lower(email)),
  CONSTRAINT users_email_nonempty  CHECK (length(email) > 0)
);

-- ---------------------------------------------------------------------------
-- portfolios
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS portfolios (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One portfolio is auto-created per user at registration; the API only ever
-- uses that one (ASSUMPTIONS.md, known gaps). Kept as a child table rather
-- than folded into `users` so multi-portfolio support becomes an API change,
-- not a schema migration.
--
-- This index is not optional bookkeeping: every portfolio write begins with
-- `SELECT id FROM portfolios WHERE user_id = $1 FOR UPDATE` (§4.3), so this
-- lookup sits directly in the hot path of the lock that serializes writes.
CREATE INDEX IF NOT EXISTS portfolios_user_id_idx ON portfolios (user_id);

-- ---------------------------------------------------------------------------
-- instruments
-- ---------------------------------------------------------------------------

-- Local cache of external stock metadata, upserted on every trade that touches
-- a stock. Its job is to decouple the ledger from the live provider: a
-- transaction row references a stable local instrument id, so a historical
-- trade still renders correctly if the provider renames a field, delists the
-- symbol, or is simply down (ASSUMPTIONS.md #12, #14).
CREATE TABLE IF NOT EXISTS instruments (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  symbol     TEXT        NOT NULL,
  exchange   TEXT        NOT NULL,
  name       TEXT        NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT instruments_symbol_exchange_key UNIQUE (symbol, exchange),
  -- Redundant as a uniqueness claim (id is already the primary key), but a
  -- composite foreign key needs a matching unique constraint on its target
  -- columns. This is what lets `transactions` carry a copy of `exchange` that
  -- the database itself guarantees matches this row -- see the whole-share
  -- CHECK on that table.
  CONSTRAINT instruments_id_exchange_key UNIQUE (id, exchange),
  -- Same reasoning as the email constraint: (symbol, exchange) is a natural
  -- key used for upserts, so an un-normalized write would quietly create a
  -- duplicate instrument and split one holding ledger across two ids -- which
  -- shows up as a wrong FIFO number, not as an error.
  CONSTRAINT instruments_symbol_uppercase   CHECK (symbol = upper(symbol)),
  CONSTRAINT instruments_exchange_uppercase CHECK (exchange = upper(exchange))
);

-- ---------------------------------------------------------------------------
-- transactions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS transactions (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  portfolio_id  BIGINT        NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  instrument_id BIGINT        NOT NULL,

  -- Denormalized copy of instruments.exchange, carried here for one reason: a
  -- Postgres CHECK constraint cannot reference another table, so the
  -- whole-share rule below (which is conditional on the exchange) is not
  -- expressible unless the exchange is a column of *this* table.
  --
  -- The usual objection to denormalizing is drift between the two copies. That
  -- cannot happen here: the composite foreign key below makes (instrument_id,
  -- exchange) reference (id, exchange) on instruments, so the database rejects
  -- any row whose exchange disagrees with its instrument. This is a
  -- constraint, not a convention the application has to remember to uphold.
  exchange      TEXT          NOT NULL,

  type          TEXT          NOT NULL,

  -- NUMERIC, never FLOAT/DOUBLE (ASSUMPTIONS.md #20). Scale 4 rather than 2
  -- because price genuinely needs sub-paisa precision on some instruments, and
  -- because these same columns are meant to hold non-INR trades later
  -- (ASSUMPTIONS.md #1).
  quantity      NUMERIC(18,4) NOT NULL,
  price         NUMERIC(18,4) NOT NULL,
  fees          NUMERIC(18,4) NOT NULL DEFAULT 0,
  currency      TEXT          NOT NULL,

  -- DATE, not TIMESTAMPTZ: FIFO lot accounting only needs day-level ordering,
  -- and storing an intraday time would imply a precision the user is not
  -- actually entering (ASSUMPTIONS.md #3).
  txn_date      DATE          NOT NULL,

  -- Idempotency backstop. Nullable on purpose: only POST /transactions carries
  -- an Idempotency-Key (§5). PATCH/DELETE corrections do not, and Postgres
  -- treats NULLs as distinct in a UNIQUE constraint, so any number of
  -- key-less rows coexist without colliding.
  client_request_id UUID,
  request_hash      CHAR(64),

  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),

  CONSTRAINT transactions_type_valid         CHECK (type IN ('BUY', 'SELL')),
  CONSTRAINT transactions_quantity_positive  CHECK (quantity > 0),
  CONSTRAINT transactions_price_positive     CHECK (price > 0),
  CONSTRAINT transactions_fees_nonnegative   CHECK (fees >= 0),
  CONSTRAINT transactions_currency_format    CHECK (currency = upper(currency) AND length(currency) = 3),

  -- RESTRICT, not CASCADE: an instrument row disappearing must never silently
  -- delete ledger history. Instruments are cache-like; transactions are not.
  -- No ON UPDATE clause, so the default (NO ACTION) blocks any attempt to
  -- change an instrument exchange out from under existing trades -- which is
  -- correct, since (symbol, exchange) is the natural key of an instrument and
  -- changing it means a different instrument. The upsert path only ever writes
  -- `name` and `updated_at`, so it never collides with this.
  CONSTRAINT transactions_instrument_fk
    FOREIGN KEY (instrument_id, exchange) REFERENCES instruments (id, exchange)
    ON DELETE RESTRICT,

  -- Whole-share rule (ASSUMPTIONS.md #7), enforced at the same two layers as
  -- every other money constraint here: Zod at the route boundary, and a
  -- backstop in the database.
  --
  -- Written as an implication (NOT IN ... OR integral) rather than a blanket
  -- `quantity = trunc(quantity)` so it stays market-specific. NSE and BSE trade
  -- whole shares; US markets allow fractional ones, and these columns are meant
  -- to carry US trades later (ASSUMPTIONS.md #1). A blanket check would enforce
  -- an Indian-market rule on a market-agnostic ledger and would have to be
  -- dropped -- with a table rewrite -- the day the first fractional trade is
  -- recorded. Adding an exchange to the exempt side of this condition is an
  -- additive change instead.
  --
  -- `trunc` rather than `quantity % 1 = 0`: both work on NUMERIC, but trunc
  -- states the intent (no fractional part) without depending on how the
  -- modulo operator handles negative or scaled numerics.
  CONSTRAINT transactions_whole_shares_on_indian_exchanges
    CHECK (exchange NOT IN ('NSE', 'BSE') OR quantity = trunc(quantity)),

  -- The last line of defence against double submission, behind the
  -- idempotency_keys table and the portfolio row lock (§4.3). It is the only
  -- one of the three that still holds if the application logic above it is
  -- wrong, because the database rejects the duplicate write itself.
  CONSTRAINT transactions_portfolio_client_request_key UNIQUE (portfolio_id, client_request_id)
);

-- Note: the whole-share rule is enforced by
-- `transactions_whole_shares_on_indian_exchanges` above, and *also* validated
-- by Zod at the route boundary. The duplication is deliberate and matches how
-- the other money rules here work (quantity > 0, price > 0, fees >= 0): Zod
-- gives the user a useful field-level error, the CHECK guarantees the invariant
-- holds no matter what path wrote the row -- a script, a migration, a psql
-- session, or a future service that forgets to validate.

-- Column order matches the exact sort FIFO replay needs: every trade for one
-- holding, oldest first, with (created_at, id) breaking ties between two
-- trades recorded against the same date. Because index order matches query
-- order, Postgres streams the ledger straight out of the index with no sort
-- step -- which matters because this is read on every holdings and summary
-- request, not only on write.
CREATE INDEX IF NOT EXISTS transactions_fifo_replay_idx
  ON transactions (portfolio_id, instrument_id, txn_date, created_at, id);

-- ---------------------------------------------------------------------------
-- idempotency_keys
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS idempotency_keys (
  user_id       BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key           UUID        NOT NULL,

  -- SHA-256 hex of the canonicalized request body. Stored so a replayed key
  -- can be checked against the body it was first used with: same key + same
  -- body is a genuine retry (replay the stored response), same key + different
  -- body is a client bug (409 IDEMPOTENCY_KEY_REUSED, §4.3).
  request_hash  CHAR(64)    NOT NULL,

  -- NULL between the row being claimed and the request completing. The row is
  -- inserted *before* the work is done, precisely so a concurrent request
  -- carrying the same key has something to block on; the response is written
  -- back into this column once the work in that transaction succeeds.
  response_body JSONB,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- (user_id, key) as the primary key rather than a surrogate id plus a UNIQUE
  -- index: it is the only key this table is ever looked up by, so making it
  -- the PK means one index instead of two.
  --
  -- Worth being explicit about what this constraint does and does not do.
  -- `SELECT ... FOR UPDATE` on an idempotency row only serializes callers once
  -- the row EXISTS. For the very first request carrying a brand-new key there
  -- is no row to lock, so two simultaneous first-requests can both read "no
  -- key found" and both proceed. That gap is closed by the portfolio row lock
  -- (which always has a row to lock) and, failing that, by this constraint
  -- rejecting the second INSERT outright. The three mechanisms are layered,
  -- not redundant -- each covers a window the others leave open.
  CONSTRAINT idempotency_keys_pkey PRIMARY KEY (user_id, key)
);

-- Supports a future scheduled cleanup of expired keys. The job itself is not
-- built (ASSUMPTIONS.md, known gaps) -- this table grows unbounded until it is.
CREATE INDEX IF NOT EXISTS idempotency_keys_created_at_idx
  ON idempotency_keys (created_at);
