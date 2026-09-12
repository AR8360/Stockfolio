import { AppError, ErrorCodes } from '../errors/AppError.js';
import { Decimal, ZERO } from './money.js';

/**
 * Backdated-sell validation (IMPLEMENTATION_PLAN.md §4.3).
 *
 * The problem this solves is specific and easy to miss: trades are not
 * necessarily entered in date order (ASSUMPTIONS.md #8 allows corrections), so
 * a sell can be perfectly valid *on its own date* and still be invalid,
 * because it retroactively makes some later date's balance negative.
 *
 *   Jan 10  BUY  100
 *   Mar 10  SELL 100     <- already recorded, leaves a zero balance
 *   Feb 10  SELL  50     <- being added now
 *
 * On 10 February the user did hold 100 shares, so a naive "do they have enough
 * today" check passes. But accepting it means that from 10 March the ledger
 * shows -50. The check has to look forward, not just at the sell's own date.
 *
 * Pure, and computed in application code rather than SQL: the per-holding
 * ledger is small (one user's trades in one stock), and keeping it here makes
 * it unit-testable with no database (§4.3).
 */

/** Only what the check actually needs — deliberately narrower than a full
 *  trade, so it is obvious this does not depend on price or fees. */
export interface LedgerEntry {
  type: 'BUY' | 'SELL';
  quantity: Decimal;
  date: Date;
}

export interface ProposedSell {
  quantity: Decimal;
  date: Date;
}

/**
 * Throws `INSUFFICIENT_HOLDINGS` if the proposed sell would make the running
 * balance negative on its own date or on any later one.
 *
 * Algorithm: collapse the ledger into net deltas per day, walk the days in
 * order once, and track the running balance. The sell is valid exactly when
 * the *minimum* balance from its date onward is at least the quantity being
 * sold — subtracting q from every balance at or after that date must leave
 * them all non-negative.
 *
 * The plan states this as two conditions (enough on the date, and enough at
 * every later date). They collapse into one, because the balance on the sell's
 * own date is itself part of the range being minimized. Both are still
 * computed separately here — not for correctness, but so the error can say
 * *which* of the two situations occurred, which are quite different mistakes
 * from the user's point of view.
 */
export function assertChronologicalSell(
  ledger: readonly LedgerEntry[],
  proposed: ProposedSell,
): void {
  const deltas = new Map<string, Decimal>();

  for (const entry of ledger) {
    const key = dateKey(entry.date);
    const delta = entry.type === 'BUY' ? entry.quantity : entry.quantity.negated();
    deltas.set(key, (deltas.get(key) ?? ZERO).plus(delta));
  }

  const target = dateKey(proposed.date);
  // ISO date strings sort lexicographically in chronological order, which is
  // why the key format matters — any locale-formatted date would not.
  const days = [...deltas.keys()].sort();

  let running = ZERO;
  /** Balance as of the end of the sell's own date. */
  let availableOnDate = ZERO;
  /** Lowest balance strictly after that date, and the day it occurs. */
  let minAfter: Decimal | null = null;
  let minAfterDate: string | null = null;

  for (const day of days) {
    running = running.plus(deltas.get(day) ?? ZERO);

    if (day <= target) {
      availableOnDate = running;
    } else if (minAfter === null || running.lessThan(minAfter)) {
      minAfter = running;
      minAfterDate = day;
    }
  }

  if (availableOnDate.lessThan(proposed.quantity)) {
    throw new AppError({
      status: 400,
      code: ErrorCodes.INSUFFICIENT_HOLDINGS,
      message: `Only ${availableOnDate.toString()} shares were held on ${target}; cannot sell ${proposed.quantity.toString()}`,
      details: {
        reason: 'NOT_HELD_ON_DATE',
        date: target,
        available: availableOnDate.toString(),
        requested: proposed.quantity.toString(),
      },
    });
  }

  if (minAfter !== null && minAfter.lessThan(proposed.quantity)) {
    // The interesting case: enough on the day, not enough afterwards.
    throw new AppError({
      status: 400,
      code: ErrorCodes.INSUFFICIENT_HOLDINGS,
      message: `Selling ${proposed.quantity.toString()} shares on ${target} would leave a negative balance on ${String(minAfterDate)}, where only ${minAfter.toString()} shares are held`,
      details: {
        reason: 'WOULD_GO_NEGATIVE_LATER',
        date: target,
        conflictDate: minAfterDate,
        availableThen: minAfter.toString(),
        requested: proposed.quantity.toString(),
      },
    });
  }
}

/**
 * `YYYY-MM-DD` in UTC.
 *
 * UTC getters, not local ones. A `DATE` column carries no timezone, and if a
 * value is ever materialized as local midnight, local getters west of UTC
 * report the previous day — silently reordering the ledger and changing which
 * lot FIFO consumes. The database layer parses DATE columns as plain strings
 * for the same reason; this is the second half of that defence.
 */
function dateKey(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
