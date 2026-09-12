import { Decimal } from 'decimal.js';

/**
 * Money arithmetic primitives (IMPLEMENTATION_PLAN.md §4.3, ASSUMPTIONS.md #20).
 *
 * Every money value in the application is a `Decimal`. Native `number` is not
 * used for arithmetic anywhere past the provider boundary, because the failure
 * mode of floating point here is not a crash — it is a gain/loss figure that
 * is wrong in the last decimal place and looks entirely plausible.
 */

/**
 * 34 significant digits — the precision of IEEE 754 decimal128, chosen rather
 * than the library default of 20 for a specific reason.
 *
 * Inputs are `NUMERIC(18,4)`, so a single value needs at most 22 digits. The
 * headroom is for *division*: allocating a lot's cost across a partial sale
 * produces a repeating decimal, and that intermediate is then multiplied and
 * summed across many lots. Extra digits keep the accumulated error far below
 * the 4th decimal place that is ever displayed or stored.
 *
 * This is a process-global setting, which is a real side effect of importing
 * this module. It is acceptable here because the application has exactly one
 * money domain and one correct precision for it — the alternative,
 * `Decimal.clone()`, creates a second constructor whose instances are easy to
 * mix with the first, and mixing is a subtler bug than a global default.
 */
Decimal.set({
  precision: 34,
  // Banker's rounding: unbiased, which matters because these values are summed
  // across many lots and positions. Always rounding half away from zero
  // introduces a drift that accumulates in one direction.
  rounding: Decimal.ROUND_HALF_EVEN,
  // Never fall back to exponential notation when converting to string —
  // `toString()` output can reach the database and a user's screen, and
  // "1e+21" is not a valid NUMERIC literal.
  toExpNeg: -1e9,
  toExpPos: 1e9,
});

export { Decimal };

export const ZERO = new Decimal(0);

/** Scale of the NUMERIC columns; the precision a stored money value can hold. */
export const MONEY_SCALE = 4;

/**
 * Division that returns zero instead of NaN or Infinity when the denominator
 * is zero (IMPLEMENTATION_PLAN.md §4.3).
 *
 * Required because the denominators here are legitimately zero in ordinary
 * situations — average cost of a fully-sold position, percentage return on a
 * holding whose total cost is zero. Propagating NaN would render as "NaN" in
 * the UI, and worse, NaN compares false against every threshold, so a guard
 * like `if (gain > 0)` silently takes the wrong branch.
 */
export function safeDivide(numerator: Decimal, denominator: Decimal): Decimal {
  if (denominator.isZero()) {
    return ZERO;
  }
  return numerator.dividedBy(denominator);
}

/** Sum with an explicit zero identity, so an empty list yields 0 rather than
 *  undefined and the caller never needs a length check. */
export function sum(values: readonly Decimal[]): Decimal {
  return values.reduce<Decimal>((total, value) => total.plus(value), ZERO);
}

/**
 * Rounds to the scale the database stores, for values that are about to be
 * persisted or displayed.
 *
 * Deliberately NOT applied to intermediate results inside the FIFO
 * calculation. Rounding each step and then summing produces a different answer
 * than summing and rounding once, and the second is the correct one — rounding
 * early is how a ledger drifts away from the sum of its parts.
 */
export function toMoneyScale(value: Decimal): Decimal {
  return value.toDecimalPlaces(MONEY_SCALE, Decimal.ROUND_HALF_EVEN);
}
