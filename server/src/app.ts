import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import express, { type Express } from 'express';

import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createRouter, type Services } from './routes/index.js';
import { db } from './database/pool.js';
import { AuthService } from './services/AuthService.js';
import { DashboardService } from './services/DashboardService.js';
import { PortfolioService } from './services/PortfolioService.js';
import { TransactionService } from './services/TransactionService.js';
import { CachedMarketDataService } from './providers/CachedMarketDataService.js';
import { YahooMarketDataProvider } from './providers/yahoo/YahooMarketDataProvider.js';
import type { MarketDataService } from './providers/types.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the built frontend by walking up from this module.
 *
 * A fixed relative path does not work, because this file sits at a different
 * depth depending on how it is run: `server/src/app.ts` under tsx, but
 * `server/dist/src/app.js` after a build. The same `../../web/dist` that is
 * correct in development resolves to `server/web/dist` in production — so the
 * deployed process would serve the API correctly and return a JSON 404 for
 * every page, which is exactly the failure that is invisible until deploy.
 *
 * Returns null when there is no build, which is the normal state when running
 * the API alone against the Vite dev server.
 */
function findWebDist(): string | null {
  let directory = here;

  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(directory, 'web', 'dist');
    if (existsSync(join(candidate, 'index.html'))) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  return null;
}

/**
 * Builds the Express app (IMPLEMENTATION_PLAN.md §4, §9).
 *
 * Dependencies are parameters rather than imports-with-side-effects, so a test
 * can boot the real app with stub dependencies (§8, Tier 3).
 */
export function createApp(overrides: Partial<Services> = {}): Express {
  const marketData: MarketDataService =
    overrides.marketData ?? new CachedMarketDataService(new YahooMarketDataProvider());

  const services: Services = {
    marketData,
    auth: overrides.auth ?? new AuthService(db),
    transactions: overrides.transactions ?? new TransactionService(db, marketData),
    portfolio: overrides.portfolio ?? new PortfolioService(db, marketData),
    dashboard: overrides.dashboard ?? new DashboardService(marketData),
  };

  const app = express();

  // Required for rate limiting to see the real client IP: the app runs behind
  // a platform proxy, and without this every request appears to originate from
  // it. `1` rather than `true` — trusting an unbounded chain lets a client
  // forge X-Forwarded-For and evade the limiter entirely.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // A modest body cap: no legitimate request here is large, and the default
  // 100kb is more attack surface than this API needs.
  app.use(express.json({ limit: '32kb' }));

  app.use(createRouter(services));

  // Serve the built frontend from the same process (ASSUMPTIONS.md #17).
  // Guarded so `npm run dev` on the API alone does not fail when the frontend
  // has not been built yet.
  const clientDist = findWebDist();
  if (clientDist !== null) {
    app.use(express.static(clientDist));
    // SPA fallback, registered after the API router so it cannot shadow a real
    // route: any non-API path returns index.html and lets the client router
    // handle it, which is what makes a deep link like /portfolio survive a
    // page refresh.
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.sendFile(join(clientDist, 'index.html'));
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
