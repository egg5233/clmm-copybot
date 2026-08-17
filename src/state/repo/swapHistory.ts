/**
 * `swap_history` repository — replaces data/swap-history.json.
 *
 * Two writers appended to that file independently: the Jupiter-swap path in
 * src/index.ts and the dashboard's force-swap route, each trimming its own
 * in-memory array to 40 before writing the file whole. Whichever wrote last won.
 * Here both writers INSERT, and the cap is a DELETE in the same transaction.
 */

import type { SwapHistoryEntry } from '../../dashboard/context';
import { fromTimestamp, query, toTimestamp, withTransaction } from '../db';

/** Matches MAX_SWAP_HISTORY in src/index.ts. */
export const MAX_SWAP_HISTORY = 40;

interface SwapRow {
  ts: Date;
  input_mint: string;
  tx_sig: string;
  input_amount_raw: string | null;
  input_decimals: number | null;
  output_amount_raw: string | null;
}

function toEntry(row: SwapRow): SwapHistoryEntry {
  return {
    ts: fromTimestamp(row.ts),
    inputMint: row.input_mint,
    txSig: row.tx_sig,
    inputAmountRaw: row.input_amount_raw ?? undefined,
    inputDecimals: row.input_decimals ?? undefined,
    outputAmountRaw: row.output_amount_raw ?? undefined,
  };
}

/** Append one swap and trim to the cap, in a single transaction. */
export async function push(entry: SwapHistoryEntry, cap = MAX_SWAP_HISTORY): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO swap_history (ts, input_mint, tx_sig, input_amount_raw, input_decimals, output_amount_raw)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        toTimestamp(entry.ts),
        entry.inputMint,
        entry.txSig,
        entry.inputAmountRaw ?? null,
        entry.inputDecimals ?? null,
        entry.outputAmountRaw ?? null,
      ],
    );
    await client.query(
      `DELETE FROM swap_history
       WHERE id < (SELECT id FROM swap_history ORDER BY id DESC OFFSET $1 LIMIT 1)`,
      [cap - 1],
    );
  });
}

/** Swaps oldest first, matching the array order the dashboard used to receive. */
export async function list(limit = MAX_SWAP_HISTORY): Promise<SwapHistoryEntry[]> {
  const res = await query<SwapRow>(
    `SELECT ts, input_mint, tx_sig, input_amount_raw, input_decimals, output_amount_raw
     FROM (SELECT * FROM swap_history ORDER BY id DESC LIMIT $1) AS newest
     ORDER BY id ASC`,
    [limit],
  );
  return res.rows.map(toEntry);
}

export async function count(): Promise<number> {
  const res = await query<{ count: string }>('SELECT count(*) AS count FROM swap_history');
  return Number(res.rows[0].count);
}
