/**
 * `pending_swaps` repository — replaces data/pending-swaps.json.
 *
 * The file was read-modify-written by four executor modules (byreal, orca,
 * meteora, dammv2) with no locking: each one parsed the entire
 * object, mutated its own mint, and wrote the whole thing back. Two closes
 * landing together meant the slower writer's parse was already stale, and its
 * write silently erased the other mint.
 *
 * Making each mint its own row removes that race structurally — a write to mint
 * A cannot touch mint B, whatever the interleaving. `accumulate()` closes the
 * remaining gap for two writers hitting the *same* mint, by doing the addition
 * inside the statement instead of in the caller.
 */

import { fromTimestamp, query } from '../db';

/**
 * Untyped on purpose, mirroring the current Record<string, any> on disk. The
 * shape the executors agree on is {pending, botReceived, createdAt}, all
 * base-unit amounts as decimal strings, but individual modules add fields.
 */
export type PendingSwapPayload = Record<string, unknown>;

export interface PendingSwapRow {
  inputMint: string;
  payload: PendingSwapPayload;
  updatedAt: number;
}

/** Fields holding BN base-unit amounts, which accumulate() can add into. */
export type AmountField = 'pending' | 'botReceived';

export async function get(inputMint: string): Promise<PendingSwapPayload | undefined> {
  const res = await query<{ payload: PendingSwapPayload }>(
    'SELECT payload FROM pending_swaps WHERE input_mint = $1',
    [inputMint],
  );
  return res.rows[0]?.payload;
}

/** Insert or replace the payload for one mint — a single-row write, never a whole-file rewrite. */
export async function set(inputMint: string, payload: PendingSwapPayload): Promise<void> {
  await query(
    `INSERT INTO pending_swaps (input_mint, payload, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (input_mint) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
    [inputMint, JSON.stringify(payload)],
  );
}

async function del(inputMint: string): Promise<void> {
  await query('DELETE FROM pending_swaps WHERE input_mint = $1', [inputMint]);
}

// Re-exported under the name the executors already use for this operation.
export { del as delete };

/** Every pending swap, in the Record<mint, payload> shape the dashboard reads. */
export async function all(): Promise<Record<string, PendingSwapPayload>> {
  const res = await query<{ input_mint: string; payload: PendingSwapPayload }>(
    'SELECT input_mint, payload FROM pending_swaps',
  );
  const out: Record<string, PendingSwapPayload> = {};
  for (const row of res.rows) out[row.input_mint] = row.payload;
  return out;
}

/** Same rows as all(), with the update timestamp, for staleness checks. */
export async function list(): Promise<PendingSwapRow[]> {
  const res = await query<{ input_mint: string; payload: PendingSwapPayload; updated_at: Date }>(
    'SELECT input_mint, payload, updated_at FROM pending_swaps ORDER BY updated_at',
  );
  return res.rows.map((r) => ({
    inputMint: r.input_mint,
    payload: r.payload,
    updatedAt: fromTimestamp(r.updated_at),
  }));
}

/** Remove every pending swap (dashboard "clear all"). */
export async function clear(): Promise<void> {
  await query('DELETE FROM pending_swaps');
}

/**
 * Add `delta` base units to one amount field, creating the row if absent.
 *
 * The arithmetic happens in SQL over NUMERIC, so two executors crediting the
 * same mint concurrently both land — the read-modify-write the executors do
 * today would lose one of them. NUMERIC is exact at u64 and u128 widths, and the
 * result goes back into JSONB as a string, which is what BN expects.
 *
 * @param delta decimal base-unit string (may be negative to subtract)
 * @returns the field's new value
 */
export async function accumulate(
  inputMint: string,
  field: AmountField,
  delta: string,
  createdAtMs: number = Date.now(),
): Promise<string> {
  const seed = JSON.stringify({ pending: '0', botReceived: '0', createdAt: createdAtMs });
  const res = await query<{ payload: Record<string, string> }>(
    `INSERT INTO pending_swaps (input_mint, payload, updated_at)
     VALUES ($1, jsonb_set($2::jsonb, ARRAY[$3::text], to_jsonb($4::numeric::text)), now())
     ON CONFLICT (input_mint) DO UPDATE SET
       payload = jsonb_set(
         pending_swaps.payload,
         ARRAY[$3::text],
         to_jsonb(
           ((COALESCE(pending_swaps.payload ->> $3, '0'))::numeric + $4::numeric)::text
         )
       ),
       updated_at = now()
     RETURNING payload`,
    [inputMint, seed, field, delta],
  );
  return res.rows[0].payload[field];
}
