import { z } from 'zod';

/**
 * Request validation at the route boundary (IMPLEMENTATION_PLAN.md §5).
 *
 * Every schema is `.strict()`: an unknown field is rejected rather than
 * silently dropped, so a client sending `pricee` learns about the typo instead
 * of having a trade recorded at the default.
 */

/** Money and quantity arrive as strings and stay strings all the way to the
 *  NUMERIC column. Parsing them into JS numbers at the boundary would discard
 *  precision before any decimal library ever sees them — the exact failure the
 *  whole money-type discipline exists to prevent (ASSUMPTIONS.md #20). */
const decimalString = (label: string, { min = 0, allowZero = false } = {}) =>
  z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,4})?$/, `${label} must be a number with up to 4 decimal places`)
    .refine((v) => (allowZero ? Number(v) >= min : Number(v) > min), {
      message: allowZero ? `${label} cannot be negative` : `${label} must be greater than zero`,
    });

const symbol = z
  .string()
  .trim()
  .min(1)
  .max(30)
  .regex(/^[A-Za-z0-9&.\-]+$/, 'Invalid symbol')
  .transform((v) => v.toUpperCase());

const exchange = z.enum(['NSE', 'BSE']);

/** Rejects a future-dated trade. A trade that has not happened yet cannot be
 *  valued and would corrupt the FIFO replay's ordering assumptions. */
const tradeDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Invalid date')
  .refine((v) => new Date(`${v}T00:00:00Z`).getTime() <= Date.now(), 'Date cannot be in the future');

export const registerSchema = z
  .object({
    email: z.string().trim().email('A valid email is required').max(255),
    // 8 minimum, and a 72-byte ceiling because bcrypt silently truncates
    // beyond that — a longer password would appear accepted while only its
    // first 72 bytes were ever checked.
    password: z.string().min(8, 'Password must be at least 8 characters').max(72),
    name: z.string().trim().min(1, 'Name is required').max(100),
  })
  .strict();

export const loginSchema = z
  .object({
    email: z.string().trim().email().max(255),
    password: z.string().min(1).max(72),
  })
  .strict();

export const createTransactionSchema = z
  .object({
    symbol,
    exchange,
    type: z.enum(['BUY', 'SELL']),
    quantity: decimalString('Quantity'),
    price: decimalString('Price'),
    fees: decimalString('Fees', { allowZero: true }).default('0'),
    txnDate: tradeDate,
  })
  .strict()
  // Whole shares on Indian exchanges (ASSUMPTIONS.md #7). Conditional on the
  // exchange rather than global, matching the database CHECK exactly — the two
  // layers enforce the same rule, not two subtly different ones.
  .refine(
    (v) => !['NSE', 'BSE'].includes(v.exchange) || Number.isInteger(Number(v.quantity)),
    { message: 'NSE and BSE trade whole shares only', path: ['quantity'] },
  );

export const updateTransactionSchema = z
  .object({
    type: z.enum(['BUY', 'SELL']),
    quantity: decimalString('Quantity'),
    price: decimalString('Price'),
    fees: decimalString('Fees', { allowZero: true }).default('0'),
    txnDate: tradeDate,
  })
  .strict();

export const searchQuerySchema = z
  .object({ q: z.string().trim().min(1, 'A search term is required').max(50) })
  .strict();

export const symbolParamsSchema = z.object({ exchange, symbol }).strict();

export const historyQuerySchema = z
  .object({ range: z.enum(['1mo', '3mo', '6mo', '1y', '5y']).default('6mo') })
  .strict();

export const idParamsSchema = z
  .object({ id: z.string().regex(/^\d+$/, 'Invalid id') })
  .strict();

/** The idempotency key is a header, not a body field, but it is external input
 *  and gets the same treatment. */
export const idempotencyKeySchema = z
  .string({ required_error: 'Idempotency-Key header is required' })
  .uuid('Idempotency-Key must be a UUID');
