import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { api, ApiError, type Quote } from '../api/client';
import { formatMoney } from './HomePage';

interface Candle { date: string; close: string; high: string; low: string; volume: number }

export function StockPage() {
  const { exchange = '', symbol = '' } = useParams();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [history, setHistory] = useState<Candle[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    Promise.all([
      api<Quote>(`/api/stocks/${exchange}/${symbol}`, { signal: controller.signal }),
      // History is secondary: a failure here must not blank the quote, so it
      // is caught separately rather than failing the whole page.
      api<Candle[]>(`/api/stocks/${exchange}/${symbol}/history?range=6mo`, { signal: controller.signal })
        .catch(() => [] as Candle[]),
    ])
      .then(([q, h]) => { setQuote(q); setHistory(h); })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(e instanceof ApiError ? e.message : 'Could not load this stock.');
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [exchange, symbol]);

  if (loading) return <div className="empty">Loading {symbol}…</div>;
  if (error) return (
    <>
      <div className="banner error">{error}</div>
      <Link className="btn ghost" to="/">Back to dashboard</Link>
    </>
  );
  if (!quote) return <div className="empty">Not found.</div>;

  const up = Number(quote.changePercent) >= 0;

  return (
    <>
      <Link to="/" className="muted" style={{ textDecoration: 'none' }}>← Dashboard</Link>
      <h1 style={{ marginTop: 12 }}>{quote.symbol} <span className="muted">· {quote.exchange}</span></h1>
      <p className="muted" style={{ marginTop: 0 }}>{quote.name}</p>

      <div className="panel row" style={{ gap: 40, marginBottom: 20 }}>
        <div className="stat">
          <span className="label">Last price</span>
          <span className="value">{quote.currency === 'INR' ? '₹' : ''}{formatMoney(quote.price)}</span>
        </div>
        <div className="stat">
          <span className="label">Change</span>
          <span className={`value ${up ? 'up' : 'down'}`}>
            {up ? '+' : ''}{formatMoney(quote.change)} ({up ? '+' : ''}{quote.changePercent}%)
          </span>
        </div>
        <div className="stat">
          <span className="label">Previous close</span>
          <span className="value">{formatMoney(quote.previousClose)}</span>
        </div>
        <div className="stat">
          <span className="label">Volume</span>
          <span className="value">{quote.volume.toLocaleString('en-IN')}</span>
        </div>
      </div>
      <p className="muted" style={{ fontSize: 12, marginTop: -10 }}>
        As of {new Date(quote.asOf).toLocaleString()}. After hours this is the day's close,
        which is correct rather than stale — the price cannot move while the market is shut.
      </p>

      <section className="panel" style={{ marginTop: 20 }}>
        <h2>Last 6 months</h2>
        {history.length === 0 ? (
          <p className="muted">History unavailable.</p>
        ) : (
          <>
            <Sparkline candles={history} />
            <div className="table-wrap" style={{ marginTop: 12, maxHeight: 260, overflowY: 'auto' }}>
              <table>
                <thead><tr><th>Date</th><th>Close</th><th>High</th><th>Low</th></tr></thead>
                <tbody>
                  {[...history].reverse().slice(0, 30).map((c) => (
                    <tr key={c.date}>
                      <td>{c.date}</td>
                      <td>{formatMoney(c.close)}</td>
                      <td className="muted">{formatMoney(c.high)}</td>
                      <td className="muted">{formatMoney(c.low)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
    </>
  );
}

/** Inline SVG rather than a charting library: one dependency less to ship and
 *  the only thing needed here is the shape of the trend. */
function Sparkline({ candles }: { candles: Candle[] }) {
  const values = candles.map((c) => Number(c.close));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const width = 900;
  const height = 140;

  const points = values
    .map((v, i) => {
      const x = (i / Math.max(values.length - 1, 1)) * width;
      const y = height - ((v - min) / span) * (height - 10) - 5;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');

  const rising = values[values.length - 1]! >= values[0]!;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ width: '100%', height: 140 }}>
      <polyline
        points={points}
        fill="none"
        stroke={rising ? 'var(--up)' : 'var(--down)'}
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
