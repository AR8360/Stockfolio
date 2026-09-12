import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, ApiError, type Mover, type Overview } from '../api/client';
import { Search } from '../components/Search';

/**
 * Public dashboard: today's movers plus search (IMPLEMENTATION_PLAN.md §6).
 *
 * Page-local state with an explicit status rather than a single boolean, so
 * "still loading" and "loaded, nothing here" are distinguishable
 * (ASSUMPTIONS.md #28).
 */
type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'success'; overview: Overview };

export function HomePage() {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();

    api<Overview>('/api/stocks/overview', { signal: controller.signal })
      .then((overview) => setState({ status: 'success', overview }))
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setState({
          status: 'error',
          message: e instanceof ApiError ? e.message : 'Could not load market data.',
        });
      });

    return () => controller.abort();
  }, []);

  return (
    <>
      <div style={{ marginBottom: 20 }}>
        <h1>Today on the NSE</h1>
        <p className="muted" style={{ marginTop: 0 }}>
          Top movers across the Nifty 50, and search for any listed stock.
        </p>
        <Search />
      </div>

      {state.status === 'loading' && <div className="empty">Loading market data…</div>}

      {state.status === 'error' && (
        <div className="banner error">
          {state.message} Market data comes from an unofficial source, so this can
          happen — reload to try again.
        </div>
      )}

      {state.status === 'success' && (
        <>
          <div className="grid-3">
            <MoverList title="Top gainers" movers={state.overview.gainers} />
            <MoverList title="Top losers" movers={state.overview.losers} />
            <MoverList title="Most active" movers={state.overview.mostActive} showVolume />
          </div>
          <p className="muted" style={{ marginTop: 16, fontSize: 12 }}>
            Ranked from {state.overview.sampled} Nifty 50 constituents
            {state.overview.asOf ? ` · prices as of ${new Date(state.overview.asOf).toLocaleString()}` : ''}
          </p>
        </>
      )}
    </>
  );
}

function MoverList({ title, movers, showVolume = false }: { title: string; movers: Mover[]; showVolume?: boolean }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {movers.length === 0 ? (
        <p className="muted">No data.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <tbody>
              {movers.map((m) => (
                <tr key={`${m.exchange}:${m.symbol}`}>
                  <td>
                    <Link to={`/stocks/${m.exchange}/${m.symbol}`}>
                      <strong>{m.symbol}</strong>
                    </Link>
                  </td>
                  <td>{formatMoney(m.price)}</td>
                  <td className={Number(m.changePercent) >= 0 ? 'up' : 'down'}>
                    {Number(m.changePercent) >= 0 ? '+' : ''}{m.changePercent}%
                  </td>
                  {showVolume && <td className="muted">{formatVolume(m.volume)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function formatMoney(value: string | null): string {
  if (value === null) return '—';
  return Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatVolume(volume: number): string {
  if (volume >= 1e7) return `${(volume / 1e7).toFixed(1)}Cr`;
  if (volume >= 1e5) return `${(volume / 1e5).toFixed(1)}L`;
  return volume.toLocaleString('en-IN');
}
