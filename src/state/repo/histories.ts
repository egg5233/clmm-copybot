/**
 * `claim_history` + `dac_history` repositories — replace data/claim-history.json
 * and data/dac-history.json.
 *
 * Both are append-only ring buffers of display records: weekly copy-bonus claims
 * (cap 52, one year) and Daily Auto-Convert runs (cap 365). They share a module
 * because they share a shape — a timestamp, a cap, and an otherwise opaque
 * payload — and neither is big enough to earn its own file.
 */

import { fromTimestamp, query, toTimestamp, withTransaction } from '../db';

/** Caps from src/executor/auto-claim.ts and src/executor/dac.ts. */
export const MAX_CLAIM_HISTORY = 52;
export const MAX_DAC_HISTORY = 365;

export interface ClaimHistoryEntry {
  ts: number;
  snapshotTs?: number;
  week: string;
  totalPools: number;
  totalBonusUsd: number;
  txSignatures: string[];
  error?: string;
}

export interface DacRecord {
  ts: number;
  profitUsd: number;
  dacAmountUsd: number;
  cbbtcReceived: string;
  tokenReceived?: string;
  tokenSymbol?: string;
  tokenMint?: string;
  swapSig: string | null;
  transferSig: string | null;
  transferTo: string;
  status: 'success' | 'skipped' | 'swap_failed' | 'transfer_failed';
  reason?: string;
}

/**
 * Append and trim in one transaction.
 *
 * `week` is lifted into its own column because the claim scheduler queries it
 * ("did we already claim this ISO week?"); everything else stays in the payload.
 */
export async function pushClaim(entry: ClaimHistoryEntry, cap = MAX_CLAIM_HISTORY): Promise<void> {
  await withTransaction(async (client) => {
    await client.query('INSERT INTO claim_history (week, ts, payload) VALUES ($1, $2, $3)', [
      entry.week,
      toTimestamp(entry.ts),
      JSON.stringify(entry),
    ]);
    await client.query(
      `DELETE FROM claim_history
       WHERE id < (SELECT id FROM claim_history ORDER BY id DESC OFFSET $1 LIMIT 1)`,
      [cap - 1],
    );
  });
}

/** Claims oldest first, matching the on-disk array order. */
export async function listClaims(limit = MAX_CLAIM_HISTORY): Promise<ClaimHistoryEntry[]> {
  const res = await query<{ payload: ClaimHistoryEntry }>(
    `SELECT payload FROM (SELECT * FROM claim_history ORDER BY id DESC LIMIT $1) AS newest
     ORDER BY id ASC`,
    [limit],
  );
  return res.rows.map((r) => r.payload);
}

/**
 * The most recent successful claim — what auto-claim.ts recovers on startup to
 * populate lastClaimWeek / lastClaimTs / lastClaimResult. A claim counts as
 * successful when it recorded no error.
 */
export async function latestSuccessfulClaim(): Promise<ClaimHistoryEntry | undefined> {
  const res = await query<{ payload: ClaimHistoryEntry }>(
    `SELECT payload FROM claim_history
     WHERE payload ->> 'error' IS NULL
     ORDER BY id DESC LIMIT 1`,
  );
  return res.rows[0]?.payload;
}

export async function countClaims(): Promise<number> {
  const res = await query<{ count: string }>('SELECT count(*) AS count FROM claim_history');
  return Number(res.rows[0].count);
}

/** Append and trim in one transaction. */
export async function pushDac(record: DacRecord, cap = MAX_DAC_HISTORY): Promise<void> {
  await withTransaction(async (client) => {
    await client.query('INSERT INTO dac_history (ts, payload) VALUES ($1, $2)', [
      toTimestamp(record.ts),
      JSON.stringify(record),
    ]);
    await client.query(
      `DELETE FROM dac_history
       WHERE id < (SELECT id FROM dac_history ORDER BY id DESC OFFSET $1 LIMIT 1)`,
      [cap - 1],
    );
  });
}

/** DAC runs oldest first, matching the on-disk array order. */
export async function listDac(limit = MAX_DAC_HISTORY): Promise<DacRecord[]> {
  const res = await query<{ payload: DacRecord }>(
    `SELECT payload FROM (SELECT * FROM dac_history ORDER BY id DESC LIMIT $1) AS newest
     ORDER BY id ASC`,
    [limit],
  );
  return res.rows.map((r) => r.payload);
}

/** Timestamp of the newest DAC run, or 0 — used to decide whether today's run already happened. */
export async function latestDacTs(): Promise<number> {
  const res = await query<{ ts: Date }>('SELECT ts FROM dac_history ORDER BY id DESC LIMIT 1');
  const row = res.rows[0];
  return row ? fromTimestamp(row.ts) : 0;
}

export async function countDac(): Promise<number> {
  const res = await query<{ count: string }>('SELECT count(*) AS count FROM dac_history');
  return Number(res.rows[0].count);
}
