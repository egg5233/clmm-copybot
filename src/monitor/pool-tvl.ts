import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';
import { config } from '../config';
import { getJupiterLiquidity } from './jupiter-tvl';

const MODULE = 'PoolTvl';
const API_URL = 'https://api2.byreal.io/byreal/api/dex/v2/pools/info/list';
const PAGE_SIZE = 100;
const CACHE_FILE = path.resolve('./data/tvl-cache.json');
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Mobile Safari/537.36',
  'Accept': 'application/json',
  'Referer': 'https://www.byreal.io/',
  'Origin' : 'https://www.byreal.io/',
};

export interface PoolCacheEntry {
  tvl: number;
  openTime: number; // Unix timestamp (seconds, 10-digit)
}

// tokenMint → PoolCacheEntry
const tvlCache = new Map<string, PoolCacheEntry>();
let lastFetchAt = 0;
let timer: ReturnType<typeof setInterval> | null = null;

/** Returns the TVL for a given token mint, or null if not cached. */
export function getTokenTvl(tokenAddress: string): number | null {
  const entry = tvlCache.get(tokenAddress);
  return entry !== undefined ? entry.tvl : null;
}

/** Returns the full cache entry (tvl + openTime) for a given token mint, or null if not cached. */
export function getPoolInfo(tokenAddress: string): PoolCacheEntry | null {
  return tvlCache.get(tokenAddress) ?? null;
}

export function getTvlCacheInfo(): { size: number; lastFetchAt: number } {
  let ts = lastFetchAt;
  if (!ts) {
    try { ts = fs.statSync(CACHE_FILE).mtimeMs; } catch { /* ignore */ }
  }
  return { size: tvlCache.size, lastFetchAt: ts };
}

function saveCacheToFile(): void {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const entries: Record<string, PoolCacheEntry> = {};
    for (const [k, v] of tvlCache) entries[k] = v;
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ fetchedAt: lastFetchAt, entries }));
  } catch (err: any) {
    logger.warn(MODULE, `Failed to save TVL cache to file: ${err.message}`);
  }
}

function tryLoadFromFile(refreshMs: number): boolean {
  try {
    if (!fs.existsSync(CACHE_FILE)) return false;
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    if (!raw.fetchedAt || !raw.entries || typeof raw.entries !== 'object') return false;
    if (Date.now() - raw.fetchedAt > refreshMs) return false; // stale
    tvlCache.clear();
    for (const [k, v] of Object.entries(raw.entries)) {
      // Graceful backward-compat: old format stored a plain number
      if (typeof v === 'number') {
        tvlCache.set(k, { tvl: v, openTime: 0 });
      } else {
        const entry = v as PoolCacheEntry;
        tvlCache.set(k, { tvl: entry.tvl ?? 0, openTime: entry.openTime ?? 0 });
      }
    }
    lastFetchAt = raw.fetchedAt;
    const ageMin = Math.round((Date.now() - lastFetchAt) / 60000);
    logger.info(MODULE, `TVL cache loaded from file: ${tvlCache.size} tokens (age ${ageMin}min)`);
    return true;
  } catch {
    return false;
  }
}

export async function fetchAndCache(): Promise<void> {
  const newCache = new Map<string, PoolCacheEntry>();
  let page = 0;

  while (true) {
    const res = await fetch(`${API_URL}?page=${page}&pageSize=${PAGE_SIZE}`, { headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as any;
    const records: any[] = data?.result?.data?.records;
    if (!Array.isArray(records) || records.length === 0) break;

    for (const rec of records) {
      if (rec.baseMint?.mintInfo?.address !== undefined && rec.tvl !== undefined) {
        newCache.set(rec.baseMint.mintInfo.address, {
          tvl: parseFloat(rec.tvl) || 0,
          openTime: typeof rec.openTime === 'number' ? rec.openTime : parseInt(rec.openTime) || 0,
        });
      }
    }

    const total: number = data?.result?.data?.total ?? 0;
    if (page * PAGE_SIZE >= total) break;
    page++;
  }

  tvlCache.clear();
  for (const [k, v] of newCache) tvlCache.set(k, v);
  lastFetchAt = Date.now();
  logger.info(MODULE, `TVL cache updated: ${tvlCache.size} tokens across ${page} page(s)`);
  saveCacheToFile();
}

export function startPoolTvlCollector(refreshMinutes = 60): void {
  const ms = Math.max(15, refreshMinutes) * 60 * 1000;

  // Load from file if still fresh, otherwise fetch immediately
  if (!tryLoadFromFile(ms)) {
    fetchAndCache().catch(err => logger.warn(MODULE, `Initial fetch failed: ${err.message}`));
  }

  timer = setInterval(() => {
    fetchAndCache().catch(err => logger.warn(MODULE, `Refresh failed: ${err.message}`));
  }, ms);
  logger.info(MODULE, `Started, refresh every ${refreshMinutes}min`);
}

export function stopPoolTvlCollector(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

/**
 * Universal TVL/liquidity check — routes based on config.tvlSource.
 * - 'dex': uses dexFallback if provided, else Byreal pool-tvl cache
 * - 'jupiter': uses Jupiter Tokens V2 API (all DEXes)
 * Returns liquidity in USD, or null if unknown.
 */
export async function checkTokenLiquidity(
  mint: string,
  dexFallback?: () => Promise<number | null>,
): Promise<number | null> {
  if (config.tvlSource === 'jupiter') {
    return getJupiterLiquidity(mint);
  }
  // dex mode: use provided fallback or Byreal cache
  if (dexFallback) return dexFallback();
  return getTokenTvl(mint);
}

/** Update the refresh interval without triggering a new fetch */
export function setPoolTvlRefreshMinutes(refreshMinutes: number): void {
  if (timer) { clearInterval(timer); timer = null; }
  const ms = Math.max(15, refreshMinutes) * 60 * 1000;
  timer = setInterval(() => {
    fetchAndCache().catch(err => logger.warn(MODULE, `Refresh failed: ${err.message}`));
  }, ms);
  logger.info(MODULE, `Refresh interval updated to ${refreshMinutes}min`);
}
