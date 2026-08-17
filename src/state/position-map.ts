import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';

const MODULE = 'PositionMap';

interface PositionEntry {
  ourNft: string;
  createdAt: number;
  pool?: string;  // e.g. "MNT/USDC"
  targetWallet?: string;  // which target wallet this position came from
  lockedSol?: number;  // SOL rent locked when this position was opened (lamports → SOL)
  tickLower?: number;  // tick range lower bound
  tickUpper?: number;  // tick range upper bound
  dex?: string;  // 'orca' for Orca Whirlpool positions (default: byreal)
  targetLiquidity?: string;  // target's liquidity at open time (BN string), for proportional decrease
}

/**
 * Maps target's position NFT mint -> our position NFT mint + timestamp.
 * Persisted to JSON file so it survives restarts.
 * Backward compatible: loads old string-only format automatically.
 */
export class PositionMap {
  private map: Map<string, PositionEntry> = new Map();
  private filePath: string;

  constructor(filePath: string = config.positionMapFile) {
    this.filePath = filePath;
    this.load();
  }

  private load(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        for (const [key, value] of Object.entries(data)) {
          if (typeof value === 'string') {
            // Migrate old format: string → PositionEntry
            this.map.set(key, { ourNft: value, createdAt: 0 });
          } else {
            this.map.set(key, value as PositionEntry);
          }
        }
        logger.info(MODULE, `Loaded ${this.map.size} position mappings`);
      }
    } catch (err: any) {
      logger.warn(MODULE, `Could not load position map: ${err.message}`);
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const obj: Record<string, PositionEntry> = {};
      for (const [key, entry] of this.map) {
        obj[key] = entry;
      }
      fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2));
    } catch (err: any) {
      logger.error(MODULE, `Could not save position map: ${err.message}`);
    }
  }

  set(targetNft: string, myNft: string, pool?: string, targetWallet?: string, tickLower?: number, tickUpper?: number, dex?: string): void {
    this.map.set(targetNft, { ourNft: myNft, createdAt: Date.now(), pool, targetWallet, tickLower, tickUpper, dex });
    this.save();
    logger.info(MODULE, `Mapped: ${targetNft.slice(0, 8)} -> ${myNft.slice(0, 8)}${pool ? ` (${pool})` : ''}${targetWallet ? ` from ${targetWallet.slice(0, 4)}..` : ''}`);
  }

  /**
   * Returns true if the position map already contains an open position from the same
   * targetWallet in the same pool with the same tick range (but a different NFT).
   * Used to detect when a target wallet opens duplicate positions with different referers.
   */
  hasDuplicateTickRange(targetWallet: string, pool: string, tickLower: number, tickUpper: number): boolean {
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
    this.save();
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
    return Array.from(this.map.values()).map(e => e.ourNft);
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
      this.save();
    }
  }

  size(): number {
    return this.map.size;
  }

  /** Count positions by dex type. Returns { byreal, orca, meteora, pancakeswap }. */
  countByDex(): { byreal: number; orca: number; meteora: number; pancakeswap: number; dammv2: number } {
    let byreal = 0, orca = 0, meteora = 0, pancakeswap = 0, dammv2 = 0;
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
  getTotalLockedSolByDex(byrealFallback: number, orcaFallback: number, meteoraFallback: number = 0.0079, pcsFallback: number = 0.0090132, dammv2Fallback: number = 0.0089088): { byreal: number; orca: number; meteora: number; pancakeswap: number; dammv2: number } {
    let byreal = 0, orca = 0, meteora = 0, pancakeswap = 0, dammv2 = 0;
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
      this.save();
    }
  }

  /** Set lockedSol for a position (called after open TX confirms). */
  setLockedSol(targetNft: string, lockedSol: number): void {
    const entry = this.map.get(targetNft);
    if (entry) {
      entry.lockedSol = lockedSol;
      this.save();
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
      this.save();
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
  toJSON(): Record<string, { ourNft: string; createdAt: number; pool?: string; targetWallet?: string; lockedSol?: number; tickLower?: number; tickUpper?: number; dex?: string }> {
    const obj: Record<string, { ourNft: string; createdAt: number; pool?: string; targetWallet?: string; lockedSol?: number; tickLower?: number; tickUpper?: number }> = {};
    for (const [key, entry] of this.map) {
      obj[key] = entry;
    }
    return obj;
  }
}
