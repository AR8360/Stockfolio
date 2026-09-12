import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { env } from '../src/config/env.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Locate `schema.sql` by walking up.
 *
 * `tsc` compiles `.ts` and copies nothing else, so the schema file does not
 * exist under `dist/`. A path relative to this module is therefore correct
 * when run from source (tsx) and wrong when run from a build — and since this
 * script is what creates the tables, getting it wrong means the very first
 * deploy fails at the step that has to succeed before anything else works.
 *
 * Searching upward for `server/src/database/schema.sql` finds the file from
 * either layout without needing a build step to copy it.
 */
function findSchema(): string {
  let directory = here;

  for (let depth = 0; depth < 6; depth += 1) {
    for (const candidate of [
      resolve(directory, 'src/database/schema.sql'),
      resolve(directory, 'server/src/database/schema.sql'),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  throw new Error('Could not locate schema.sql');
}

const schemaPath = findSchema();

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
