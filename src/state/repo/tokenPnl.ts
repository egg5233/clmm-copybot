/**
 * `token_pnl` repository — replaces data/token-pnl.json.
 *
 * Per-token realised PnL, which drives the consecutive-loss cooldown in the
 * Byreal executor. The file was a Record<mint, any> rewritten whole on every
 * close; here each mint is one row.
 */

import { fromTimestamp, query } from '../db';

/**
 * Untyped on purpose. The executor writes
 * {totalPnl, tradeCount, lastLossPnl, lastTradeAt} but the dashboard merges
 * display fields into the same object on read, so the shape is not closed.
 */
export type TokenPnlPayload = Record<string, unknown>;

export interface TokenPnlRow {
  mint: string;
  payload: TokenPnlPayload;
  updatedAt: number;
}

export async function get(mint: string): Promise<TokenPnlPayload | undefined> {
  const res = await query<{ payload: TokenPnlPayload }>(
    'SELECT payload FROM token_pnl WHERE mint = $1',
    [mint],
  );
  return res.rows[0]?.payload;
}

/** Insert or replace one token's record. */
export async function upsert(mint: string, payload: TokenPnlPayload): Promise<void> {
  await query(
    `INSERT INTO token_pnl (mint, payload, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (mint) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
    [mint, JSON.stringify(payload)],
  );
}

/** Every token's record, in the Record<mint, payload> shape the dashboard reads. */
export async function all(): Promise<Record<string, TokenPnlPayload>> {
  const res = await query<{ mint: string; payload: TokenPnlPayload }>(
    'SELECT mint, payload FROM token_pnl',
  );
  const out: Record<string, TokenPnlPayload> = {};
  for (const row of res.rows) out[row.mint] = row.payload;
  return out;
}

/** Same rows as all(), with the update timestamp. */
export async function list(): Promise<TokenPnlRow[]> {
  const res = await query<{ mint: string; payload: TokenPnlPayload; updated_at: Date }>(
    'SELECT mint, payload, updated_at FROM token_pnl ORDER BY updated_at DESC',
  );
  return res.rows.map((r) => ({
    mint: r.mint,
    payload: r.payload,
    updatedAt: fromTimestamp(r.updated_at),
  }));
}

async function del(mint: string): Promise<void> {
  await query('DELETE FROM token_pnl WHERE mint = $1', [mint]);
}

export { del as delete };
