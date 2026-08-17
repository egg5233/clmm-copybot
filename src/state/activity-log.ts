/**
 * The two activity feeds the dashboard renders: the event log and the swap
 * history.
 *
 * Both live here as plain arrays that the dashboard is handed directly through
 * BotContext, so rendering stays a synchronous read of the last 1000 events and
 * last 40 swaps. Appends go to memory first and to Postgres on the write chain.
 *
 * Owning both feeds in one module is what makes the swap history single-writer:
 * the bot's Jupiter path and the dashboard's force-swap route used to keep their
 * own arrays and each rewrite data/swap-history.json whole, so whichever wrote
 * last erased the other's entry. Both now call pushSwap().
 */

import type { EventLogEntry, SwapHistoryEntry } from '../dashboard/context';
import { events as eventsRepo, swapHistory as swapHistoryRepo } from './repo';
import { WriteChain } from './write-chain';

const MODULE = 'ActivityLog';

const eventLog: EventLogEntry[] = [];
const swapHistory: SwapHistoryEntry[] = [];

/**
 * Permanent target NFT -> pool lookup. It outlives the event cap, so an event
 * that scrolled out of the log can still be labelled with its pool.
 */
let poolMap: Record<string, string> = {};

const writes = new WriteChain(MODULE);

/** The live event log array — the dashboard holds this same reference. */
export function getEventLog(): EventLogEntry[] {
  return eventLog;
}

/** The live swap history array — the dashboard holds this same reference. */
export function getSwapHistory(): SwapHistoryEntry[] {
  return swapHistory;
}

/** Load both feeds and the pool lookup from Postgres, then arm the write-through. */
export async function initActivityLog(): Promise<void> {
  const [recentEvents, recentSwaps, pools] = await Promise.all([
    eventsRepo.recent(eventsRepo.MAX_EVENTS),
    swapHistoryRepo.list(swapHistoryRepo.MAX_SWAP_HISTORY),
    eventsRepo.poolMap(),
  ]);

  eventLog.length = 0;
  eventLog.push(...recentEvents);
  swapHistory.length = 0;
  swapHistory.push(...recentSwaps);
  poolMap = pools;

  writes.enable();
}

/** Resolves once every queued write has reached Postgres. For shutdown and tests. */
export async function flushActivityLog(): Promise<void> {
  await writes.drain();
}

/**
 * Give loaded events their pool label, and learn pools the position map knows.
 *
 * Only the lookup is persisted. Events fill their own pool column at append
 * time, so the rows that predate a lookup entry stay as they were written and
 * this pass relabels them again on the next boot — cheaper than an UPDATE across
 * the whole table, and it produces the same feed either way.
 *
 * @param positionPools target NFT -> pool, from the position map
 * @returns how many loaded events gained a pool, and the lookup's size
 */
export function backfillEventPools(positionPools: Record<string, string>): {
  backfilled: number;
  poolCount: number;
} {
  for (const [targetNft, pool] of Object.entries(positionPools)) {
    if (!poolMap[targetNft]) {
      poolMap[targetNft] = pool;
      writes.push('event pool lookup', () => eventsRepo.setPoolFor(targetNft, pool));
    }
  }
  for (const evt of eventLog) {
    const { targetNft, pool } = evt;
    if (pool && targetNft && !poolMap[targetNft]) {
      poolMap[targetNft] = pool;
      writes.push('event pool lookup', () => eventsRepo.setPoolFor(targetNft, pool));
    }
  }

  let backfilled = 0;
  for (const evt of eventLog) {
    if (!evt.pool && evt.targetNft && poolMap[evt.targetNft]) {
      evt.pool = poolMap[evt.targetNft];
      backfilled++;
    }
  }
  return { backfilled, poolCount: Object.keys(poolMap).length };
}

/**
 * Append one event to the feed.
 *
 * The database write is a single INSERT (plus the lookup upsert and the cap
 * DELETE, all in one transaction). The JSON version rewrote the entire
 * `{poolMap, events}` object on every append, which at the 1000-event cap meant
 * a ~336KB synchronous write per trade.
 *
 * Entries that fall off the in-memory ring leave their pool lookup behind. The
 * old file-backed version deleted it, purely to keep the file from growing;
 * `event_pool_map` is one small row per NFT and is meant to outlive the cap.
 */
export function pushEvent(entry: EventLogEntry, dex?: string): void {
  if (dex && !entry.dex) entry.dex = dex;
  if (entry.pool && entry.targetNft) poolMap[entry.targetNft] = entry.pool;

  eventLog.push(entry);
  while (eventLog.length > eventsRepo.MAX_EVENTS) eventLog.shift();

  writes.push('event', () => eventsRepo.append(entry));
}

/** Append one swap to the history. The only writer — bot and dashboard both call it. */
export function pushSwap(entry: SwapHistoryEntry): void {
  swapHistory.push(entry);
  while (swapHistory.length > swapHistoryRepo.MAX_SWAP_HISTORY) swapHistory.shift();

  writes.push('swap history', () => swapHistoryRepo.push(entry));
}
