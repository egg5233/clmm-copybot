/**
 * `auth_log` repository — replaces data/auth-log.json.
 *
 * Dashboard login attempts, kept apart from bot logs so a log rotation never
 * loses them. Cap 200, same as the file version.
 */

import { fromTimestamp, query, toTimestamp, withTransaction } from '../db';

/** Matches MAX_AUTH_LOG in src/dashboard/server.ts. */
export const MAX_AUTH_LOG = 200;

/** Number of entries GET /api/auth-log returns. */
export const DEFAULT_LIST_LIMIT = 50;

export interface AuthLogEntry {
  ts: number;
  ip: string;
  event: string;
}

/** Append one entry and trim to the cap, in a single transaction. */
export async function push(
  ip: string,
  event: string,
  ts: number = Date.now(),
  cap = MAX_AUTH_LOG,
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query('INSERT INTO auth_log (ts, ip, event) VALUES ($1, $2, $3)', [
      toTimestamp(ts),
      ip,
      event,
    ]);
    await client.query(
      `DELETE FROM auth_log WHERE id < (SELECT id FROM auth_log ORDER BY id DESC OFFSET $1 LIMIT 1)`,
      [cap - 1],
    );
  });
}

/** The newest `limit` entries, newest first — the order the dashboard renders. */
export async function list(limit = DEFAULT_LIST_LIMIT): Promise<AuthLogEntry[]> {
  const res = await query<{ ts: Date; ip: string; event: string }>(
    'SELECT ts, ip, event FROM auth_log ORDER BY id DESC LIMIT $1',
    [limit],
  );
  return res.rows.map((r) => ({ ts: fromTimestamp(r.ts), ip: r.ip, event: r.event }));
}

/** Wipe the log (DELETE /api/auth-log). */
export async function clear(): Promise<void> {
  await query('DELETE FROM auth_log');
}

export async function count(): Promise<number> {
  const res = await query<{ count: string }>('SELECT count(*) AS count FROM auth_log');
  return Number(res.rows[0].count);
}
