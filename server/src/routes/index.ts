import { Router, type Request, type Response, type NextFunction } from 'express';

import { authenticate, requireUserId } from '../middleware/authenticate.js';
import { publicLimiter, searchLimiter } from '../middleware/rateLimit.js';
import { badRequest } from '../errors/AppError.js';
import { checkDatabaseConnection } from '../database/pool.js';
import type { AuthService } from '../services/AuthService.js';
import type { DashboardService } from '../services/DashboardService.js';
import type { PortfolioService } from '../services/PortfolioService.js';
import type { TransactionService } from '../services/TransactionService.js';
import type { MarketDataService } from '../providers/types.js';
import {
  createTransactionSchema,
  historyQuerySchema,
  idParamsSchema,
  idempotencyKeySchema,
  loginSchema,
  registerSchema,
  searchQuerySchema,
  symbolParamsSchema,
  updateTransactionSchema,
} from './schemas.js';

/**
 * HTTP layer (IMPLEMENTATION_PLAN.md §5).
 *
 * Routes parse, validate and delegate. No business logic, no SQL, no
 * try/catch — the error middleware translates every throw, including ZodErrors
 * (§4.2), which is what keeps these handlers this short.
 */

export interface Services {
  auth: AuthService;
  transactions: TransactionService;
  portfolio: PortfolioService;
  dashboard: DashboardService;
  marketData: MarketDataService;
}

/** Express 4 does not forward a rejected promise from an async handler to the
 *  error middleware; it would hang instead. This adapter is what makes `throw`
 *  work uniformly in async routes. */
const wrap =
  (handler: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res).catch(next);
  };

export function createRouter(services: Services): Router {
  const router = Router();

  // Verifies a real database round trip, not just that the process is alive
  // (ASSUMPTIONS.md #30) — the platform's health check depends on the
  // difference.
  router.get(
    '/health',
    wrap(async (_req, res) => {
      const databaseUp = await checkDatabaseConnection();
      res.status(databaseUp ? 200 : 503).json({
        data: { status: databaseUp ? 'ok' : 'degraded', database: databaseUp },
      });
    }),
  );

  /* ------------------------------- auth ------------------------------- */

  router.post(
    '/api/auth/register',
    publicLimiter,
    wrap(async (req, res) => {
      const input = registerSchema.parse(req.body);
      res.status(201).json({ data: await services.auth.register(input) });
    }),
  );

  router.post(
    '/api/auth/login',
    publicLimiter,
    wrap(async (req, res) => {
      const input = loginSchema.parse(req.body);
      res.json({ data: await services.auth.login(input) });
    }),
  );

  router.get(
    '/api/auth/me',
    authenticate,
    wrap(async (req, res) => {
      res.json({ data: await services.auth.getCurrentUser(requireUserId(req)) });
    }),
  );

  /* ------------------------------ stocks ------------------------------ */

  router.get(
    '/api/stocks/overview',
    publicLimiter,
    wrap(async (_req, res) => {
      res.json({ data: await services.dashboard.getOverview() });
    }),
  );

  router.get(
    '/api/stocks/search',
    searchLimiter,
    wrap(async (req, res) => {
      const { q } = searchQuerySchema.parse(req.query);
      res.json({ data: await services.marketData.search(q) });
    }),
  );

  router.get(
    '/api/stocks/:exchange/:symbol',
    publicLimiter,
    wrap(async (req, res) => {
      const ref = symbolParamsSchema.parse(req.params);
      const quote = await services.marketData.getQuote(ref);
      res.json({
        data: {
          symbol: quote.symbol,
          exchange: quote.exchange,
          name: quote.name,
          currency: quote.currency,
          price: quote.price.toString(),
          previousClose: quote.previousClose.toString(),
          change: quote.change.toString(),
          changePercent: quote.changePercent.toDecimalPlaces(2).toString(),
          volume: quote.volume,
          asOf: quote.asOf.toISOString(),
        },
      });
    }),
  );

  router.get(
    '/api/stocks/:exchange/:symbol/history',
    publicLimiter,
    wrap(async (req, res) => {
      const ref = symbolParamsSchema.parse(req.params);
      const { range } = historyQuerySchema.parse(req.query);
      const candles = await services.marketData.getDailyHistory(ref, range);
      res.json({
        data: candles.map((c) => ({
          date: c.date.toISOString().slice(0, 10),
          close: c.close.toString(),
          high: c.high.toString(),
          low: c.low.toString(),
          volume: c.volume,
        })),
      });
    }),
  );

  /* ----------------------------- portfolio ---------------------------- */

  router.get(
    '/api/portfolio/holdings',
    authenticate,
    wrap(async (req, res) => {
      res.json({ data: await services.portfolio.getHoldings(requireUserId(req)) });
    }),
  );

  router.get(
    '/api/portfolio/summary',
    authenticate,
    wrap(async (req, res) => {
      res.json({ data: await services.portfolio.getSummary(requireUserId(req)) });
    }),
  );

  router.get(
    '/api/portfolio/transactions',
    authenticate,
    wrap(async (req, res) => {
      const rows = await services.portfolio.listTransactions(requireUserId(req));
      res.json({
        data: rows.map((r) => ({
          id: r.id,
          symbol: r.symbol,
          exchange: r.exchange,
          name: r.instrument_name,
          type: r.type,
          quantity: r.quantity,
          price: r.price,
          fees: r.fees,
          currency: r.currency,
          txnDate: r.txn_date.slice(0, 10),
          createdAt: r.created_at.toISOString(),
        })),
      });
    }),
  );

  router.post(
    '/api/portfolio/transactions',
    authenticate,
    wrap(async (req, res) => {
      // The header is external input like any other, so it is validated rather
      // than trusted — a non-UUID key would otherwise reach a UUID column and
      // surface as a 500 from the driver.
      const parsed = idempotencyKeySchema.safeParse(req.header('Idempotency-Key'));
      if (!parsed.success) {
        throw badRequest(
          'A valid Idempotency-Key header (UUID) is required',
          parsed.error.flatten().formErrors,
        );
      }

      const input = createTransactionSchema.parse(req.body);
      const created = await services.transactions.addTransaction(
        requireUserId(req),
        input,
        parsed.data,
      );
      res.status(201).json({ data: created });
    }),
  );

  router.patch(
    '/api/portfolio/transactions/:id',
    authenticate,
    wrap(async (req, res) => {
      const { id } = idParamsSchema.parse(req.params);
      const patch = updateTransactionSchema.parse(req.body);
      res.json({
        data: await services.transactions.updateTransaction(requireUserId(req), id, patch),
      });
    }),
  );

  router.delete(
    '/api/portfolio/transactions/:id',
    authenticate,
    wrap(async (req, res) => {
      const { id } = idParamsSchema.parse(req.params);
      await services.transactions.deleteTransaction(requireUserId(req), id);
      res.status(204).end();
    }),
  );

  return router;
}
