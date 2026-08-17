/**
 * Repository layer over Postgres — one module per store that used to be a JSON
 * file under ./data/. All SQL lives in these modules; nothing else in the bot
 * writes queries, and only src/state/db.ts constructs a client.
 *
 * Import a namespace rather than loose functions, so a call reads as
 * `positions.get(nft)` / `events.append(entry)` and stays as legible as the
 * PositionMap method it replaces:
 *
 *   import { positions, events } from './state/repo';
 */

export * as authLog from './authLog';
export * as events from './events';
export * as histories from './histories';
export * as openedReferers from './openedReferers';
export * as pendingSwaps from './pendingSwaps';
export * as positions from './positions';
export * as pumpPending from './pumpPending';
export * as snapshots from './snapshots';
export * as swapHistory from './swapHistory';
export * as tokenPnl from './tokenPnl';
