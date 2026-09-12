import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { env } from '../src/config/env.js';

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, '../src/database/schema.sql');

/**
 * Applies `schema.sql` (IMPLEMENTATION_PLAN.md §3). Safe to re-run: the schema
 * is written entirely as IF NOT EXISTS.
 *
 * The whole file is executed inside a single transaction. Postgres supports
 * transactional DDL, so a failure partway through a multi-table script leaves
 * no half-created schema behind -- which is the difference between "re-run it"
 * and "work out by hand which four of the five tables exist".
 */
async function main(): Promise<void> {
  const schema = await readFile(schemaPath, 'utf8');
  const client = new pg.Client({ connectionString: env.DATABASE_URL });

  await client.connect();

  try {
    await client.query('BEGIN');
    await client.query(schema);
    await client.query('COMMIT');
    console.log('Schema applied successfully.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error('Failed to apply schema:');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
