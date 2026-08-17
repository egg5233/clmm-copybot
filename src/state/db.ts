/**
 * Postgres connection ownership.
 *
 * This is the only module in the bot that constructs a pg client. Everything
 * else goes through `src/state/repo/*`, which owns the SQL. The pool is lazy so
 * that importing a repo module — which tests and the dashboard both do — never
 * opens a socket by itself, and so DATABASE_URL only has to be present for the
 * processes that actually talk to the database.
 */

import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

let pool: Pool | null = null;

/**
 * Get the shared connection pool, creating it on first use.
 *
 * @throws if DATABASE_URL is unset — a bot that reached a repository call and
 * has nowhere to persist must fail loudly rather than silently drop state.
 */
export function getPool(): Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. The bot persists positions, events and pending swaps to ' +
        'Postgres; start one with `npm run db:start` and apply migrations with `npm run migrate`, ' +
        'or point DATABASE_URL at an existing server (postgres://user:pass@host:5432/copybot).',
    );
  }

  pool = new Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  // A pooled client can die between checkouts (server restart, idle timeout kill).
  // Without a listener that surfaces as an unhandled 'error' event and takes the
  // process down; pg discards the broken client on its own.
  pool.on('error', () => {});

  return pool;
}

/** Close the pool and forget it, so a later getPool() builds a fresh one. */
export async function closePool(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end();
}

/** Run a query on the shared pool. */
export function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  values?: unknown[],
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, values);
}

/**
 * Run `fn` inside a single BEGIN/COMMIT on one checked-out client.
 *
 * Repository writes that append a row and then trim to a cap use this so the
 * table is never observed over its cap, and so a failure between the two leaves
 * nothing behind.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* the client is already broken; the original error is the useful one */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Epoch milliseconds -> a value pg will bind to TIMESTAMPTZ. */
export function toTimestamp(ms: number): Date {
  return new Date(ms);
}

/** TIMESTAMPTZ read back from pg -> epoch milliseconds, the unit call sites use. */
export function fromTimestamp(value: Date): number {
  return value.getTime();
}

/** NUMERIC arrives as a string (pg refuses to lose precision); optional columns arrive as null. */
export function numberOrUndefined(value: string | null): number | undefined {
  return value === null ? undefined : Number(value);
}
