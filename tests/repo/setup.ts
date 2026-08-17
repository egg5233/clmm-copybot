/**
 * Per-suite helpers for the repository integration tests.
 *
 * The database itself is provided by tests/repo/global-setup.ts, which runs once
 * per vitest run and exports DATABASE_URL. This module only wires the hooks every
 * suite needs: clean tables before each test, and a closed pool when the file is
 * done.
 *
 * These suites talk to a real Postgres on purpose. What the repository layer
 * consists of *is* SQL — upserts, CHECK constraints, cap-enforcing DELETEs,
 * NUMERIC arithmetic under concurrency — so a mocked client would assert nothing
 * about the thing under test.
 *
 * Isolation rule: vitest runs test files in parallel against the one database, so
 * a suite may only truncate the tables it owns, and no two suites may own the
 * same table. That is why useTestDatabase() takes an explicit list rather than
 * wiping everything. tests/repo/db.test.ts owns no table from the migration — it
 * queries the catalog read-only and makes its own scratch table.
 *
 * A suite that cannot honour that rule — the store tests outside this directory
 * cover the same tables the repository suites own — takes a database of its own
 * through useOwnTestDatabase().
 */

import { runner } from 'node-pg-migrate';
import path from 'path';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { closePool, getPool } from '../../src/state/db';

/** Every table the initial migration creates. */
export const ALL_TABLES = [
  'positions',
  'events',
  'event_pool_map',
  'asset_snapshots',
  'pending_swaps',
  'swap_history',
  'auth_log',
  'claim_history',
  'dac_history',
  'token_pnl',
  'opened_referers',
  'pump_pending',
] as const;

/**
 * Whether a database was available when the run started.
 *
 * Read at module load so `describe.skipIf(!canRunRepoTests)` can branch on it —
 * vitest evaluates describe bodies before any hook runs. When it is false,
 * global-setup.ts has already explained why on the console.
 */
export const canRunRepoTests: boolean = Boolean(process.env.DATABASE_URL);

/** Empty the named tables and restart their BIGSERIAL counters, so ids are predictable. */
export async function truncate(tables: readonly string[]): Promise<void> {
  await getPool().query(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
}

/**
 * Register the standard hooks for a suite that owns `tables`.
 *
 * Truncating before each test rather than after leaves the rows in place when a
 * test fails, which is what you want to look at.
 */
export function useTestDatabase(tables: readonly string[]): void {
  beforeEach(async () => {
    await truncate(tables);
  });

  afterAll(async () => {
    await closePool();
  });
}

/** A DATABASE_URL pointing at a different database on the same server. */
function databaseUrlFor(baseUrl: string, name: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function onAdminConnection(
  url: string,
  fn: (client: Client) => Promise<void>,
): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Give one suite a database of its own, created and migrated for the run.
 *
 * The store suites — tests/position-map.test.ts and the ones that will follow —
 * exercise the same tables the repository suites already own, and there is no
 * way to divide `positions` between two files that vitest may run at the same
 * moment. Its own database is less machinery than coordinating that ownership,
 * and it means a store suite can truncate freely.
 *
 * DATABASE_URL is redirected for this worker only: vitest forks a process per
 * test file, so the change reaches the store under test and nothing else.
 */
export function useOwnTestDatabase(name: string, tables: readonly string[] = ALL_TABLES): void {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`Not a usable database name: ${name}`);
  }
  const serverUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    if (!serverUrl) return;
    await onAdminConnection(serverUrl, async (client) => {
      await client.query(`DROP DATABASE IF EXISTS "${name}"`);
      await client.query(`CREATE DATABASE "${name}"`);
    });

    const url = databaseUrlFor(serverUrl, name);
    process.env.DATABASE_URL = url;
    await runner({
      databaseUrl: url,
      dir: path.resolve(__dirname, '../../migrations'),
      direction: 'up',
      migrationsTable: 'pgmigrations',
      log: () => {},
    });
  });

  beforeEach(async () => {
    if (serverUrl) await truncate(tables);
  });

  afterAll(async () => {
    if (!serverUrl) return;
    // The pool has to let go before the server will drop the database.
    await closePool();
    process.env.DATABASE_URL = serverUrl;
    await onAdminConnection(serverUrl, async (client) => {
      await client.query(`DROP DATABASE IF EXISTS "${name}"`);
    });
  });
}
