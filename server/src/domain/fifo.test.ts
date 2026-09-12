import { describe, expect, it } from 'vitest';

import { calculateFifoPosition, type FifoTrade } from './fifo.js';
import { Decimal, sum, toMoneyScale } from './money.js';
import { AppError } from '../errors/AppError.js';

/**
 * Tier 1 (IMPLEMENTATION_PLAN.md §8): pure function, no mocks, no database.
 *
 * CLAUDE.md calls these the highest-priority tests in the repo, for the reason
 * that a bug here produces a wrong *number* rather than a crash — nothing else
 * in the system can detect it. So these assert exact values, never
 * "approximately", and several exist specifically to fail if the accounting
 * method is quietly changed.
 */

let sequence = 0;

function trade(
  type: 'BUY' | 'SELL',
  date: string,
  quantity: number | string,
  price: number | string,
  fees: number | string = 0,
): FifoTrade {
  sequence += 1;
  return {
    id: String(sequence),
    type,
    quantity: new Decimal(quantity),
    price: new Decimal(price),
    fees: new Decimal(fees),
    date: new Date(`${date}T00:00:00Z`),
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)),
  };
}

const buy = (date: string, q: number | string, p: number | string, f?: number | string) =>
  trade('BUY', date, q, p, f);
const sell = (date: string, q: number | string, p: number | string, f?: number | string) =>
  trade('SELL', date, q, p, f);

describe('calculateFifoPosition — basics', () => {
  it('reports an empty position for no trades', () => {
    const position = calculateFifoPosition([]);

    expect(position.quantity.toString()).toBe('0');
    expect(position.costBasis.toString()).toBe('0');
    expect(position.realizedGain.toString()).toBe('0');
    expect(position.openLots).toEqual([]);
  });

  it('accumulates a single buy', () => {
    const position = calculateFifoPosition([buy('2026-01-05', 10, 100)]);

    expect(position.quantity.toString()).toBe('10');
    expect(position.costBasis.toString()).toBe('1000');
    expect(position.averageCost.toString()).toBe('100');
    expect(position.realizedGain.toString()).toBe('0');
  });

  it('handles a simple buy then full sell', () => {
    const position = calculateFifoPosition([
      buy('2026-01-05', 10, 100),
      sell('2026-02-05', 10, 130),
    ]);

    expect(position.quantity.toString()).toBe('0');
    expect(position.costBasis.toString()).toBe('0');
    expect(position.realizedGain.toString()).toBe('300');
    // A closed position keeps contributing realized gain but leaves the
    // holdings view (ASSUMPTIONS.md #5).
    expect(position.openLots).toEqual([]);
  });

  it('returns zero average cost for a fully-sold position rather than NaN', () => {
    const position = calculateFifoPosition([
      buy('2026-01-05', 10, 100),
      sell('2026-02-05', 10, 130),
    ]);

    expect(position.averageCost.toString()).toBe('0');
    expect(position.averageCost.isNaN()).toBe(false);
  });
});

describe('calculateFifoPosition — lot ordering', () => {
  it('consumes the oldest lot first, not the cheapest', () => {
    // Oldest lot is the *more expensive* one, so FIFO and "sell cheapest
    // first" give different answers and this pins the right one.
    const position = calculateFifoPosition([
      buy('2026-01-05', 10, 150),
      buy('2026-02-05', 10, 100),
      sell('2026-03-05', 10, 200),
    ]);

    expect(position.realizedGain.toString()).toBe('500'); // 2000 - 1500
    expect(position.costBasis.toString()).toBe('1000'); // the newer, cheaper lot
  });

  it('is not average-cost accounting', () => {
    // Guards ASSUMPTIONS.md #2 directly. Buy 10@100 then 10@120, sell 15@150.
    //   FIFO:         10 from the 100 lot + 5 from the 120 lot = 1600 cost
    //                 -> realized 2250 - 1600 = 650
    //   Average cost: 15 * 110 = 1650 -> realized 600
    // If someone "simplifies" this to a blended average, this test fails.
    const position = calculateFifoPosition([
      buy('2026-01-05', 10, 100),
      buy('2026-02-05', 10, 120),
      sell('2026-03-05', 15, 150),
    ]);

    expect(position.realizedGain.toString()).toBe('650');
    expect(position.realizedGain.toString()).not.toBe('600');
  });

  it('splits one sale across multiple lots and records each', () => {
    const position = calculateFifoPosition([
      buy('2026-01-05', 10, 100),
      buy('2026-02-05', 10, 120),
      sell('2026-03-05', 15, 150),
    ]);

    const [sale] = position.sales;
    expect(sale?.lots).toHaveLength(2);
    expect(sale?.lots[0]).toMatchObject({ buyTransactionId: expect.any(String) });
    expect(sale?.lots[0]?.quantity.toString()).toBe('10');
    expect(sale?.lots[0]?.cost.toString()).toBe('1000');
    expect(sale?.lots[1]?.quantity.toString()).toBe('5');
    expect(sale?.lots[1]?.cost.toString()).toBe('600');
  });

  it('handles a sell that exactly exhausts a lot boundary', () => {
    // Named explicitly in §8: the off-by-one risk is consuming into the next
    // lot, or leaving a zero-quantity lot open.
    const position = calculateFifoPosition([
      buy('2026-01-05', 10, 100),
      buy('2026-02-05', 10, 120),
      sell('2026-03-05', 10, 150),
    ]);

    expect(position.sales[0]?.lots).toHaveLength(1);
    expect(position.openLots).toHaveLength(1);
    expect(position.openLots[0]?.quantity.toString()).toBe('10');
    expect(position.costBasis.toString()).toBe('1200');
  });

  it('replays backdated entries in trade-date order, not entry order', () => {
    // Trades are not necessarily entered chronologically. Entered second but
    // dated first, the January lot must still be consumed first.
    const january = buy('2026-01-05', 10, 100);
    const february = buy('2026-02-05', 10, 150);
    const position = calculateFifoPosition([
      february,
      january,
      sell('2026-03-05', 10, 200),
    ]);

    expect(position.realizedGain.toString()).toBe('1000'); // 2000 - 1000
    expect(position.costBasis.toString()).toBe('1500');
  });

  it('breaks ties on the same date by insertion order', () => {
    const first = buy('2026-01-05', 10, 100);
    const second = buy('2026-01-05', 10, 200);
    const position = calculateFifoPosition([
      second,
      first,
      sell('2026-02-05', 10, 300),
    ]);

    expect(position.realizedGain.toString()).toBe('2000'); // consumed the 100 lot
  });
});

describe('calculateFifoPosition — fees', () => {
  it('capitalizes buy fees into cost basis', () => {
    const position = calculateFifoPosition([buy('2026-01-05', 10, 100, 50)]);

    expect(position.costBasis.toString()).toBe('1050');
    expect(position.averageCost.toString()).toBe('105');
  });

  it('deducts sell fees from proceeds', () => {
    const position = calculateFifoPosition([
      buy('2026-01-05', 10, 100),
      sell('2026-02-05', 10, 130, 25),
    ]);

    // (1300 - 25) - 1000
    expect(position.realizedGain.toString()).toBe('275');
    expect(position.sales[0]?.proceeds.toString()).toBe('1275');
  });

  it('allocates a buy fee across the sales that consume the lot', () => {
    const position = calculateFifoPosition([
      buy('2026-01-05', 10, 100, 100), // 1100 total, 110/share
      sell('2026-02-05', 4, 200),
    ]);

    expect(position.sales[0]?.costBasis.toString()).toBe('440');
    expect(position.costBasis.toString()).toBe('660');
    expect(position.realizedGain.toString()).toBe('360'); // 800 - 440
  });
});

describe('calculateFifoPosition — rejects an oversell', () => {
  it('throws when selling more than is held', () => {
    const error = (() => {
      try {
        calculateFifoPosition([buy('2026-01-05', 5, 100), sell('2026-02-05', 10, 150)]);
      } catch (e) {
        return e as AppError;
      }
      throw new Error('expected a throw');
    })();

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe('INSUFFICIENT_HOLDINGS');
    expect(error.status).toBe(400);
    expect(error.details).toMatchObject({ short: '5', requested: '10' });
  });

  it('throws when selling with no holdings at all', () => {
    expect(() => calculateFifoPosition([sell('2026-01-05', 1, 100)])).toThrow(AppError);
  });

  it('throws when a later buy would have covered the sale', () => {
    // The buy is dated after the sell, so it cannot supply those shares —
    // replaying in date order is what catches this.
    expect(() =>
      calculateFifoPosition([buy('2026-03-05', 100, 100), sell('2026-01-05', 10, 150)]),
    ).toThrow(AppError);
  });
});

describe('calculateFifoPosition — valuation', () => {
  it('leaves market figures null when no price is supplied', () => {
    const position = calculateFifoPosition([buy('2026-01-05', 10, 100)]);

    // Null, not zero: "price unknown" must be distinguishable from a position
    // that is exactly break-even, or a failed quote fetch renders as a real
    // number (ASSUMPTIONS.md #16).
    expect(position.marketValue).toBeNull();
    expect(position.unrealizedGain).toBeNull();
  });

  it('computes unrealized gain against the remaining lots only', () => {
    const position = calculateFifoPosition(
      [buy('2026-01-05', 10, 100), buy('2026-02-05', 10, 120), sell('2026-03-05', 15, 150)],
      { currentPrice: new Decimal(200) },
    );

    expect(position.quantity.toString()).toBe('5');
    expect(position.marketValue?.toString()).toBe('1000');
    expect(position.unrealizedGain?.toString()).toBe('400'); // 1000 - 600
    // Realized is reported separately and is not folded in (ASSUMPTIONS.md #4).
    expect(position.realizedGain.toString()).toBe('650');
  });

  it('reports zero, not null, for a genuinely break-even position', () => {
    const position = calculateFifoPosition([buy('2026-01-05', 10, 100)], {
      currentPrice: new Decimal(100),
    });

    expect(position.unrealizedGain?.toString()).toBe('0');
    expect(position.unrealizedGain).not.toBeNull();
  });
});

describe('calculateFifoPosition — decimal exactness', () => {
  it('does not leak float error on values that are inexact in binary', () => {
    // 0.1 + 0.2 !== 0.3 in native floats; three lots at 0.1 must total 0.3.
    const position = calculateFifoPosition([
      buy('2026-01-05', 1, '0.1'),
      buy('2026-01-06', 1, '0.1'),
      buy('2026-01-07', 1, '0.1'),
    ]);

    expect(position.costBasis.toString()).toBe('0.3');
  });

  it('leaves no cost residue when a lot with a repeating unit cost is closed', () => {
    // A 3-share lot costing 301 has a unit cost of 100.333... — the case where
    // a naive proportional allocation leaves a fraction of a paisa behind on a
    // lot that should be empty.
    const position = calculateFifoPosition([
      buy('2026-01-05', 3, 100, 1),
      sell('2026-02-05', 1, 200),
      sell('2026-03-05', 2, 200),
    ]);

    expect(position.quantity.toString()).toBe('0');
    expect(position.costBasis.toString()).toBe('0');
    // Every paisa of the 301 is accounted for across the two sales.
    expect(sum(position.sales.map((s) => s.costBasis)).toString()).toBe('301');
  });

  it('charges a fully-consumed lot exactly what remains on it', () => {
    // Pins the full-consumption exactness rule in the implementation.
    //
    // BUY 3 @ 33.33 + 1 fee leaves a unit cost that repeats. After selling 1,
    // the lot holds 2 shares at a cost needing all 34 significant digits;
    // closing it by recomputing `remaining * 2 / 2` rounds and returns
    // ...666665 instead of ...666667, so a sliver of cost is destroyed as the
    // lot is dropped.
    //
    // This scenario was found by search, and the distinction is narrow: most
    // quantities make the proportional path exact by luck (multiplying and
    // dividing by the same small integer usually round-trips), which is why
    // the more obvious test cases here do not detect the difference at all.
    const position = calculateFifoPosition([
      buy('2026-01-05', 3, '33.33', 1),
      sell('2026-02-05', 1, 50),
      sell('2026-03-05', 2, 50),
    ]);

    const totalCost = new Decimal(3).times('33.33').plus(1);

    expect(position.sales[1]?.costBasis.toString()).toBe(
      totalCost.minus(position.sales[0]!.costBasis).toString(),
    );
    expect(position.costBasis.toString()).toBe('0');
  });

  it('conserves cost: consumed plus remaining equals total bought', () => {
    // The invariant that makes the ledger internally consistent — if it fails,
    // cost was created or destroyed by rounding.
    //
    // Asserted at money scale plus a hard error bound, rather than as exact
    // string equality, and the distinction is a real property of the design
    // rather than a weakened test. When a lot's unit cost repeats (7 shares
    // costing 139.94), allocating it produces a value needing all 34 available
    // significant digits; the *running total* then needs a 35th and is
    // rounded. Per-lot allocation stays exact — `taken + remaining == total`
    // holds for every individual lot — so the residue is confined to the
    // aggregate and lands around 1e-31, which is 27 orders of magnitude below
    // the 4 decimal places ever stored or shown.
    //
    // The bound is what makes this an assertion rather than a shrug: a genuine
    // accounting bug (a dropped lot, a double-counted fee) moves the total by
    // whole currency units and fails both checks.
    const scenarios: FifoTrade[][] = [
      [buy('2026-01-05', 7, '33.33', '1.17'), sell('2026-02-05', 3, 40)],
      [
        buy('2026-01-05', 3, 100, 1),
        buy('2026-01-06', 7, '19.99', '0.01'),
        sell('2026-02-05', 5, 50),
        sell('2026-03-05', 2, 60, '0.5'),
      ],
      [buy('2026-01-05', 1, '0.0001'), sell('2026-02-05', 1, '0.0002')],
    ];

    for (const trades of scenarios) {
      const position = calculateFifoPosition(trades);
      const totalBought = sum(
        trades
          .filter((t) => t.type === 'BUY')
          .map((t) => t.quantity.times(t.price).plus(t.fees)),
      );
      const consumed = sum(position.sales.map((s) => s.costBasis));
      const accounted = consumed.plus(position.costBasis);

      expect(toMoneyScale(accounted).toString()).toBe(
        toMoneyScale(totalBought).toString(),
      );
      expect(
        accounted.minus(totalBought).abs().lessThan(new Decimal('1e-20')),
      ).toBe(true);
    }
  });

  it('allocates each individual lot exactly, with no residue', () => {
    // The stronger per-lot guarantee behind the aggregate bound above: for
    // every sale, the costs charged to each consumed lot sum to exactly that
    // sale's cost basis. This is what the full-consumption exactness rule in
    // the implementation buys, and it holds with no tolerance at all.
    const position = calculateFifoPosition([
      buy('2026-01-05', 3, 100, 1),
      buy('2026-01-06', 7, '19.99', '0.01'),
      sell('2026-02-05', 5, 50),
      sell('2026-03-05', 2, 60, '0.5'),
    ]);

    for (const sale of position.sales) {
      expect(sum(sale.lots.map((lot) => lot.cost)).toString()).toBe(
        sale.costBasis.toString(),
      );
    }
  });

  it('keeps realized gain equal to the sum of its per-sale parts', () => {
    const position = calculateFifoPosition([
      buy('2026-01-05', 10, '123.4567'),
      buy('2026-02-05', 10, '98.7654'),
      sell('2026-03-05', 13, '150.5', '12.34'),
      sell('2026-04-05', 4, '175.25'),
    ]);

    expect(position.realizedGain.toString()).toBe(
      sum(position.sales.map((s) => s.realizedGain)).toString(),
    );
  });
});

describe('calculateFifoPosition — purity', () => {
  it('does not mutate the trades it is given', () => {
    const trades = [buy('2026-01-05', 10, 100), sell('2026-02-05', 4, 150)];
    const snapshot = JSON.stringify(trades);

    calculateFifoPosition(trades);

    expect(JSON.stringify(trades)).toBe(snapshot);
  });

  it('returns the same result for the same input regardless of array order', () => {
    const trades = [
      buy('2026-01-05', 10, 100),
      buy('2026-02-05', 10, 120),
      sell('2026-03-05', 15, 150),
    ];
    const shuffled = [trades[2]!, trades[0]!, trades[1]!];

    expect(calculateFifoPosition(shuffled).realizedGain.toString()).toBe(
      calculateFifoPosition(trades).realizedGain.toString(),
    );
  });
});
