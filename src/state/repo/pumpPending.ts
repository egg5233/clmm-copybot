/**
 * `pump_pending` repository — replaces data/pump-pending.json.
 *
 * Mirrors the public API of `src/state/pump-pending.ts`. Everything about the
 * Discord approval round-trip stays in that module; only the storage moves here.
 */

import { fromTimestamp, query, toTimestamp } from '../db';

/** Pending entries older than this read as not-pending. Matches EXPIRY_MS. */
export const EXPIRY_MS = 60 * 60 * 1000;

export type PumpStatus = 'pending' | 'approved' | 'rejected';

export interface PumpPendingEntry {
  mint: string;
  symbol: string;
  pool: string;
  targetWallet: string;
  detectedAt: number;
  status: PumpStatus;
  notifiedAt?: number;
  resolvedAt?: number;
}

interface PumpRow {
  mint: string;
  symbol: string;
  pool: string;
  target_wallet: string;
  detected_at: Date;
  status: PumpStatus;
  notified_at: Date | null;
  resolved_at: Date | null;
}

const SELECT_COLUMNS =
  'mint, symbol, pool, target_wallet, detected_at, status, notified_at, resolved_at';

function toEntry(row: PumpRow): PumpPendingEntry {
  return {
    mint: row.mint,
    symbol: row.symbol,
    pool: row.pool,
    targetWallet: row.target_wallet,
    detectedAt: fromTimestamp(row.detected_at),
    status: row.status,
    notifiedAt: row.notified_at ? fromTimestamp(row.notified_at) : undefined,
    resolvedAt: row.resolved_at ? fromTimestamp(row.resolved_at) : undefined,
  };
}

/** Record a newly detected pump token as pending. */
export async function add(entry: Omit<PumpPendingEntry, 'status'>): Promise<void> {
  await query(
    `INSERT INTO pump_pending (mint, symbol, pool, target_wallet, detected_at, status, notified_at)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6)
     ON CONFLICT (mint) DO UPDATE SET
       symbol        = EXCLUDED.symbol,
       pool          = EXCLUDED.pool,
       target_wallet = EXCLUDED.target_wallet,
       detected_at   = EXCLUDED.detected_at,
       status        = 'pending',
       notified_at   = EXCLUDED.notified_at,
       resolved_at   = NULL`,
    [
      entry.mint,
      entry.symbol,
      entry.pool,
      entry.targetWallet,
      toTimestamp(entry.detectedAt),
      entry.notifiedAt === undefined ? null : toTimestamp(entry.notifiedAt),
    ],
  );
}

/**
 * Write an entry exactly as it was stored, status and resolution included.
 *
 * add() always lands a row as 'pending' because that is what detecting a token
 * means; the backfill has to carry approved and rejected rows across unchanged,
 * so it gets its own upsert.
 */
export async function importEntry(entry: PumpPendingEntry): Promise<void> {
  await query(
    `INSERT INTO pump_pending (mint, symbol, pool, target_wallet, detected_at, status,
                               notified_at, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (mint) DO UPDATE SET
       symbol        = EXCLUDED.symbol,
       pool          = EXCLUDED.pool,
       target_wallet = EXCLUDED.target_wallet,
       detected_at   = EXCLUDED.detected_at,
       status        = EXCLUDED.status,
       notified_at   = EXCLUDED.notified_at,
       resolved_at   = EXCLUDED.resolved_at`,
    [
      entry.mint,
      entry.symbol,
      entry.pool,
      entry.targetWallet,
      toTimestamp(entry.detectedAt),
      entry.status,
      entry.notifiedAt === undefined ? null : toTimestamp(entry.notifiedAt),
      entry.resolvedAt === undefined ? null : toTimestamp(entry.resolvedAt),
    ],
  );
}

/**
 * Resolve a token, stamping resolvedAt.
 *
 * Only rows still pending are touched, so a late Discord reply cannot flip an
 * already-resolved token — the file version reproduced that with an explicit
 * `entry.status !== 'pending'` guard at the call site.
 *
 * @returns the resolved entry, or undefined when nothing was pending
 */
async function resolve(
  mint: string,
  status: Exclude<PumpStatus, 'pending'>,
  resolvedAt: number,
): Promise<PumpPendingEntry | undefined> {
  const res = await query<PumpRow>(
    `UPDATE pump_pending SET status = $2, resolved_at = $3
     WHERE mint = $1 AND status = 'pending'
     RETURNING ${SELECT_COLUMNS}`,
    [mint, status, toTimestamp(resolvedAt)],
  );
  const row = res.rows[0];
  return row ? toEntry(row) : undefined;
}

/**
 * Set a token's decision whatever its current one is.
 *
 * approve()/reject() refuse to touch a row that is no longer pending, which is
 * what the Discord poller wants of a late reply. The dashboard's resolve route
 * has no such guard — an operator can flip an approved token to rejected — and
 * `src/state/pump-pending.ts` mirrors its in-memory decision rather than making
 * it a second time, so it needs the unconditional form.
 */
export async function setStatus(
  mint: string,
  status: PumpStatus,
  resolvedAt: number,
): Promise<void> {
  await query('UPDATE pump_pending SET status = $2, resolved_at = $3 WHERE mint = $1', [
    mint,
    status,
    toTimestamp(resolvedAt),
  ]);
}

export function approve(
  mint: string,
  resolvedAt: number = Date.now(),
): Promise<PumpPendingEntry | undefined> {
  return resolve(mint, 'approved', resolvedAt);
}

export function reject(
  mint: string,
  resolvedAt: number = Date.now(),
): Promise<PumpPendingEntry | undefined> {
  return resolve(mint, 'rejected', resolvedAt);
}

/**
 * Reject every pending token past the expiry window.
 *
 * The file version did this inside pollApprovals(), then notified Discord for
 * each one — hence returning the expired entries rather than just a count.
 */
export async function expire(
  now: number = Date.now(),
  expiryMs: number = EXPIRY_MS,
): Promise<PumpPendingEntry[]> {
  const res = await query<PumpRow>(
    `UPDATE pump_pending SET status = 'rejected', resolved_at = $1
     WHERE status = 'pending' AND detected_at < $2
     RETURNING ${SELECT_COLUMNS}`,
    [toTimestamp(now), toTimestamp(now - expiryMs)],
  );
  return res.rows.map(toEntry);
}

export async function get(mint: string): Promise<PumpPendingEntry | undefined> {
  const res = await query<PumpRow>(`SELECT ${SELECT_COLUMNS} FROM pump_pending WHERE mint = $1`, [
    mint,
  ]);
  const row = res.rows[0];
  return row ? toEntry(row) : undefined;
}

/**
 * True when the token is pending and still inside the expiry window.
 *
 * The window is applied on read as well as by expire(), because the file version
 * did: a token whose hour lapsed reads as not-pending even before the poller
 * gets round to rejecting it.
 */
export async function isPending(
  mint: string,
  now: number = Date.now(),
  expiryMs: number = EXPIRY_MS,
): Promise<boolean> {
  const res = await query(
    `SELECT 1 FROM pump_pending WHERE mint = $1 AND status = 'pending' AND detected_at >= $2`,
    [mint, toTimestamp(now - expiryMs)],
  );
  return (res.rowCount ?? 0) > 0;
}

async function hasStatus(mint: string, status: PumpStatus): Promise<boolean> {
  const res = await query('SELECT 1 FROM pump_pending WHERE mint = $1 AND status = $2', [
    mint,
    status,
  ]);
  return (res.rowCount ?? 0) > 0;
}

export function isApproved(mint: string): Promise<boolean> {
  return hasStatus(mint, 'approved');
}

export function isRejected(mint: string): Promise<boolean> {
  return hasStatus(mint, 'rejected');
}

/** True when any token is awaiting approval — the early-out pollApprovals() takes. */
export async function hasPending(
  now: number = Date.now(),
  expiryMs: number = EXPIRY_MS,
): Promise<boolean> {
  const res = await query(
    `SELECT 1 FROM pump_pending WHERE status = 'pending' AND detected_at >= $1 LIMIT 1`,
    [toTimestamp(now - expiryMs)],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Every entry regardless of status, as the dashboard list. */
export async function list(): Promise<PumpPendingEntry[]> {
  const res = await query<PumpRow>(
    `SELECT ${SELECT_COLUMNS} FROM pump_pending ORDER BY detected_at DESC`,
  );
  return res.rows.map(toEntry);
}

async function del(mint: string): Promise<void> {
  await query('DELETE FROM pump_pending WHERE mint = $1', [mint]);
}

export { del as delete };
