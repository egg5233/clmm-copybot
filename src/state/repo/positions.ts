/**
 * `positions` repository — replaces data/position-map.json.
 *
 * Mirrors the public API of `src/state/position-map.ts` one-for-one, with every
 * method returning a promise. Wave 2 swaps the PositionMap instance for this
 * module and awaits the calls; no call-site logic should need rethinking.
 */

import { fromTimestamp, numberOrUndefined, query, toTimestamp } from '../db';

export interface PositionEntry {
  ourNft: string;
  createdAt: number;
  pool?: string;
  targetWallet?: string;
  lockedSol?: number;
  tickLower?: number;
  tickUpper?: number;
  dex?: string;
  targetLiquidity?: string;
}

interface PositionRow {
  target_nft: string;
  our_nft: string;
  dex: string | null;
  pool: string | null;
  target_wallet: string | null;
  locked_sol: string | null;
  tick_lower: number | null;
  tick_upper: number | null;
  target_liquidity: string | null;
  created_at: Date;
}

const SELECT_COLUMNS = `target_nft, our_nft, dex, pool, target_wallet, locked_sol,
                        tick_lower, tick_upper, target_liquidity, created_at`;

function toEntry(row: PositionRow): PositionEntry {
  return {
    ourNft: row.our_nft,
    createdAt: fromTimestamp(row.created_at),
    pool: row.pool ?? undefined,
    targetWallet: row.target_wallet ?? undefined,
    lockedSol: numberOrUndefined(row.locked_sol),
    tickLower: row.tick_lower ?? undefined,
    tickUpper: row.tick_upper ?? undefined,
    dex: row.dex ?? undefined,
    targetLiquidity: row.target_liquidity ?? undefined,
  };
}

/**
 * Insert or replace a mapping.
 *
 * Matches PositionMap.set(): the entry is *replaced*, not merged, so re-setting
 * an existing target NFT resets createdAt to now and clears lockedSol and
 * targetLiquidity — those are written later by setLockedSol/setTargetLiquidity.
 */
export async function set(
  targetNft: string,
  ourNft: string,
  pool?: string,
  targetWallet?: string,
  tickLower?: number,
  tickUpper?: number,
  dex?: string,
): Promise<void> {
  await query(
    `INSERT INTO positions (target_nft, our_nft, pool, target_wallet, tick_lower, tick_upper, dex,
                            created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())
     ON CONFLICT (target_nft) DO UPDATE SET
       our_nft          = EXCLUDED.our_nft,
       pool             = EXCLUDED.pool,
       target_wallet    = EXCLUDED.target_wallet,
       tick_lower       = EXCLUDED.tick_lower,
       tick_upper       = EXCLUDED.tick_upper,
       dex              = EXCLUDED.dex,
       locked_sol       = NULL,
       target_liquidity = NULL,
       created_at       = EXCLUDED.created_at,
       updated_at       = now()`,
    [
      targetNft,
      ourNft,
      pool ?? null,
      targetWallet ?? null,
      tickLower ?? null,
      tickUpper ?? null,
      dex ?? null,
    ],
  );
}

/**
 * Write a mapping exactly as it was stored, `createdAt` included.
 *
 * set() is the executors' call and deliberately stamps created_at with now(),
 * because reusing a target NFT means a new position. The backfill wants the
 * opposite — the row as the JSON file had it, open time and all — so it gets its
 * own upsert rather than set() growing a flag to mean both things.
 */
export async function importEntry(targetNft: string, entry: PositionEntry): Promise<void> {
  await query(
    `INSERT INTO positions (target_nft, our_nft, pool, target_wallet, tick_lower, tick_upper, dex,
                            locked_sol, target_liquidity, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (target_nft) DO UPDATE SET
       our_nft          = EXCLUDED.our_nft,
       pool             = EXCLUDED.pool,
       target_wallet    = EXCLUDED.target_wallet,
       tick_lower       = EXCLUDED.tick_lower,
       tick_upper       = EXCLUDED.tick_upper,
       dex              = EXCLUDED.dex,
       locked_sol       = EXCLUDED.locked_sol,
       target_liquidity = EXCLUDED.target_liquidity,
       created_at       = EXCLUDED.created_at,
       updated_at       = now()`,
    [
      targetNft,
      entry.ourNft,
      entry.pool ?? null,
      entry.targetWallet ?? null,
      entry.tickLower ?? null,
      entry.tickUpper ?? null,
      entry.dex ?? null,
      entry.lockedSol ?? null,
      entry.targetLiquidity ?? null,
      toTimestamp(entry.createdAt),
    ],
  );
}

/** Our NFT mint for a target NFT. */
export async function get(targetNft: string): Promise<string | undefined> {
  const res = await query<{ our_nft: string }>(
    'SELECT our_nft FROM positions WHERE target_nft = $1',
    [targetNft],
  );
  return res.rows[0]?.our_nft;
}

/** Full entry for a target NFT. */
export async function getEntry(targetNft: string): Promise<PositionEntry | undefined> {
  const res = await query<PositionRow>(
    `SELECT ${SELECT_COLUMNS} FROM positions WHERE target_nft = $1`,
    [targetNft],
  );
  const row = res.rows[0];
  return row ? toEntry(row) : undefined;
}

export async function getPool(targetNft: string): Promise<string | undefined> {
  const res = await query<{ pool: string | null }>(
    'SELECT pool FROM positions WHERE target_nft = $1',
    [targetNft],
  );
  return res.rows[0]?.pool ?? undefined;
}

/** Dex tag for a target NFT — undefined means byreal, matching the JSON behaviour. */
export async function getDex(targetNft: string): Promise<string | undefined> {
  const res = await query<{ dex: string | null }>(
    'SELECT dex FROM positions WHERE target_nft = $1',
    [targetNft],
  );
  return res.rows[0]?.dex ?? undefined;
}

async function del(targetNft: string): Promise<void> {
  await query('DELETE FROM positions WHERE target_nft = $1', [targetNft]);
}

// `delete` is a keyword, so the implementation is named del and re-exported under
// the name the old PositionMap used. `positions.delete(nft)` reads the same.
export { del as delete };

/** Reverse lookup: find the target NFT that maps to a given NFT of ours. */
export async function findByOurNft(ourNft: string): Promise<string | undefined> {
  const res = await query<{ target_nft: string }>(
    'SELECT target_nft FROM positions WHERE our_nft = $1 LIMIT 1',
    [ourNft],
  );
  return res.rows[0]?.target_nft;
}

/** Delete by our NFT mint. Returns true when a row was removed. */
export async function deleteByOurNft(ourNft: string): Promise<boolean> {
  const res = await query('DELETE FROM positions WHERE our_nft = $1', [ourNft]);
  return (res.rowCount ?? 0) > 0;
}

/** [targetNft, ourNft] pairs for every mapping. */
export async function entries(): Promise<[string, string][]> {
  const res = await query<{ target_nft: string; our_nft: string }>(
    'SELECT target_nft, our_nft FROM positions ORDER BY created_at, target_nft',
  );
  return res.rows.map((r) => [r.target_nft, r.our_nft]);
}

export async function size(): Promise<number> {
  const res = await query<{ count: string }>('SELECT count(*) AS count FROM positions');
  return Number(res.rows[0].count);
}

export async function getAllMyNfts(): Promise<string[]> {
  const res = await query<{ our_nft: string }>('SELECT our_nft FROM positions');
  return res.rows.map((r) => r.our_nft);
}

/** Our NFT mints for Byreal positions only — an untagged dex counts as byreal. */
export async function getByrealNfts(): Promise<string[]> {
  const res = await query<{ our_nft: string }>(
    "SELECT our_nft FROM positions WHERE dex IS NULL OR dex = 'byreal'",
  );
  return res.rows.map((r) => r.our_nft);
}

export async function setDex(targetNft: string, dex: string): Promise<void> {
  await query('UPDATE positions SET dex = $2, updated_at = now() WHERE target_nft = $1', [
    targetNft,
    dex,
  ]);
}

export async function setPool(targetNft: string, pool: string): Promise<void> {
  await query('UPDATE positions SET pool = $2, updated_at = now() WHERE target_nft = $1', [
    targetNft,
    pool,
  ]);
}

export async function setLockedSol(targetNft: string, lockedSol: number): Promise<void> {
  await query('UPDATE positions SET locked_sol = $2, updated_at = now() WHERE target_nft = $1', [
    targetNft,
    lockedSol,
  ]);
}

export async function getLockedSol(targetNft: string, fallback: number): Promise<number> {
  const res = await query<{ locked_sol: string | null }>(
    'SELECT locked_sol FROM positions WHERE target_nft = $1',
    [targetNft],
  );
  return numberOrUndefined(res.rows[0]?.locked_sol ?? null) ?? fallback;
}

export async function setTargetLiquidity(targetNft: string, liquidity: string): Promise<void> {
  await query(
    'UPDATE positions SET target_liquidity = $2, updated_at = now() WHERE target_nft = $1',
    [targetNft, liquidity],
  );
}

export async function getTargetLiquidity(targetNft: string): Promise<string | undefined> {
  const res = await query<{ target_liquidity: string | null }>(
    'SELECT target_liquidity FROM positions WHERE target_nft = $1',
    [targetNft],
  );
  return res.rows[0]?.target_liquidity ?? undefined;
}

/**
 * True when another open position already covers the same wallet + pool + tick
 * range. Detects a target wallet opening duplicate positions under different
 * referers.
 */
export async function hasDuplicateTickRange(
  targetWallet: string,
  pool: string,
  tickLower: number,
  tickUpper: number,
): Promise<boolean> {
  const res = await query(
    `SELECT 1 FROM positions
     WHERE target_wallet = $1 AND pool = $2 AND tick_lower = $3 AND tick_upper = $4
     LIMIT 1`,
    [targetWallet, pool, tickLower, tickUpper],
  );
  return (res.rowCount ?? 0) > 0;
}

export interface DexCounts {
  byreal: number;
  orca: number;
  meteora: number;
  pancakeswap: number;
  dammv2: number;
}

/** The dex bucket an untagged or unrecognised row falls into. */
const DEX_BUCKET = `CASE WHEN dex IN ('orca', 'meteora', 'pancakeswap', 'dammv2')
                         THEN dex ELSE 'byreal' END`;

function emptyCounts(): DexCounts {
  return { byreal: 0, orca: 0, meteora: 0, pancakeswap: 0, dammv2: 0 };
}

export async function countByDex(): Promise<DexCounts> {
  const res = await query<{ bucket: keyof DexCounts; count: string }>(
    `SELECT ${DEX_BUCKET} AS bucket, count(*) AS count FROM positions GROUP BY 1`,
  );
  const out = emptyCounts();
  for (const row of res.rows) out[row.bucket] = Number(row.count);
  return out;
}

export async function getByrealOpenCount(): Promise<number> {
  return (await countByDex()).byreal;
}

/**
 * Sum lockedSol per dex, substituting a per-dex fallback for rows that never
 * recorded it. The fallback count and the recorded sum are both computed in SQL;
 * only the multiply-and-add happens here.
 */
export async function getTotalLockedSolByDex(
  byrealFallback: number,
  orcaFallback: number,
  meteoraFallback = 0.0079,
  pcsFallback = 0.0090132,
  dammv2Fallback = 0.0089088,
): Promise<DexCounts> {
  const res = await query<{ bucket: keyof DexCounts; recorded: string | null; missing: string }>(
    `SELECT ${DEX_BUCKET}                             AS bucket,
            sum(locked_sol)                           AS recorded,
            count(*) FILTER (WHERE locked_sol IS NULL) AS missing
     FROM positions GROUP BY 1`,
  );
  const fallbacks: DexCounts = {
    byreal: byrealFallback,
    orca: orcaFallback,
    meteora: meteoraFallback,
    pancakeswap: pcsFallback,
    dammv2: dammv2Fallback,
  };
  const out = emptyCounts();
  for (const row of res.rows) {
    out[row.bucket] = Number(row.recorded ?? 0) + Number(row.missing) * fallbacks[row.bucket];
  }
  return out;
}

/** Sum of lockedSol across all positions, using one fallback for unrecorded rows. */
export async function getTotalLockedSol(fallback: number): Promise<number> {
  const res = await query<{ recorded: string | null; missing: string }>(
    `SELECT sum(locked_sol) AS recorded, count(*) FILTER (WHERE locked_sol IS NULL) AS missing
     FROM positions`,
  );
  const row = res.rows[0];
  return Number(row.recorded ?? 0) + Number(row.missing) * fallback;
}

/** Entries with no pool recorded (backfill input). */
export async function entriesMissingPool(): Promise<[string, string][]> {
  const res = await query<{ target_nft: string; our_nft: string }>(
    'SELECT target_nft, our_nft FROM positions WHERE pool IS NULL',
  );
  return res.rows.map((r) => [r.target_nft, r.our_nft]);
}

/** Entries with no lockedSol recorded (backfill input). */
export async function entriesMissingLockedSol(): Promise<[string, string][]> {
  const res = await query<{ target_nft: string; our_nft: string }>(
    'SELECT target_nft, our_nft FROM positions WHERE locked_sol IS NULL',
  );
  return res.rows.map((r) => [r.target_nft, r.our_nft]);
}

/** Every mapping keyed by target NFT — the shape the dashboard serialises. */
export async function toJSON(): Promise<Record<string, PositionEntry>> {
  const res = await query<PositionRow>(`SELECT ${SELECT_COLUMNS} FROM positions`);
  const out: Record<string, PositionEntry> = {};
  for (const row of res.rows) out[row.target_nft] = toEntry(row);
  return out;
}
