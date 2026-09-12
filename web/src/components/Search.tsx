import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, ApiError, type SearchHit } from '../api/client';

/**
 * Live-as-you-type search (ASSUMPTIONS.md #29).
 *
 * Three things make this behave under fast typing:
 *  - a 300ms debounce, so a burst of keystrokes fires one request;
 *  - AbortController, so an in-flight request is genuinely cancelled rather
 *    than merely ignored when it lands — that is what keeps the tighter search
 *    rate limit (§4.6) from being hit by ordinary typing;
 *  - a monotonic sequence guard, so a slow response that was not aborted in
 *    time cannot overwrite a newer one. This was listed as a nice-to-have; it
 *    is four lines and prevents a visibly wrong result list.
 */
export function Search() {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const latest = useRef(0);

  useEffect(() => {
    const term = query.trim();
    if (term.length === 0) {
      setHits([]);
      setError(null);
      return;
    }

    const controller = new AbortController();
    const sequence = ++latest.current;

    const timer = setTimeout(() => {
      api<SearchHit[]>(`/api/stocks/search?q=${encodeURIComponent(term)}`, { signal: controller.signal })
        .then((results) => {
          if (sequence !== latest.current) return; // a newer query already won
          setHits(results);
          setError(null);
          setOpen(true);
        })
        .catch((e: unknown) => {
          if (e instanceof DOMException && e.name === 'AbortError') return;
          if (sequence !== latest.current) return;
          setError(e instanceof ApiError ? e.message : 'Search failed.');
        });
    }, 300);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  return (
    <div className="search-wrap">
      <input
        type="search"
        value={query}
        placeholder="Search NSE / BSE stocks…"
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setOpen(true)}
        // A click on a result must land before the list closes, so closing is
        // deferred past the blur.
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {error && <div className="err" style={{ marginTop: 6 }}>{error}</div>}
      {open && query.trim() !== '' && (
        <div className="results">
          {hits.length === 0 && !error ? (
            <div style={{ padding: '9px 12px' }} className="muted">No matches.</div>
          ) : (
            hits.map((hit) => (
              <Link key={`${hit.exchange}:${hit.symbol}`} to={`/stocks/${hit.exchange}/${hit.symbol}`}>
                <strong>{hit.symbol}</strong> <span className="muted">· {hit.exchange} · {hit.name}</span>
              </Link>
            ))
          )}
        </div>
      )}
    </div>
  );
}
