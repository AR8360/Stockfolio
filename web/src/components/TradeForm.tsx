import { useRef, useState, type FormEvent } from 'react';

import { api, ApiError, type Transaction } from '../api/client';

/**
 * Add or edit a trade (IMPLEMENTATION_PLAN.md §6).
 *
 * The client half of the idempotency system (ASSUMPTIONS.md #22): a UUID is
 * generated lazily, right before the first submission rather than on form
 * open, and is deliberately NOT regenerated when a submission fails — so
 * retrying after a network blip reuses the key and the server replays its
 * stored response instead of recording the trade twice. It is invalidated only
 * when a field changes, because that makes it a genuinely different request.
 */

export interface TradeFormValues {
  symbol: string;
  exchange: string;
  type: 'BUY' | 'SELL';
  quantity: string;
  price: string;
  fees: string;
  txnDate: string;
}

const today = (): string => new Date().toISOString().slice(0, 10);

const blank: TradeFormValues = {
  symbol: '', exchange: 'NSE', type: 'BUY',
  quantity: '', price: '', fees: '0', txnDate: today(),
};

export function TradeForm({
  editing,
  onClose,
  onSaved,
}: {
  editing: Transaction | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [values, setValues] = useState<TradeFormValues>(
    editing
      ? {
          symbol: editing.symbol, exchange: editing.exchange, type: editing.type,
          quantity: editing.quantity, price: editing.price, fees: editing.fees,
          txnDate: editing.txnDate,
        }
      : blank,
  );
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const idempotencyKey = useRef<string | null>(null);

  function update<K extends keyof TradeFormValues>(key: K, value: TradeFormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
    // Changed field means a different request, so the old key must not be
    // reused — the server would otherwise replay the previous response.
    idempotencyKey.current = null;
    setFieldErrors({});
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    setSubmitting(true);

    try {
      if (editing) {
        await api<Transaction>(`/api/portfolio/transactions/${editing.id}`, {
          method: 'PATCH',
          body: {
            type: values.type, quantity: values.quantity, price: values.price,
            fees: values.fees || '0', txnDate: values.txnDate,
          },
        });
      } else {
        idempotencyKey.current ??= crypto.randomUUID();
        await api<Transaction>('/api/portfolio/transactions', {
          method: 'POST',
          headers: { 'Idempotency-Key': idempotencyKey.current },
          body: { ...values, symbol: values.symbol.toUpperCase(), fees: values.fees || '0' },
        });
      }
      onSaved();
      onClose();
    } catch (e: unknown) {
      if (e instanceof ApiError) {
        setError(e.message);
        if (e.details && typeof e.details === 'object') {
          setFieldErrors(e.details as Record<string, string[]>);
        }
      } else {
        setError('Something went wrong.');
      }
      // Note: the key is NOT cleared here. This failure might have been a lost
      // response to a write that actually succeeded, and reusing the key is
      // what makes the retry safe.
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{editing ? 'Edit trade' : 'Log a trade'}</h3>

        {error && <div className="banner error">{error}</div>}

        <form onSubmit={onSubmit} className="form-grid">
          <div className="field">
            <label htmlFor="symbol">Symbol</label>
            <input
              id="symbol" value={values.symbol} required disabled={editing !== null}
              placeholder="RELIANCE"
              onChange={(e) => update('symbol', e.target.value.toUpperCase())}
            />
            <FieldError errors={fieldErrors.symbol} />
          </div>

          <div className="field">
            <label htmlFor="exchange">Exchange</label>
            <select id="exchange" value={values.exchange} disabled={editing !== null}
              onChange={(e) => update('exchange', e.target.value)}>
              <option value="NSE">NSE</option>
              <option value="BSE">BSE</option>
            </select>
          </div>

          <div className="field">
            <label htmlFor="type">Type</label>
            <select id="type" value={values.type} onChange={(e) => update('type', e.target.value as 'BUY' | 'SELL')}>
              <option value="BUY">Buy</option>
              <option value="SELL">Sell</option>
            </select>
          </div>

          <div className="field">
            <label htmlFor="quantity">Quantity</label>
            {/* step=1: NSE and BSE trade whole shares (ASSUMPTIONS.md #7).
                The server enforces this too — this is only a nicer keyboard. */}
            <input id="quantity" type="number" min="1" step="1" value={values.quantity} required
              onChange={(e) => update('quantity', e.target.value)} />
            <FieldError errors={fieldErrors.quantity} />
          </div>

          <div className="field">
            <label htmlFor="price">Price per share</label>
            <input id="price" type="number" min="0.0001" step="0.0001" value={values.price} required
              onChange={(e) => update('price', e.target.value)} />
            <FieldError errors={fieldErrors.price} />
          </div>

          <div className="field">
            <label htmlFor="fees">Fees &amp; charges</label>
            <input id="fees" type="number" min="0" step="0.01" value={values.fees}
              onChange={(e) => update('fees', e.target.value)} />
            <FieldError errors={fieldErrors.fees} />
          </div>

          <div className="field full">
            <label htmlFor="txnDate">Trade date</label>
            <input id="txnDate" type="date" max={today()} value={values.txnDate} required
              onChange={(e) => update('txnDate', e.target.value)} />
            <FieldError errors={fieldErrors.txnDate} />
          </div>

          <div className="full row" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            {/* Disabled while in flight — belt and braces alongside the full
                idempotency system, against a plain double-click. */}
            <button type="submit" className="btn" disabled={submitting}>
              {submitting ? 'Saving…' : editing ? 'Save changes' : 'Add trade'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function FieldError({ errors }: { errors?: string[] | undefined }) {
  if (!errors || errors.length === 0) return null;
  return <span className="err">{errors.join(', ')}</span>;
}
