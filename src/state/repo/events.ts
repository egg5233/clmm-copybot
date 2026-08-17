/**
 * `events` + `event_pool_map` repository — replaces data/event-log.json.
 *
 * The JSON version held `{poolMap, events}` and rewrote the whole object on
 * every single event; at the 1000-event cap that file was ~336KB, so a burst of
 * activity meant hundreds of KB of synchronous writes per trade. Here an event
 * is one INSERT, and the 1000-row cap is enforced by the database rather than by
 * an array splice on the way out.
 */

import type { EventLogEntry } from '../../dashboard/context';
import { fromTimestamp, query, toTimestamp, withTransaction } from '../db';

/** Matches MAX_EVENT_LOG in src/index.ts. */
export const MAX_EVENTS = 1000;

interface EventRow {
  ts: Date;
  type: string;
  target_wallet: string;
  target_nft: string | null;
  our_nft: string | null;
  tx_sig: string | null;
  success: boolean;
  error: string | null;
  pool: string | null;
  dex: string | null;
}

function toEntry(row: EventRow): EventLogEntry {
  return {
    ts: fromTimestamp(row.ts),
    type: row.type,
    targetWallet: row.target_wallet,
    targetNft: row.target_nft ?? undefined,
    ourNft: row.our_nft ?? undefined,
    txSig: row.tx_sig ?? undefined,
    success: row.success,
    error: row.error ?? undefined,
    pool: row.pool ?? undefined,
    dex: row.dex ?? undefined,
  };
}

/**
 * Append one event, refresh the permanent NFT -> pool lookup, and trim to the cap.
 *
 * All three run in one transaction so the table is never observed over the cap.
 * The pool map is upserted only when the event names both an NFT and a pool —
 * the same condition src/index.ts applied before writing into `poolMap`.
 */
export async function append(entry: EventLogEntry, cap = MAX_EVENTS): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO events (ts, type, target_wallet, target_nft, our_nft, tx_sig, success, error, pool, dex)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        toTimestamp(entry.ts),
        entry.type,
        entry.targetWallet,
        entry.targetNft ?? null,
        entry.ourNft ?? null,
        entry.txSig ?? null,
        entry.success,
        entry.error ?? null,
        entry.pool ?? null,
        entry.dex ?? null,
      ],
    );

    if (entry.targetNft && entry.pool) {
      await client.query(
        `INSERT INTO event_pool_map (target_nft, pool) VALUES ($1, $2)
         ON CONFLICT (target_nft) DO UPDATE SET pool = EXCLUDED.pool`,
        [entry.targetNft, entry.pool],
      );
    }

    await client.query(
      `DELETE FROM events
       WHERE id < (SELECT id FROM events ORDER BY id DESC OFFSET $1 LIMIT 1)`,
      [cap - 1],
    );
  });
}

/**
 * The most recent `limit` events, oldest first.
 *
 * Ascending order matches the on-disk array the dashboard used to read, so
 * consumers that assume "last element is newest" keep working.
 */
export async function recent(limit = MAX_EVENTS): Promise<EventLogEntry[]> {
  const res = await query<EventRow>(
    `SELECT ts, type, target_wallet, target_nft, our_nft, tx_sig, success, error, pool, dex
     FROM (SELECT * FROM events ORDER BY id DESC LIMIT $1) AS newest
     ORDER BY id ASC`,
    [limit],
  );
  return res.rows.map(toEntry);
}

export async function count(): Promise<number> {
  const res = await query<{ count: string }>('SELECT count(*) AS count FROM events');
  return Number(res.rows[0].count);
}

/** Drop everything beyond the newest `keep` rows. Called by append(); exposed for backfills. */
export async function prune(keep = MAX_EVENTS): Promise<number> {
  const res = await query(
    `DELETE FROM events WHERE id < (SELECT id FROM events ORDER BY id DESC OFFSET $1 LIMIT 1)`,
    [keep - 1],
  );
  return res.rowCount ?? 0;
}

/** Pool for a target NFT, from the map that outlives the event cap. */
export async function getPoolFor(targetNft: string): Promise<string | undefined> {
  const res = await query<{ pool: string }>(
    'SELECT pool FROM event_pool_map WHERE target_nft = $1',
    [targetNft],
  );
  return res.rows[0]?.pool;
}

/** Record an NFT -> pool association without logging an event. */
export async function setPoolFor(targetNft: string, pool: string): Promise<void> {
  await query(
    `INSERT INTO event_pool_map (target_nft, pool) VALUES ($1, $2)
     ON CONFLICT (target_nft) DO UPDATE SET pool = EXCLUDED.pool`,
    [targetNft, pool],
  );
}

/** The whole pool map, in the Record shape the JSON file carried. */
export async function poolMap(): Promise<Record<string, string>> {
  const res = await query<{ target_nft: string; pool: string }>(
    'SELECT target_nft, pool FROM event_pool_map',
  );
  const out: Record<string, string> = {};
  for (const row of res.rows) out[row.target_nft] = row.pool;
  return out;
}
