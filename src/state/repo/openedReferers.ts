/**
 * `opened_referers` repository — replaces data/opened-referers.json.
 *
 * A dedup guard: the referer position address identifies the position a target
 * wallet copied from, so recording it stops two of our target wallets both
 * mirroring the same underlying position.
 */

import { fromTimestamp, query, toTimestamp } from '../db';

export interface OpenedRefererEntry {
  targetNft: string;
  ourNft: string;
  targetWallet: string;
  openedAt: number;
}

interface RefererRow {
  referer_position: string;
  target_nft: string;
  our_nft: string;
  target_wallet: string;
  opened_at: Date;
}

function toEntry(row: RefererRow): OpenedRefererEntry {
  return {
    targetNft: row.target_nft,
    ourNft: row.our_nft,
    targetWallet: row.target_wallet,
    openedAt: fromTimestamp(row.opened_at),
  };
}

export async function has(refererPosition: string): Promise<boolean> {
  const res = await query('SELECT 1 FROM opened_referers WHERE referer_position = $1', [
    refererPosition,
  ]);
  return (res.rowCount ?? 0) > 0;
}

/**
 * The entry for a referer position, or undefined.
 *
 * The duplicate decision itself stays in the executor: isRefererDuplicateEntry()
 * weighs this entry against the allow-lists in config, and that policy does not
 * belong in the storage layer.
 */
export async function get(refererPosition: string): Promise<OpenedRefererEntry | undefined> {
  const res = await query<RefererRow>(
    `SELECT referer_position, target_nft, our_nft, target_wallet, opened_at
     FROM opened_referers WHERE referer_position = $1`,
    [refererPosition],
  );
  const row = res.rows[0];
  return row ? toEntry(row) : undefined;
}

/** Record a referer as opened. Re-recording the same referer overwrites it. */
export async function add(
  refererPosition: string,
  targetNft: string,
  ourNft: string,
  targetWallet: string,
  openedAt: number = Date.now(),
): Promise<void> {
  await query(
    `INSERT INTO opened_referers (referer_position, target_nft, our_nft, target_wallet, opened_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (referer_position) DO UPDATE SET
       target_nft    = EXCLUDED.target_nft,
       our_nft       = EXCLUDED.our_nft,
       target_wallet = EXCLUDED.target_wallet,
       opened_at     = EXCLUDED.opened_at`,
    [refererPosition, targetNft, ourNft, targetWallet, toTimestamp(openedAt)],
  );
}

async function del(refererPosition: string): Promise<void> {
  await query('DELETE FROM opened_referers WHERE referer_position = $1', [refererPosition]);
}

export { del as delete };

/**
 * Remove the entry pointing at a target NFT, which is how removeReferer() is
 * called: a position closes and its referer becomes eligible again.
 *
 * @returns true when a row was removed
 */
export async function deleteByTargetNft(targetNft: string): Promise<boolean> {
  const res = await query('DELETE FROM opened_referers WHERE target_nft = $1', [targetNft]);
  return (res.rowCount ?? 0) > 0;
}

/** Every entry, in the Record<refererPosition, entry> shape the dashboard reads. */
export async function all(): Promise<Record<string, OpenedRefererEntry>> {
  const res = await query<RefererRow>(
    'SELECT referer_position, target_nft, our_nft, target_wallet, opened_at FROM opened_referers',
  );
  const out: Record<string, OpenedRefererEntry> = {};
  for (const row of res.rows) out[row.referer_position] = toEntry(row);
  return out;
}

export async function count(): Promise<number> {
  const res = await query<{ count: string }>('SELECT count(*) AS count FROM opened_referers');
  return Number(res.rows[0].count);
}
