import { describe, expect, it } from 'vitest';

import { assertChronologicalSell, type LedgerEntry } from './chronological.js';
import { Decimal } from './money.js';
import { AppError } from '../errors/AppError.js';

/** Tier 1 (IMPLEMENTATION_PLAN.md §8): pure, no mocks, no database. */

const entry = (type: 'BUY' | 'SELL', date: string, quantity: number): LedgerEntry => ({
  type,
  quantity: new Decimal(quantity),
  date: new Date(`${date}T00:00:00Z`),
});

const proposed = (date: string, quantity: number) => ({
  date: new Date(`${date}T00:00:00Z`),
  quantity: new Decimal(quantity),
});

function reject(ledger: LedgerEntry[], sell: ReturnType<typeof proposed>): AppError {
  try {
    assertChronologicalSell(ledger, sell);
  } catch (error) {
    return error as AppError;
  }
  throw new Error('expected the sell to be rejected');
}

describe('assertChronologicalSell — straightforward cases', () => {
  it('accepts a sell covered by an earlier buy', () => {
    expect(() =>
      assertChronologicalSell([entry('BUY', '2026-01-10', 100)], proposed('2026-02-10', 50)),
    ).not.toThrow();
  });

  it('accepts a sell that exactly empties the position', () => {
    expect(() =>
      assertChronologicalSell([entry('BUY', '2026-01-10', 100)], proposed('2026-02-10', 100)),
    ).not.toThrow();
  });

  it('rejects a sell with no holdings at all', () => {
    const error = reject([], proposed('2026-01-10', 1));
    expect(error.code).toBe('INSUFFICIENT_HOLDINGS');
    expect(error.details).toMatchObject({ reason: 'NOT_HELD_ON_DATE', available: '0' });
  });

  it('rejects a sell larger than the holding on that date', () => {
    const error = reject([entry('BUY', '2026-01-10', 40)], proposed('2026-02-10', 50));
    expect(error.details).toMatchObject({ reason: 'NOT_HELD_ON_DATE', available: '40' });
  });

  it('rejects a sell dated before the buy that would cover it', () => {
    // Shares bought in March cannot be sold in January.
    const error = reject([entry('BUY', '2026-03-10', 100)], proposed('2026-01-10', 10));
    expect(error.details).toMatchObject({ reason: 'NOT_HELD_ON_DATE', available: '0' });
  });

  it('counts a buy made on the same day as the sell', () => {
    // Day-level granularity (ASSUMPTIONS.md #3) means same-day buy-then-sell is
    // allowed; there is no intraday ordering to violate.
    expect(() =>
      assertChronologicalSell([entry('BUY', '2026-01-10', 100)], proposed('2026-01-10', 100)),
    ).not.toThrow();
  });
});

describe('assertChronologicalSell — the backdated case', () => {
  const ledger = [entry('BUY', '2026-01-10', 100), entry('SELL', '2026-03-10', 100)];

  it('rejects a backdated sell that makes a later date negative', () => {
    // The scenario this function exists for: on 10 Feb the user genuinely held
    // 100 shares, so a same-date check passes — but the 10 Mar sale already
    // disposed of all of them, so accepting this leaves -50 from March onward.
    const error = reject(ledger, proposed('2026-02-10', 50));

    expect(error.code).toBe('INSUFFICIENT_HOLDINGS');
    expect(error.details).toMatchObject({
      reason: 'WOULD_GO_NEGATIVE_LATER',
      conflictDate: '2026-03-10',
      availableThen: '0',
    });
  });

  it('names the specific later date that would go negative', () => {
    const error = reject(
      [
        entry('BUY', '2026-01-10', 100),
        entry('SELL', '2026-02-10', 30),
        entry('SELL', '2026-04-10', 60),
      ],
      proposed('2026-01-15', 20),
    );

    // Balances: Jan 10 -> 100, Feb 10 -> 70, Apr 10 -> 10. Selling 20 on Jan 15
    // is fine until April, where only 10 remain.
    expect(error.details).toMatchObject({
      conflictDate: '2026-04-10',
      availableThen: '10',
    });
  });

  it('accepts a backdated sell that stays non-negative throughout', () => {
    expect(() =>
      assertChronologicalSell(
        [entry('BUY', '2026-01-10', 100), entry('SELL', '2026-03-10', 40)],
        proposed('2026-02-10', 60),
      ),
    ).not.toThrow();
  });

  it('takes the minimum across the whole future, not just the next date', () => {
    // Balance dips at the far end. Checking only the next date after the sell
    // would wrongly accept this.
    const error = reject(
      [
        entry('BUY', '2026-01-10', 100),
        entry('BUY', '2026-02-10', 100),
        entry('SELL', '2026-05-10', 190),
      ],
      proposed('2026-03-10', 50),
    );

    expect(error.details).toMatchObject({
      conflictDate: '2026-05-10',
      availableThen: '10',
    });
  });

  it('allows a sell when a later buy replenishes the balance', () => {
    // A dip that recovers is still a dip, but here there is no dip at all:
    // balances stay at or above 50 from February onward.
    expect(() =>
      assertChronologicalSell(
        [
          entry('BUY', '2026-01-10', 100),
          entry('SELL', '2026-03-10', 50),
          entry('BUY', '2026-04-10', 200),
        ],
        proposed('2026-02-10', 50),
      ),
    ).not.toThrow();
  });

  it('does not let a later buy rescue an earlier negative balance', () => {
    // Balance would be -10 between March and April even though April's buy
    // restores it. A ledger that goes negative at any point is invalid.
    const error = reject(
      [entry('BUY', '2026-01-10', 100), entry('SELL', '2026-03-10', 60), entry('BUY', '2026-04-10', 500)],
      proposed('2026-02-10', 50),
    );

    expect(error.details).toMatchObject({ conflictDate: '2026-03-10' });
  });
});

describe('assertChronologicalSell — aggregation and ordering', () => {
  it('nets multiple trades recorded on the same day', () => {
    expect(() =>
      assertChronologicalSell(
        [
          entry('BUY', '2026-01-10', 100),
          entry('SELL', '2026-01-10', 40),
          entry('BUY', '2026-01-10', 10),
        ],
        proposed('2026-02-10', 70),
      ),
    ).not.toThrow();

    const error = reject(
      [entry('BUY', '2026-01-10', 100), entry('SELL', '2026-01-10', 40), entry('BUY', '2026-01-10', 10)],
      proposed('2026-02-10', 71),
    );
    expect(error.details).toMatchObject({ available: '70' });
  });

  it('does not depend on the order entries are supplied in', () => {
    const ordered = [
      entry('BUY', '2026-01-10', 100),
      entry('SELL', '2026-03-10', 100),
    ];
    const reversed = [...ordered].reverse();

    const a = reject(ordered, proposed('2026-02-10', 50));
    const b = reject(reversed, proposed('2026-02-10', 50));

    expect(a.details).toEqual(b.details);
  });

  it('orders days correctly across month and year boundaries', () => {
    // Guards the ISO-key sort: any format where "2026-09-02" sorts before
    // "2026-10-01" only by luck would break here.
    const error = reject(
      [
        entry('BUY', '2026-09-02', 100),
        entry('SELL', '2026-10-01', 40),
        entry('SELL', '2027-01-05', 60),
      ],
      proposed('2026-09-30', 10),
    );

    expect(error.details).toMatchObject({ conflictDate: '2027-01-05', availableThen: '0' });
  });

  it('handles fractional quantities without float error', () => {
    // Whole shares are enforced for NSE/BSE at the boundary, but the ledger is
    // market-agnostic (ASSUMPTIONS.md #7) and must stay exact regardless.
    expect(() =>
      assertChronologicalSell(
        [entry('BUY', '2026-01-10', 0.1), entry('BUY', '2026-01-11', 0.2)],
        { date: new Date('2026-02-10T00:00:00Z'), quantity: new Decimal('0.3') },
      ),
    ).not.toThrow();
  });
});
