/**
 * Referer positions we have already copied.
 *
 * The referer address identifies the position a target wallet itself copied
 * from, so recording it stops two of our target wallets both mirroring the same
 * underlying position. The Byreal executor checks it while deciding whether to
 * open, which is why reads stay synchronous and Postgres sees the mutation on
 * the write chain.
 *
 * The duplicate decision itself is not here: isRefererDuplicateEntry() weighs an
 * entry against the allow-lists in config, and that policy belongs to the
 * executor.
 */

import { openedReferers } from './repo';
import type { OpenedRefererEntry } from './repo/openedReferers';
import { WriteChain } from './write-chain';

const MODULE = 'OpenedReferers';

const map = new Map<string, OpenedRefererEntry>();
const writes = new WriteChain(MODULE);

/** Load the referers from Postgres and arm the write-through. */
export async function initOpenedReferers(): Promise<void> {
  const rows = await openedReferers.all();
  map.clear();
  for (const [refererPosition, entry] of Object.entries(rows)) map.set(refererPosition, entry);
  writes.enable();
}

/** Resolves once every queued write has reached Postgres. For shutdown and tests. */
export async function flushOpenedReferers(): Promise<void> {
  await writes.drain();
}

/** How many referers are recorded as opened. */
export function countOpenedReferers(): number {
  return map.size;
}

/** One referer's entry, or undefined. */
export function getOpenedReferer(refererPosition: string): OpenedRefererEntry | undefined {
  return map.get(refererPosition);
}

/** Every entry, in the Record<refererPosition, entry> shape the dashboard reads. */
export function allOpenedReferers(): Record<string, OpenedRefererEntry> {
  return Object.fromEntries(map);
}

/** Record a referer as opened. Re-recording the same referer overwrites it. */
export function addOpenedReferer(
  refererPosition: string,
  targetNft: string,
  ourNft: string,
  targetWallet: string,
): void {
  const entry: OpenedRefererEntry = { targetNft, ourNft, targetWallet, openedAt: Date.now() };
  map.set(refererPosition, entry);
  writes.push(`opened referer ${refererPosition.slice(0, 8)}`, () =>
    openedReferers.add(refererPosition, targetNft, ourNft, targetWallet, entry.openedAt),
  );
}

/**
 * Release the referer that a target NFT was opened under, so the underlying
 * position becomes copyable again once ours closes.
 *
 * Only the first match is removed, as the file version did. Memory already knows
 * which key it was, so the write deletes that row rather than everything
 * pointing at the NFT — which keeps the two copies saying the same thing if a
 * target NFT ever appears under two referers.
 *
 * @returns true when an entry was removed
 */
export function removeOpenedRefererByTargetNft(targetNft: string): boolean {
  for (const [refererPosition, entry] of map) {
    if (entry.targetNft === targetNft) {
      map.delete(refererPosition);
      writes.push(`opened referer removal ${refererPosition.slice(0, 8)}`, () =>
        openedReferers.delete(refererPosition),
      );
      return true;
    }
  }
  return false;
}
