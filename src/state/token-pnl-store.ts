/**
 * Per-token realised PnL — the input to the Byreal executor's consecutive-loss
 * cooldown.
 *
 * The executor used to read data/token-pnl.json, touch one mint, and write the
 * whole Record back on every close. It lives here for the same reason the
 * pending swaps do: recordTokenPnl() runs on the close path and must not wait on
 * a round trip, so memory answers the read and one row goes on the write chain.
 *
 * A store that was never initialised is a plain in-memory map, which is how the
 * executor unit tests use it.
 */

import { tokenPnl } from './repo';
import type { TokenPnlPayload } from './repo/tokenPnl';
import { WriteChain } from './write-chain';

const MODULE = 'TokenPnl';

const map = new Map<string, TokenPnlPayload>();
const writes = new WriteChain(MODULE);

/** Load every token's record from Postgres and arm the write-through. */
export async function initTokenPnl(): Promise<void> {
  const rows = await tokenPnl.all();
  map.clear();
  for (const [mint, payload] of Object.entries(rows)) map.set(mint, payload);
  writes.enable();
}

/** Resolves once every queued write has reached Postgres. For shutdown and tests. */
export async function flushTokenPnl(): Promise<void> {
  await writes.drain();
}

/** How many tokens have a PnL record. */
export function countTokenPnl(): number {
  return map.size;
}

/** One token's record, or undefined. */
export function getTokenPnl(mint: string): TokenPnlPayload | undefined {
  return map.get(mint);
}

/**
 * Every record, in the Record<mint, payload> shape the dashboard reads.
 *
 * A shallow copy holding the live payload objects: the dashboard merges display
 * fields into what it gets back, and it used to receive freshly parsed JSON, so
 * handing out the map itself would let that merge reach the store.
 */
export function allTokenPnl(): Record<string, TokenPnlPayload> {
  return Object.fromEntries(map);
}

/** Replace one token's record. */
export function setTokenPnl(mint: string, payload: TokenPnlPayload): void {
  map.set(mint, payload);
  writes.push(`token PnL ${mint.slice(0, 8)}`, () => tokenPnl.upsert(mint, payload));
}
