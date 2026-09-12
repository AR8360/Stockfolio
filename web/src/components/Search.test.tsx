import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Search } from './Search';

/**
 * Regression tests for the search dropdown (IMPLEMENTATION_PLAN.md §6).
 *
 * These exist because of a bug that reached production: selecting a result did
 * nothing. Mousedown on a result blurred the input, the blur handler closed the
 * list, and the link unmounted before mouseup — so the click landed on nothing.
 *
 * The reason it survived manual and automated checking is the reason these
 * tests use `userEvent` rather than `fireEvent.click`: userEvent dispatches the
 * real pointer sequence (pointerdown → mousedown → focus/blur → pointerup →
 * mouseup → click), which is what exposes the race. `fireEvent.click` fires a
 * single synthetic click and would pass against the broken implementation.
 */

function renderSearch() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Search />
      <Routes>
        <Route path="/" element={<div>home</div>} />
        <Route path="/stocks/:exchange/:symbol" element={<div>detail page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const HITS = [
  { symbol: 'RELIANCE', exchange: 'NSE', name: 'Reliance Industries Limited' },
  { symbol: 'RPOWER', exchange: 'NSE', name: 'Reliance Power Limited' },
];

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: HITS }),
      } as Response),
    ),
  );
});

afterEach(() => {
  // Explicit because this config sets globals:false, so testing-library does
  // not auto-register its cleanup hook. Without it every render accumulates
  // and queries match elements from previous tests.
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Search dropdown', () => {
  it('shows results as you type', async () => {
    const user = userEvent.setup();
    renderSearch();

    await user.type(screen.getByRole('searchbox'), 'reliance');

    expect(await screen.findByText('RELIANCE')).toBeDefined();
    expect(screen.getByText('RPOWER')).toBeDefined();
  });

  it('navigates to the stock detail page when a result is clicked', async () => {
    // The exact bug that shipped. userEvent issues a real mousedown before
    // mouseup, so if mousedown closes the list this fails.
    const user = userEvent.setup();
    renderSearch();

    await user.type(screen.getByRole('searchbox'), 'reliance');
    await user.click(await screen.findByText('RELIANCE'));

    expect(await screen.findByText('detail page')).toBeDefined();
  });

  it('keeps the result list mounted through mousedown', async () => {
    // Pins the mechanism rather than only the outcome: the list must survive
    // the blur that mousedown causes, because that is the window the click
    // needs to land in.
    const user = userEvent.setup();
    renderSearch();

    await user.type(screen.getByRole('searchbox'), 'reliance');
    const result = await screen.findByText('RELIANCE');

    await user.pointer({ keys: '[MouseLeft>]', target: result }); // press, no release

    // Hold the press. This delay is the entire point of the test: the shipped
    // bug closed the list 150ms after the blur that mousedown causes, so a
    // press held longer than that unmounted the link before mouseup. Without
    // a real wait here the test completes in about a millisecond and passes
    // against the broken implementation — verified by reverting the fix.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(screen.getByText('RELIANCE')).toBeDefined();

    await user.pointer({ keys: '[/MouseLeft]', target: result }); // release
    expect(await screen.findByText('detail page')).toBeDefined();
  });

  it('closes the dropdown on Escape', async () => {
    const user = userEvent.setup();
    renderSearch();

    await user.type(screen.getByRole('searchbox'), 'reliance');
    await screen.findByText('RELIANCE');

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByText('RELIANCE')).toBeNull();
    });
  });

  it('debounces so a burst of keystrokes issues one request', async () => {
    // Protects the tighter search rate limit (§4.6): live-as-you-type would
    // otherwise fire a request per character.
    const user = userEvent.setup();
    renderSearch();

    await user.type(screen.getByRole('searchbox'), 'reliance');
    await screen.findByText('RELIANCE');

    expect(vi.mocked(fetch).mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('shows no matches when the API returns an empty list', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: [] }),
    } as Response);

    const user = userEvent.setup();
    renderSearch();

    await user.type(screen.getByRole('searchbox'), 'zzzz');

    expect(await screen.findByText('No matches.')).toBeDefined();
  });

  it('surfaces an API error instead of rendering an empty dropdown', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 429,
      json: () =>
        Promise.resolve({ error: { code: 'RATE_LIMITED', message: 'Too many requests.' } }),
    } as Response);

    const user = userEvent.setup();
    renderSearch();

    await user.type(screen.getByRole('searchbox'), 'reliance');

    expect(await screen.findByText(/Too many requests/)).toBeDefined();
  });
});
