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
 */

import { afterAll, beforeEach } from 'vitest';
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
