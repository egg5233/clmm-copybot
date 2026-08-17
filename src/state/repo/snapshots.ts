/**
 * `asset_snapshots` repository — replaces data/asset-trend.json.
 *
 * The JSON file held three arrays (raw / hourly / daily) and was rewritten in
 * full every 5 minutes — about 1.2MB of I/O per snapshot once the daily tier had
 * accumulated. Here a snapshot is one row tagged with its granularity, so a
 * write costs one INSERT regardless of how much history exists.
 */

import type { AssetSnapshot } from '../../dashboard/asset-trend';
import { fromTimestamp, numberOrUndefined, query, toTimestamp } from '../db';

export type Granularity = 'raw' | 'hourly' | 'daily';

/** Retention caps from src/dashboard/asset-trend.ts. `daily` is unbounded. */
export const MAX_RAW = 576;
export const MAX_HOURLY = 720;

/**
 * Column name <-> AssetSnapshot field. Every value column is optional in the
 * type except the six totals, which the collector always writes.
 */
const VALUE_COLUMNS: ReadonlyArray<[column: string, field: keyof AssetSnapshot]> = [
  ['tokens_usd', 'tokensUsd'],
  ['lp_value_usd', 'lpValueUsd'],
  ['unclaimed_usd', 'unclaimedUsd'],
  ['bonus_usd', 'bonusUsd'],
  ['locked_sol_usd', 'lockedSolUsd'],
  ['total_usd', 'totalUsd'],
  ['sol_price', 'solPrice'],
  ['sol_balance_usd', 'solBalanceUsd'],
  ['byreal_lp_usd', 'byrealLpUsd'],
  ['byreal_fees_usd', 'byrealFeesUsd'],
  ['byreal_locked_usd', 'byrealLockedUsd'],
  ['orca_lp_usd', 'orcaLpUsd'],
  ['orca_fees_usd', 'orcaFeesUsd'],
  ['orca_locked_usd', 'orcaLockedUsd'],
  ['meteora_lp_usd', 'meteoraLpUsd'],
  ['meteora_fees_usd', 'meteoraFeesUsd'],
  ['meteora_locked_usd', 'meteoraLockedUsd'],
  ['pcs_lp_usd', 'pcsLpUsd'],
  ['pcs_fees_usd', 'pcsFeesUsd'],
  ['pcs_locked_usd', 'pcsLockedUsd'],
  ['dammv2_lp_usd', 'dammv2LpUsd'],
  ['dammv2_fees_usd', 'dammv2FeesUsd'],
  ['dammv2_locked_usd', 'dammv2LockedUsd'],
];

const SELECT_LIST = ['ts', ...VALUE_COLUMNS.map(([col]) => col)].join(', ');

type SnapshotRow = { ts: Date } & Record<string, string | null | Date>;

function toSnapshot(row: SnapshotRow): AssetSnapshot {
  // Built field by field from the column map, so it is only an AssetSnapshot once
  // the loop has run — hence assembling in a Record and asserting at the end.
  const out: Record<string, number> = { ts: fromTimestamp(row.ts) };
  for (const [column, field] of VALUE_COLUMNS) {
    const value = numberOrUndefined(row[column] as string | null);
    if (value !== undefined) out[field] = value;
  }
  return out as unknown as AssetSnapshot;
}

/**
 * Insert a snapshot, or overwrite the one already stored for that
 * (granularity, ts).
 *
 * Overwriting rather than erroring matches how the file-based collector behaved:
 * `loadTrend()` deduped the hourly and daily tiers with "last entry per bucket
 * wins" to repair a historical bug that appended several rows per hour. The
 * unique constraint plus this upsert make that class of duplicate unable to form
 * in the first place.
 */
export async function insert(granularity: Granularity, snapshot: AssetSnapshot): Promise<void> {
  const columns = ['granularity', 'ts', ...VALUE_COLUMNS.map(([col]) => col)];
  const values: unknown[] = [
    granularity,
    toTimestamp(snapshot.ts),
    ...VALUE_COLUMNS.map(([, field]) => snapshot[field] ?? null),
  ];
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const updates = VALUE_COLUMNS.map(([col]) => `${col} = EXCLUDED.${col}`).join(', ');

  await query(
    `INSERT INTO asset_snapshots (${columns.join(', ')}) VALUES (${placeholders})
     ON CONFLICT (granularity, ts) DO UPDATE SET ${updates}`,
    values,
  );
}

/** The newest `limit` snapshots for a tier, oldest first (the array order the chart expects). */
export async function latest(granularity: Granularity, limit: number): Promise<AssetSnapshot[]> {
  const res = await query<SnapshotRow>(
    `SELECT ${SELECT_LIST}
     FROM (SELECT * FROM asset_snapshots WHERE granularity = $1 ORDER BY ts DESC LIMIT $2) AS newest
     ORDER BY ts ASC`,
    [granularity, limit],
  );
  return res.rows.map(toSnapshot);
}

/** Every snapshot for a tier, oldest first. Used for `daily`, which has no cap. */
export async function all(granularity: Granularity): Promise<AssetSnapshot[]> {
  const res = await query<SnapshotRow>(
    `SELECT ${SELECT_LIST} FROM asset_snapshots WHERE granularity = $1 ORDER BY ts ASC`,
    [granularity],
  );
  return res.rows.map(toSnapshot);
}

/** Timestamp of the newest snapshot in a tier, or 0 when the tier is empty. */
export async function latestTs(granularity: Granularity): Promise<number> {
  const res = await query<{ ts: Date }>(
    'SELECT ts FROM asset_snapshots WHERE granularity = $1 ORDER BY ts DESC LIMIT 1',
    [granularity],
  );
  const row = res.rows[0];
  return row ? fromTimestamp(row.ts) : 0;
}

export async function count(granularity: Granularity): Promise<number> {
  const res = await query<{ count: string }>(
    'SELECT count(*) AS count FROM asset_snapshots WHERE granularity = $1',
    [granularity],
  );
  return Number(res.rows[0].count);
}

/** Drop everything beyond the newest `keep` snapshots in a tier. Returns rows deleted. */
export async function prune(granularity: Granularity, keep: number): Promise<number> {
  const res = await query(
    `DELETE FROM asset_snapshots
     WHERE granularity = $1
       AND ts < (SELECT ts FROM asset_snapshots WHERE granularity = $1
                 ORDER BY ts DESC OFFSET $2 LIMIT 1)`,
    [granularity, keep - 1],
  );
  return res.rowCount ?? 0;
}

/**
 * Drop snapshots older than a cutoff. The file-based collector enforced both a
 * count cap and a 48h/30d time window, so both are kept.
 */
export async function pruneOlderThan(granularity: Granularity, cutoffMs: number): Promise<number> {
  const res = await query('DELETE FROM asset_snapshots WHERE granularity = $1 AND ts < $2', [
    granularity,
    toTimestamp(cutoffMs),
  ]);
  return res.rowCount ?? 0;
}
