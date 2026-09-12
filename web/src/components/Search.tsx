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

          // A rate limit is a "wait a moment", not a failure of the search. The
          // previously-shown results are still valid, so they are deliberately
          // left on screen rather than cleared — blanking the list implies the
          // query found nothing, which is a different and wrong message.
          if (e instanceof ApiError && e.status === 429) {
            setError('Searching too quickly — pausing for a moment.');
            return;
          }

          setHits([]);
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
        // Safe to close immediately: pressing a result cannot blur this input,
        // because the list below cancels the blur on mousedown.
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      {error && <div className="err" style={{ marginTop: 6 }}>{error}</div>}
      {open && query.trim() !== '' && (
        <div
          className="results"
          /**
           * Cancel the blur that mousedown would otherwise cause.
           *
           * This is load-bearing, not a nicety. A click is mousedown → mouseup
           * → click. Mousedown on a result blurs the input, and if that blur
           * closes the list, the link unmounts before mouseup and the click
           * lands on nothing — the dropdown shows correct results and
           * selecting one silently does nothing.
           *
           * The previous version deferred closing by 150ms to leave a window
           * for the click to arrive. That made the bug timing-dependent rather
           * than fixing it: a click held longer than 150ms — ordinary for a
           * deliberate press, and anything but rare — still missed. It also
           * passed automated testing, where a synthetic click completes in
           * about a millisecond.
           *
           * preventDefault here stops the input losing focus at all, so there
           * is no window to miss and no timer to tune.
           */
          onMouseDown={(e) => e.preventDefault()}
        >
          {hits.length === 0 && !error ? (
            <div style={{ padding: '9px 12px' }} className="muted">No matches.</div>
          ) : (
            hits.map((hit) => (
              <Link
                key={`${hit.exchange}:${hit.symbol}`}
                to={`/stocks/${hit.exchange}/${hit.symbol}`}
                // Closed explicitly on selection, since the input keeps focus
                // now and will not blur the list shut on its own.
                onClick={() => setOpen(false)}
              >
                <strong>{hit.symbol}</strong> <span className="muted">· {hit.exchange} · {hit.name}</span>
              </Link>
            ))
          )}
        </div>
      )}
    </div>
  );
}
