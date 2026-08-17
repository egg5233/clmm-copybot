import { logger } from '../utils/logger';
import { positions } from './repo';
import type { PositionEntry } from './repo/positions';
import { WriteChain } from './write-chain';

const MODULE = 'PositionMap';

/**
 * Maps a target's position NFT mint to ours.
 *
 * Every read is synchronous and served from memory, which is what the executors
 * expect — they call this in the middle of building a transaction. Every
 * mutation updates that memory and queues the matching `positions` write, so
 * Postgres receives the same sequence of changes without anything waiting on it.
 *
 * init() must be awaited before the bot processes any target activity: it loads
 * the mappings that survived the restart and arms the write-through. An instance
 * that was never initialised is a plain in-memory map, which is how the unit
 * tests use it.
 */
export class PositionMap {
  private map: Map<string, PositionEntry> = new Map();
  private readonly writes = new WriteChain(MODULE);

  /** Load the mappings from Postgres and start persisting mutations. */
  async init(): Promise<void> {
    this.map = new Map(Object.entries(await positions.toJSON()));
    this.writes.enable();
    logger.info(MODULE, `Loaded ${this.map.size} position mappings`);
  }

  /** Resolves once every queued write has reached Postgres. For shutdown and tests. */
  async flush(): Promise<void> {
    await this.writes.drain();
  }

  set(
    targetNft: string,
    myNft: string,
    pool?: string,
    targetWallet?: string,
    tickLower?: number,
    tickUpper?: number,
    dex?: string,
  ): void {
    this.map.set(targetNft, {
      ourNft: myNft,
      createdAt: Date.now(),
      pool,
      targetWallet,
      tickLower,
      tickUpper,
      dex,
    });
    this.writes.push('position mapping', () =>
      positions.set(targetNft, myNft, pool, targetWallet, tickLower, tickUpper, dex),
    );
    logger.info(
      MODULE,
      `Mapped: ${targetNft.slice(0, 8)} -> ${myNft.slice(0, 8)}${pool ? ` (${pool})` : ''}${targetWallet ? ` from ${targetWallet.slice(0, 4)}..` : ''}`,
    );
  }

  /**
   * Returns true if the position map already contains an open position from the same
   * targetWallet in the same pool with the same tick range (but a different NFT).
   * Used to detect when a target wallet opens duplicate positions with different referers.
   */
  hasDuplicateTickRange(
    targetWallet: string,
    pool: string,
    tickLower: number,
    tickUpper: number,
  ): boolean {
    for (const entry of this.map.values()) {
      if (
        entry.targetWallet === targetWallet &&
        entry.pool === pool &&
        entry.tickLower === tickLower &&
        entry.tickUpper === tickUpper
      ) {
        return true;
      }
    }
    return false;
  }

  /** Get our NFT mint by target NFT (backward compatible). */
  get(targetNft: string): string | undefined {
    return this.map.get(targetNft)?.ourNft;
  }

  /** Get pool string (mintA/mintB) for a target NFT. */
  getPool(targetNft: string): string | undefined {
    return this.map.get(targetNft)?.pool;
  }

  delete(targetNft: string): void {
    this.map.delete(targetNft);
    this.writes.push('position removal', () => positions.delete(targetNft));
    logger.debug(MODULE, `Removed mapping for: ${targetNft.slice(0, 8)}`);
  }

  /** Reverse lookup: find targetNft by ourNft. */
  findByOurNft(ourNft: string): string | undefined {
    for (const [targetNft, entry] of this.map) {
      if (entry.ourNft === ourNft) return targetNft;
    }
    return undefined;
  }

  /** Delete a mapping by our NFT mint. Returns true when an entry was removed. */
  deleteByOurNft(ourNft: string): boolean {
    const targetNft = this.findByOurNft(ourNft);
    if (!targetNft) return false;
    this.delete(targetNft);
    return true;
  }

  getAllMyNfts(): string[] {
    return Array.from(this.map.values()).map((e) => e.ourNft);
  }

  /** Our NFT mints for Byreal positions only (legacy entries with no dex tag count as byreal). */
  getByrealNfts(): string[] {
    const out: string[] = [];
    for (const entry of this.map.values()) {
      if (!entry.dex || entry.dex === 'byreal') out.push(entry.ourNft);
    }
    return out;
  }

  entries(): [string, string][] {
    return Array.from(this.map.entries()).map(([k, v]) => [k, v.ourNft]);
  }

  /** Get dex type for a target NFT ('orca' or undefined for byreal). */
  getDex(targetNft: string): string | undefined {
    return this.map.get(targetNft)?.dex;
  }

  /** Set dex type for an existing entry (for backfill). */
  setDex(targetNft: string, dex: string): void {
    const entry = this.map.get(targetNft);
    if (entry) {
      entry.dex = dex;
      this.writes.push('position dex', () => positions.setDex(targetNft, dex));
    }
  }

  size(): number {
    return this.map.size;
  }

  /** Count positions by dex type. Returns { byreal, orca, meteora, pancakeswap }. */
  countByDex(): {
    byreal: number;
    orca: number;
    meteora: number;
    pancakeswap: number;
    dammv2: number;
  } {
    let byreal = 0,
      orca = 0,
      meteora = 0,
      pancakeswap = 0,
      dammv2 = 0;
    for (const entry of this.map.values()) {
      if (entry.dex === 'orca') orca++;
      else if (entry.dex === 'meteora') meteora++;
      else if (entry.dex === 'pancakeswap') pancakeswap++;
      else if (entry.dex === 'dammv2') dammv2++;
      else byreal++;
    }
    return { byreal, orca, meteora, pancakeswap, dammv2 };
  }

  getByrealOpenCount(): number {
    return this.countByDex().byreal;
  }

  /** Sum lockedSol by dex type. Returns { byreal, orca, meteora, pancakeswap, dammv2 }. */
  getTotalLockedSolByDex(
    byrealFallback: number,
    orcaFallback: number,
    meteoraFallback: number = 0.0079,
    pcsFallback: number = 0.0090132,
    dammv2Fallback: number = 0.0089088,
  ): { byreal: number; orca: number; meteora: number; pancakeswap: number; dammv2: number } {
    let byreal = 0,
      orca = 0,
      meteora = 0,
      pancakeswap = 0,
      dammv2 = 0;
    for (const entry of this.map.values()) {
      if (entry.dex === 'orca') {
        orca += entry.lockedSol ?? orcaFallback;
      } else if (entry.dex === 'meteora') {
        meteora += entry.lockedSol ?? meteoraFallback;
      } else if (entry.dex === 'pancakeswap') {
        pancakeswap += entry.lockedSol ?? pcsFallback;
      } else if (entry.dex === 'dammv2') {
        dammv2 += entry.lockedSol ?? dammv2Fallback;
      } else {
        byreal += entry.lockedSol ?? byrealFallback;
      }
    }
    return { byreal, orca, meteora, pancakeswap, dammv2 };
  }

  /** Get entries that are missing pool info (for backfill). */
  entriesMissingPool(): [string, string][] {
    const result: [string, string][] = [];
    for (const [key, entry] of this.map) {
      if (!entry.pool) result.push([key, entry.ourNft]);
    }
    return result;
  }

  /** Update pool info for an existing entry. */
  setPool(targetNft: string, pool: string): void {
    const entry = this.map.get(targetNft);
    if (entry) {
      entry.pool = pool;
      this.writes.push('position pool', () => positions.setPool(targetNft, pool));
    }
  }

  /** Set lockedSol for a position (called after open TX confirms). */
  setLockedSol(targetNft: string, lockedSol: number): void {
    const entry = this.map.get(targetNft);
    if (entry) {
      entry.lockedSol = lockedSol;
      this.writes.push('position locked SOL', () => positions.setLockedSol(targetNft, lockedSol));
    }
  }

  /** Get lockedSol for a position, or fallback if not recorded. */
  getLockedSol(targetNft: string, fallback: number): number {
    return this.map.get(targetNft)?.lockedSol ?? fallback;
  }

  /** Set target's liquidity at open time (for proportional decrease tracking). */
  setTargetLiquidity(targetNft: string, liquidity: string): void {
    const entry = this.map.get(targetNft);
    if (entry) {
      entry.targetLiquidity = liquidity;
      this.writes.push('position target liquidity', () =>
        positions.setTargetLiquidity(targetNft, liquidity),
      );
    }
  }

  /** Get target's last-known liquidity (set at open, updated after each decrease). */
  getTargetLiquidity(targetNft: string): string | undefined {
    return this.map.get(targetNft)?.targetLiquidity;
  }

  /** Sum of lockedSol across all positions, using fallback for entries without it. */
  getTotalLockedSol(fallback: number): number {
    let total = 0;
    for (const entry of this.map.values()) {
      total += entry.lockedSol ?? fallback;
    }
    return total;
  }

  /** Get entries that are missing lockedSol (for backfill). */
  entriesMissingLockedSol(): [string, string][] {
    const result: [string, string][] = [];
    for (const [key, entry] of this.map) {
      if (entry.lockedSol == null) result.push([key, entry.ourNft]);
    }
    return result;
  }

  /** Full data with timestamps (for dashboard). */
  toJSON(): Record<string, PositionEntry> {
    const obj: Record<string, PositionEntry> = {};
    for (const [key, entry] of this.map) {
      obj[key] = entry;
    }
    return obj;
  }
}
