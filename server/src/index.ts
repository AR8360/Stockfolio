import { createApp } from './app.js';
import { env } from './config/env.js';
import { pool } from './database/pool.js';

const app = createApp();
const server = app.listen(env.PORT, () => {
  console.log(`Stockfolio listening on :${String(env.PORT)} (${env.NODE_ENV})`);
});

/**
 * Graceful shutdown. The host sends SIGTERM on deploy and on scale-down;
 * without this the process is killed mid-request and the pool's connections
 * are left for the database to time out, which on a free tier with a low
 * connection cap makes the next deploy fail to connect.
 */
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
  });
}
