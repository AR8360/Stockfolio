import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, ApiError, type Holding, type Summary, type Transaction } from '../api/client';
import { TradeForm } from '../components/TradeForm';
import { formatMoney } from './HomePage';

export function PortfolioPage() {
  const [holdings, setHoldings] = useState<Holding[] | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback((signal?: AbortSignal) => {
    setError(null);
    return Promise.all([
      api<Holding[]>('/api/portfolio/holdings', { signal }),
      api<Summary>('/api/portfolio/summary', { signal }),
      api<Transaction[]>('/api/portfolio/transactions', { signal }),
    ])
      .then(([h, s, t]) => { setHoldings(h); setSummary(s); setTransactions(t); })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof ApiError ? e.message : 'Could not load your portfolio.');
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function onDelete(transaction: Transaction) {
    if (!confirm(`Delete this ${transaction.type} of ${transaction.quantity} ${transaction.symbol}?`)) return;
    setBusyId(transaction.id);
    setError(null);
    try {
      await api(`/api/portfolio/transactions/${transaction.id}`, { method: 'DELETE' });
      await load();
    } catch (e: unknown) {
      // The most interesting failure: deleting a BUY that later SELLs depend
      // on is rejected server-side and the message names the problem.
      setError(e instanceof ApiError ? e.message : 'Could not delete that trade.');
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <div className="empty">Loading your portfolio…</div>;

  const isEmpty = transactions.length === 0;

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
        <h1 style={{ margin: 0 }}>Your portfolio</h1>
        <button className="btn" onClick={() => { setEditing(null); setFormOpen(true); }}>Log a trade</button>
      </div>

      {error && <div className="banner error">{error}</div>}
      {summary?.pricesStale && (
        <div className="banner warn">
          Some prices could not be refreshed and may be delayed. Quantities, cost
          basis and realized gain are computed from your own trades and are unaffected.
        </div>
      )}

      {isEmpty ? (
        // New users see a prompt, not a blank table (ASSUMPTIONS.md #10).
        <div className="panel empty">
          <h3>No trades yet</h3>
          <p className="muted">Log your first trade to see holdings and gain/loss.</p>
          <button className="btn" onClick={() => { setEditing(null); setFormOpen(true); }}>Log your first trade</button>
        </div>
      ) : (
        <>
          {summary && (
            <section className="panel row" style={{ gap: 40, marginBottom: 20 }}>
              <div className="stat">
                <span className="label">Invested</span>
                <span className="value">₹{formatMoney(summary.costBasis)}</span>
              </div>
              <div className="stat">
                <span className="label">Market value</span>
                <span className="value">{summary.marketValue === null ? '—' : `₹${formatMoney(summary.marketValue)}`}</span>
              </div>
              {/* Realized and unrealized are shown separately, never merged
                  into one ambiguous figure (ASSUMPTIONS.md #4). */}
              <div className="stat">
                <span className="label">Unrealized</span>
                <span className={`value ${signClass(summary.unrealizedGain)}`}>{signed(summary.unrealizedGain)}</span>
              </div>
              <div className="stat">
                <span className="label">Realized</span>
                <span className={`value ${signClass(summary.realizedGain)}`}>{signed(summary.realizedGain)}</span>
              </div>
              <div className="stat">
                <span className="label">Total</span>
                <span className={`value ${signClass(summary.totalGain)}`}>{signed(summary.totalGain)}</span>
              </div>
            </section>
          )}

          <section style={{ marginBottom: 24 }}>
            <h2>Holdings</h2>
            {holdings && holdings.length > 0 ? (
              <div className="panel table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Stock</th><th>Qty</th><th>Avg cost</th><th>Invested</th>
                      <th>Price</th><th>Value</th><th>Unrealized</th><th>Realized</th>
                    </tr>
                  </thead>
                  <tbody>
                    {holdings.map((h) => (
                      <tr key={`${h.exchange}:${h.symbol}`}>
                        <td>
                          <Link to={`/stocks/${h.exchange}/${h.symbol}`}><strong>{h.symbol}</strong></Link>
                          <div className="muted" style={{ fontSize: 12 }}>{h.name}</div>
                        </td>
                        <td>{h.quantity}</td>
                        <td>{formatMoney(h.averageCost)}</td>
                        <td>{formatMoney(h.costBasis)}</td>
                        <td>
                          {h.currentPrice === null ? '—' : formatMoney(h.currentPrice)}
                          {h.priceStale && <div className="stale">delayed</div>}
                        </td>
                        <td>{h.marketValue === null ? '—' : formatMoney(h.marketValue)}</td>
                        <td className={signClass(h.unrealizedGain)}>
                          {signed(h.unrealizedGain)}
                          {h.unrealizedGainPercent !== null && (
                            <div style={{ fontSize: 12 }}>
                              {Number(h.unrealizedGainPercent) >= 0 ? '+' : ''}{h.unrealizedGainPercent}%
                            </div>
                          )}
                        </td>
                        <td className={signClass(h.realizedGain)}>{signed(h.realizedGain)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              // Every position closed: holdings is empty but realized gain
              // still counts (ASSUMPTIONS.md #5).
              <div className="panel empty">
                <p className="muted">No open positions — every holding has been sold.</p>
              </div>
            )}
          </section>

          <section>
            <h2>Trade history</h2>
            <div className="panel table-wrap">
              <table>
                <thead>
                  <tr><th>Date</th><th>Stock</th><th>Type</th><th>Qty</th><th>Price</th><th>Fees</th><th>Total</th><th /></tr>
                </thead>
                <tbody>
                  {transactions.map((t) => (
                    <tr key={t.id}>
                      <td>{t.txnDate}</td>
                      <td><strong>{t.symbol}</strong> <span className="muted">{t.exchange}</span></td>
                      <td className={t.type === 'BUY' ? 'up' : 'down'}>{t.type}</td>
                      <td>{t.quantity}</td>
                      <td>{formatMoney(t.price)}</td>
                      <td className="muted">{formatMoney(t.fees)}</td>
                      <td>{formatMoney(String(Number(t.quantity) * Number(t.price)))}</td>
                      <td>
                        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
                          <button className="btn ghost small" disabled={busyId === t.id}
                            onClick={() => { setEditing(t); setFormOpen(true); }}>Edit</button>
                          <button className="btn danger small" disabled={busyId === t.id}
                            onClick={() => void onDelete(t)}>{busyId === t.id ? '…' : 'Delete'}</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {formOpen && (
        <TradeForm
          editing={editing}
          onClose={() => { setFormOpen(false); setEditing(null); }}
          onSaved={() => void load()}
        />
      )}
    </>
  );
}

function signed(value: string | null): string {
  if (value === null) return '—';
  const n = Number(value);
  return `${n >= 0 ? '+' : '−'}₹${formatMoney(String(Math.abs(n)))}`;
}

function signClass(value: string | null): string {
  if (value === null) return 'muted';
  return Number(value) >= 0 ? 'up' : 'down';
}
