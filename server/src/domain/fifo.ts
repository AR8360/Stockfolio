import { AppError, ErrorCodes } from '../errors/AppError.js';
import { Decimal, ZERO, safeDivide, sum } from './money.js';

/**
 * FIFO lot accounting (IMPLEMENTATION_PLAN.md §4.3, ASSUMPTIONS.md #2).
 *
 * Pure: no database, no clock, no market data, no Express. It takes the trade
 * history for ONE holding and returns everything derivable from it. That
 * purity is the reason the same function serves both call sites the plan
 * names — validating a sell on the write path, and computing the dashboard on
 * the read path — instead of two implementations that can disagree.
 *
 * Why FIFO rather than average cost: on a partial sale the two produce
 * genuinely different realized gains, and FIFO is what Indian brokerage and
 * tax statements actually report. Average cost is one blended number per
 * holding and far less code; it is also the wrong number for anything
 * tax-adjacent (ASSUMPTIONS.md #2).
 */

export interface FifoTrade {
  id: string;
  type: 'BUY' | 'SELL';
  quantity: Decimal;
  price: Decimal;
  /** Brokerage, taxes and charges. Added to cost on a buy, deducted from
   *  proceeds on a sell — both of which make the realized gain reflect what
   *  the trade actually cost, which is the number a user reconciles against a
   *  contract note. */
  fees: Decimal;
  /** Trading day. Day-level only (ASSUMPTIONS.md #3). */
  date: Date;
  /** Insertion time, used only to order two trades recorded on the same date. */
  createdAt: Date;
}

/** A buy lot with whatever remains unconsumed. */
export interface OpenLot {
  buyTransactionId: string;
  date: Date;
  quantity: Decimal;
  /** Cost of the remaining shares only, including their share of the buy fee. */
  cost: Decimal;
}

export interface ConsumedLot {
  buyTransactionId: string;
  quantity: Decimal;
  cost: Decimal;
}

export interface RealizedSale {
  sellTransactionId: string;
  date: Date;
  quantity: Decimal;
  /** Gross less sell-side fees. */
  proceeds: Decimal;
  costBasis: Decimal;
  realizedGain: Decimal;
  /** Which buy lots this sale consumed, oldest first. Retained because it is
   *  what makes a realized figure auditable — a user querying a number can be
   *  shown the exact lots behind it. */
  lots: ConsumedLot[];
}

export interface FifoPosition {
  /** Shares still held. Zero for a fully-closed position. */
  quantity: Decimal;
  /** Cost of the shares still held, including allocated buy fees. */
  costBasis: Decimal;
  /** costBasis / quantity; zero when nothing is held. */
  averageCost: Decimal;
  realizedGain: Decimal;
  sales: RealizedSale[];
  openLots: OpenLot[];
  /**
   * Null when no current price was supplied, NOT zero. A zero unrealized gain
   * is a real and meaningful answer; "the price is unknown" is a different
   * state, and collapsing the two would let a failed market data fetch render
   * as a position that happens to be exactly break-even.
   */
  marketValue: Decimal | null;
  unrealizedGain: Decimal | null;
}

export interface FifoOptions {
  currentPrice?: Decimal;
}

export function calculateFifoPosition(
  trades: readonly FifoTrade[],
  options: FifoOptions = {},
): FifoPosition {
  const ordered = sortTrades(trades);

  /** Open lots, oldest first. `head` marks the oldest unconsumed lot instead
   *  of shifting the array, so consuming N lots stays O(N) rather than O(N²)
   *  — this runs on every holdings request, not only on write. */
  const lots: MutableLot[] = [];
  let head = 0;

  const sales: RealizedSale[] = [];
  let realizedGain = ZERO;

  for (const trade of ordered) {
    if (trade.type === 'BUY') {
      lots.push({
        buyTransactionId: trade.id,
        date: trade.date,
        remainingQuantity: trade.quantity,
        // Fees capitalized into the lot. They are then carried proportionally
        // as the lot is consumed, so a buy fee is recovered across exactly the
        // sales that dispose of those shares.
        remainingCost: trade.quantity.times(trade.price).plus(trade.fees),
      });
      continue;
    }

    const proceeds = trade.quantity.times(trade.price).minus(trade.fees);
    const consumed: ConsumedLot[] = [];
    let outstanding = trade.quantity;
    let costOfSold = ZERO;

    while (outstanding.greaterThan(0)) {
      const lot = lots[head];

      if (lot === undefined) {
        // Ran out of lots mid-sale. Throwing rather than returning a negative
        // position is deliberate: on the write path this is the validation
        // that rejects the trade, and on the read path it means stored data
        // already violates an invariant the write path enforces — in which
        // case failing loudly beats rendering a confidently wrong number.
        throw insufficientHoldings(trade, outstanding);
      }

      const take = Decimal.min(lot.remainingQuantity, outstanding);

      // Exactness rule: when a lot is consumed in full, take its entire
      // remaining cost rather than recomputing it proportionally.
      //
      // The proportional path computes `remaining * take / take`, which is
      // usually — but not always — an exact round trip. When the lot's cost
      // already needs all 34 significant digits (because an earlier partial
      // sale divided a repeating unit cost), the multiplication rounds and the
      // division does not recover it: a 3-share lot at 33.33 plus a 1.00 fee,
      // sold 1 then 2, returns ...666665 where ...666667 is owed. The lot is
      // then dropped as empty, so that sliver of cost is destroyed rather than
      // carried.
      //
      // The error is around 1e-32 — far below the 4 decimal places stored, and
      // it does not accumulate, since each lot is closed once. The rule is kept
      // because it costs one comparison and makes "a closed lot has contributed
      // exactly its cost" true by construction rather than by arithmetic luck.
      const costTaken = take.equals(lot.remainingQuantity)
        ? lot.remainingCost
        : // Multiply before dividing: it keeps one division rather than
          // compounding the error of a divide-then-multiply.
          lot.remainingCost.times(take).dividedBy(lot.remainingQuantity);

      lot.remainingQuantity = lot.remainingQuantity.minus(take);
      lot.remainingCost = lot.remainingCost.minus(costTaken);

      consumed.push({
        buyTransactionId: lot.buyTransactionId,
        quantity: take,
        cost: costTaken,
      });
      costOfSold = costOfSold.plus(costTaken);
      outstanding = outstanding.minus(take);

      if (lot.remainingQuantity.isZero()) {
        head += 1;
      }
    }

    const gain = proceeds.minus(costOfSold);
    realizedGain = realizedGain.plus(gain);

    sales.push({
      sellTransactionId: trade.id,
      date: trade.date,
      quantity: trade.quantity,
      proceeds,
      costBasis: costOfSold,
      realizedGain: gain,
      lots: consumed,
    });
  }

  const openLots: OpenLot[] = lots.slice(head).map((lot) => ({
    buyTransactionId: lot.buyTransactionId,
    date: lot.date,
    quantity: lot.remainingQuantity,
    cost: lot.remainingCost,
  }));

  const quantity = sum(openLots.map((lot) => lot.quantity));
  const costBasis = sum(openLots.map((lot) => lot.cost));

  const { currentPrice } = options;
  const marketValue = currentPrice === undefined ? null : quantity.times(currentPrice);

  return {
    quantity,
    costBasis,
    averageCost: safeDivide(costBasis, quantity),
    realizedGain,
    sales,
    openLots,
    marketValue,
    unrealizedGain: marketValue === null ? null : marketValue.minus(costBasis),
  };
}

interface MutableLot {
  buyTransactionId: string;
  date: Date;
  remainingQuantity: Decimal;
  remainingCost: Decimal;
}

/**
 * Orders trades the way FIFO replay requires: by trading day, then by
 * insertion order for trades sharing a day.
 *
 * The function sorts rather than trusting the caller, even though the database
 * index on `(portfolio_id, instrument_id, txn_date, created_at, id)` means
 * rows normally arrive in this order already. A caller that passes unsorted
 * trades does not get an error from this function — it gets a plausible,
 * wrong gain figure, and that is the one failure mode this whole module exists
 * to prevent. Sorting costs effectively nothing on already-ordered input,
 * which is the actual case in production.
 */
function sortTrades(trades: readonly FifoTrade[]): FifoTrade[] {
  return [...trades].sort((a, b) => {
    const byDate = a.date.getTime() - b.date.getTime();
    if (byDate !== 0) return byDate;

    const byCreated = a.createdAt.getTime() - b.createdAt.getTime();
    if (byCreated !== 0) return byCreated;

    return compareIds(a.id, b.id);
  });
}

/**
 * Final tie-break on id. Ids are `BIGINT`, which arrives as a string — so a
 * plain string comparison orders "10" before "9" and would replay two
 * same-instant trades backwards.
 */
function compareIds(a: string, b: string): number {
  try {
    const left = BigInt(a);
    const right = BigInt(b);
    return left === right ? 0 : left < right ? -1 : 1;
  } catch {
    // Non-numeric ids (only tests construct these) fall back to string order.
    return a < b ? -1 : a > b ? 1 : 0;
  }
}

function insufficientHoldings(trade: FifoTrade, short: Decimal): AppError {
  return new AppError({
    status: 400,
    code: ErrorCodes.INSUFFICIENT_HOLDINGS,
    message: `Cannot sell ${trade.quantity.toString()} shares: ${short.toString()} more than held on ${formatDate(trade.date)}`,
    details: {
      requested: trade.quantity.toString(),
      short: short.toString(),
      date: formatDate(trade.date),
    },
  });
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
