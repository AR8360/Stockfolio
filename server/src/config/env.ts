import { existsSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/**
 * Locate `.env` by walking up from the current directory.
 *
 * This is a workspace repo with a single `.env` at the root, but npm runs
 * workspace scripts with the cwd set to the *package* directory -- so
 * dotenv's default "look in cwd" finds nothing when invoked as
 * `npm run db:init`, and the process exits complaining that DATABASE_URL is
 * missing while the variable is sitting one directory up. Searching upward
 * makes every entry point behave the same whether it was started from the
 * repo root or from `server/`.
 *
 * Returns undefined if nothing is found, which is correct in deployment: the
 * host injects real environment variables and there is no file to read.
 */
function findEnvFile(from: string): string | undefined {
  const { root } = parse(from);
  let directory = from;

  for (;;) {
    const candidate = join(directory, '.env');
    if (existsSync(candidate)) {
      return candidate;
    }
    if (directory === root) {
      return undefined;
    }
    directory = dirname(directory);
  }
}

const envFile = findEnvFile(process.cwd());
// `override: false` (the default) matters: a variable already set in the real
// environment must win over the file, so a deployed host's configuration is
// never silently replaced by a stray committed .env.
loadDotenv(envFile !== undefined ? { path: envFile } : {});

/**
 * Environment is parsed and validated exactly once, here, at module load
 * (IMPLEMENTATION_PLAN.md §7).
 *
 * The point of doing it eagerly rather than reading `process.env` at each call
 * site is failure *timing*: a missing JWT_SECRET should stop the process at
 * boot with a message naming the variable, not surface an hour later as a
 * confusing 500 on the first login attempt. On a free host that restarts on
 * deploy, a boot-time crash is also the failure the platform actually
 * surfaces to you.
 */
const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),

  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL is required (a Postgres connection string)'),

  // Length floor rather than just "present": a short or placeholder secret is
  // the failure mode that looks configured but is not.
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters'),

  // Unused while the app is deployed as a monolith (one origin, so no
  // cross-origin request to allow) but read here so that splitting the
  // frontend onto its own host later is a config change, not a code change
  // (ASSUMPTIONS.md #17).
  CORS_ORIGIN: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

function parseEnv(): Env {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = Object.entries(parsed.error.flatten().fieldErrors)
      .map(([key, messages]) => `  ${key}: ${(messages ?? []).join(', ')}`)
      .join('\n');

    // Deliberately not thrown as an AppError: this runs before the error
    // middleware (or anything else) exists, and there is no request to
    // respond to. A plain message plus a non-zero exit is what a host log
    // and a developer terminal both render usefully.
    console.error(`Invalid environment configuration:\n${issues}\n\nSee .env.example for the required variables.`);
    process.exit(1);
  }

  return parsed.data;
}

export const env: Env = parseEnv();
