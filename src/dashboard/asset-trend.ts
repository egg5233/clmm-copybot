import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { getUserAddress } from '../utils/wallet';
import { getSolPrice, updateSolPrice } from './server';
import { logger } from '../utils/logger';
import { setLatestTotalUsd } from '../state/portfolio-state';

const MODULE = 'AssetTrend';
const TREND_FILE = './data/asset-trend.json';
const COLLECT_INTERVAL = 5 * 60 * 1000; // 5 minutes
const ANOMALY_PCT = 0.01; // 1% — re-query if totalUsd swings more than this ratio
const ANOMALY_REQUERY_DELAY = 60_000; // wait 60s before re-querying on anomaly

type CacheInvalidator = () => void;
type OrcaLpFetcher = () => Promise<{ lpUsd: number; feeUsd: number; count: number }>;
let cacheInvalidatorRef: CacheInvalidator | null = null;
let orcaLpFetcherRef: OrcaLpFetcher | null = null;
let snapshotInProgress = false;

// Token price cache — fallback when Jupiter Price API omits a mint
const priceCache = new Map<string, number>();

// Retention limits
const MAX_RAW = 576; // 48hr @ 5min
const MAX_HOURLY = 720; // 30d @ 1hr
// daily: no limit (permanent)

export interface AssetSnapshot {
  ts: number; // epoch ms
  tokensUsd: number; // on-chain wallet balances × price
  lpValueUsd: number; // Byreal + Orca + Meteora totalValue
  unclaimedUsd: number; // unclaimedFee + unclaimedRewards
  bonusUsd: number; // unclaimedBonus
  lockedSolUsd: number; // positionCount × rentPerPosition × SOL price
  totalUsd: number; // sum of all
  solPrice?: number; // SOL/USD price at snapshot time
  solBalanceUsd?: number; // SOL balance × solPrice (subset of tokensUsd)
  // Per-dex breakdown (v1.21.0+)
  byrealLpUsd?: number;
  orcaLpUsd?: number;
  byrealFeesUsd?: number;
  orcaFeesUsd?: number;
  byrealLockedUsd?: number;
  orcaLockedUsd?: number;
  meteoraLpUsd?: number;
  meteoraFeesUsd?: number;
  meteoraLockedUsd?: number;
  pcsLpUsd?: number;
  pcsFeesUsd?: number;
  pcsLockedUsd?: number;
  dammv2LpUsd?: number;
  dammv2FeesUsd?: number;
  dammv2LockedUsd?: number;
}

export interface TrendData {
  raw: AssetSnapshot[]; // 5min snapshots, keep 48hr
  hourly: AssetSnapshot[]; // hourly aggregates, keep 30d
  daily: AssetSnapshot[]; // daily aggregates, permanent
}

let trendData: TrendData = { raw: [], hourly: [], daily: [] };
let timer: ReturnType<typeof setInterval> | null = null;

// Callback invoked after each snapshot with the latest totalUsd
let snapshotCallback: ((totalUsd: number) => void) | null = null;

/** Return timestamp of latest raw snapshot (0 if none). Used by /api/status for frontend polling. */
export function getTrendLatestTs(): number {
  if (trendData.raw.length === 0) return 0;
  return trendData.raw[trendData.raw.length - 1].ts;
}

export function setSnapshotCallback(cb: (totalUsd: number) => void): void {
  snapshotCallback = cb;
}

// Track last aggregated hour/day to avoid duplicate aggregation
let lastAggregatedHour = 0;
let lastAggregatedDay = 0;

function floorToHour(ts: number): number {
  return Math.floor(ts / (60 * 60 * 1000)) * (60 * 60 * 1000);
}

function floorToDay(ts: number): number {
  return Math.floor(ts / (24 * 60 * 60 * 1000)) * (24 * 60 * 60 * 1000);
}

function tryParseTrendFile(filePath: string): TrendData | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content.trim()) return null; // empty file (truncated mid-write)
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      // Old flat array format
      return { raw: parsed, hourly: [], daily: [] };
    }
    if (parsed && typeof parsed === 'object' && parsed.raw) {
      return {
        raw: Array.isArray(parsed.raw) ? parsed.raw : [],
        hourly: Array.isArray(parsed.hourly) ? parsed.hourly : [],
        daily: Array.isArray(parsed.daily) ? parsed.daily : [],
      };
    }
    return null;
  } catch (err: any) {
    logger.warn(MODULE, `Failed to parse ${filePath}: ${err.message}`);
    return null;
  }
}

function loadTrend(): void {
  // Try main file first, then backup, then preserve in-memory state
  let loaded = tryParseTrendFile(TREND_FILE);
  if (!loaded) {
    const backupFile = TREND_FILE + '.bak';
    if (fs.existsSync(backupFile)) {
      logger.warn(MODULE, `Main trend file unreadable, attempting recovery from ${backupFile}`);
      loaded = tryParseTrendFile(backupFile);
      if (loaded) {
        logger.info(
          MODULE,
          `Recovered trend from backup: raw=${loaded.raw.length} hourly=${loaded.hourly.length} daily=${loaded.daily.length}`,
        );
      }
    }
  }

  if (loaded) {
    // Detect old flat array format and rebuild aggregates
    if (loaded.hourly.length === 0 && loaded.daily.length === 0 && loaded.raw.length > 0) {
      // Could be migration case OR new install — only rebuild if file was actually old format (array)
      const raw = fs.existsSync(TREND_FILE) ? fs.readFileSync(TREND_FILE, 'utf-8') : '';
      if (raw.trim().startsWith('[')) {
        logger.info(
          MODULE,
          `Migrating ${loaded.raw.length} old-format snapshots to tiered structure`,
        );
        trendData = loaded;
        rebuildAggregates();
        saveTrend();
      } else {
        trendData = loaded;
      }
    } else {
      trendData = loaded;
    }
  } else if (fs.existsSync(TREND_FILE)) {
    // File exists but unreadable AND no backup — preserve in-memory (don't wipe)
    logger.error(
      MODULE,
      `Trend file is corrupt and no backup available — keeping in-memory state intact`,
    );
    // trendData stays as whatever it was (initial { raw:[], hourly:[], daily:[] } on first load)
  }

  // Dedup hourly tier — fix historical bug that wrote multiple entries per hour
  if (trendData.hourly.length > 0) {
    const hourMap = new Map<number, AssetSnapshot>();
    for (const snap of trendData.hourly) {
      hourMap.set(floorToHour(snap.ts), snap); // last entry per hour wins
    }
    const dedupedH = [...hourMap.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s);
    if (dedupedH.length < trendData.hourly.length) {
      logger.info(MODULE, `Hourly dedup: ${trendData.hourly.length} → ${dedupedH.length}`);
      trendData.hourly = dedupedH;
    }
  }

  // Dedup daily tier — fix historical bug that wrote multiple entries per day
  if (trendData.daily.length > 0) {
    const dayMap = new Map<number, AssetSnapshot>();
    for (const snap of trendData.daily) {
      dayMap.set(floorToDay(snap.ts), snap); // last entry per day wins
    }
    const deduped = [...dayMap.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s);
    if (deduped.length < trendData.daily.length) {
      logger.info(MODULE, `Daily dedup: ${trendData.daily.length} → ${deduped.length}`);
      trendData.daily = deduped;
    }
  }

  // Init aggregation trackers from existing data
  if (trendData.hourly.length > 0) {
    lastAggregatedHour = floorToHour(trendData.hourly[trendData.hourly.length - 1].ts);
  }
  if (trendData.daily.length > 0) {
    lastAggregatedDay = floorToDay(trendData.daily[trendData.daily.length - 1].ts);
  }
}

/** Rebuild hourly/daily aggregates from raw data (used during migration) */
function rebuildAggregates(): void {
  const hourMap = new Map<number, AssetSnapshot>();
  const dayMap = new Map<number, AssetSnapshot>();

  for (const snap of trendData.raw) {
    const hourKey = floorToHour(snap.ts);
    hourMap.set(hourKey, snap); // last snapshot wins (represents end-of-hour)
    const dayKey = floorToDay(snap.ts);
    dayMap.set(dayKey, snap);
  }

  // Sort by key and extract values
  trendData.hourly = [...hourMap.entries()].sort((a, b) => a[0] - b[0]).map(([, snap]) => snap);
  trendData.daily = [...dayMap.entries()].sort((a, b) => a[0] - b[0]).map(([, snap]) => snap);
}

function saveTrend(): void {
  try {
    const dir = path.dirname(TREND_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Atomic write: write to temp, rotate current → .bak, rename temp → current
    const tmpFile = TREND_FILE + '.tmp';
    const backupFile = TREND_FILE + '.bak';
    const payload = JSON.stringify(trendData);
    fs.writeFileSync(tmpFile, payload);
    if (fs.existsSync(TREND_FILE)) {
      try {
        fs.copyFileSync(TREND_FILE, backupFile);
      } catch {
        /* best-effort */
      }
    }
    fs.renameSync(tmpFile, TREND_FILE);
  } catch (err: any) {
    logger.warn(MODULE, `Failed to save trend: ${err.message}`);
  }
}

export function getAssetTrend(): TrendData {
  return trendData;
}

async function fetchJupiterHoldings(
  address: string,
): Promise<{ mints: string[]; solBalance: number; holdings: Record<string, number> }> {
  const res = await fetch(`https://api.jup.ag/ultra/v1/holdings/${address}`, {
    headers: { 'x-api-key': config.jupApiKey },
  });
  if (!res.ok) throw new Error(`Jupiter holdings ${res.status}`);
  const data = (await res.json()) as any;

  const holdings: Record<string, number> = {};
  const mints: string[] = [];

  // Top-level uiAmount = SOL balance
  const solBalance = parseFloat(data.uiAmount || '0');

  // tokens is { [mint]: [{ uiAmount, ... }] }
  if (data.tokens && typeof data.tokens === 'object') {
    for (const [mint, accounts] of Object.entries(data.tokens)) {
      if (!Array.isArray(accounts)) continue;
      let total = 0;
      for (const acc of accounts as any[]) {
        if (acc.uiAmount > 0) total += acc.uiAmount;
      }
      if (total > 0) {
        holdings[mint] = total;
        mints.push(mint);
      }
    }
  }

  return { mints, solBalance, holdings };
}

async function fetchJupiterPrices(mints: string[]): Promise<Record<string, number>> {
  if (mints.length === 0) return {};
  const SOL_MINT = 'So11111111111111111111111111111111111111112';
  const allMints = [...mints, SOL_MINT];
  const res = await fetch(`https://api.jup.ag/price/v3?ids=${allMints.join(',')}`, {
    headers: { 'x-api-key': config.jupApiKey },
  });
  if (!res.ok) throw new Error(`Jupiter price ${res.status}`);
  const data = (await res.json()) as any;

  const prices: Record<string, number> = {};
  for (const [mint, info] of Object.entries(data)) {
    const p = (info as any)?.usdPrice;
    if (p) prices[mint] = parseFloat(String(p));
  }
  // Update price cache with fresh values
  for (const [mint, p] of Object.entries(prices)) {
    priceCache.set(mint, p);
  }
  return prices;
}

async function fetchByrealOverview(address: string): Promise<{
  totalValue: number;
  unclaimedFee: number;
  unclaimedRewards: number;
  openPositionCount: number;
}> {
  const res = await fetch(
    `https://api2.byreal.io/byreal/api/dex/v2/copyfarmer/providerOverview?providerAddress=${address}`,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json',
        Referer: 'https://www.byreal.io/',
      },
    },
  );
  if (!res.ok) throw new Error(`Byreal overview ${res.status}`);
  const data = (await res.json()) as any;
  const r = data?.result?.data;
  if (!r) throw new Error('Byreal overview empty');
  return {
    totalValue: parseFloat(r.totalValue || '0'),
    unclaimedFee: parseFloat(r.unclaimedFee || '0'),
    unclaimedRewards: parseFloat(r.unclaimedRewards || '0'),
    openPositionCount: parseInt(r.openPositionCount || '0'),
  };
}

const BYREAL_API_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Accept: 'application/json',
  Referer: 'https://www.byreal.io/',
};

/** Fetch unclaimed LP fees from position/unclaimed-v2 (same source as Byreal website). */
async function fetchByrealUnclaimedFees(address: string): Promise<number> {
  const res = await fetch(
    `https://api2.byreal.io/byreal/api/dex/v2/position/unclaimed-v2?userAddress=${address}`,
    { headers: BYREAL_API_HEADERS },
  );
  if (!res.ok) throw new Error(`Byreal unclaimed-v2 ${res.status}`);
  const data = (await res.json()) as any;
  const list: any[] = data?.result?.data?.list;
  if (!list) throw new Error('Byreal unclaimed-v2 empty');
  let total = 0;
  for (const item of list) {
    total += parseFloat(item.amount || '0') * parseFloat(item.price || '0');
  }
  return total;
}

async function fetchEpochBonus(address: string): Promise<number> {
  const [r1, r2] = await Promise.all([
    fetch(
      `https://api2.byreal.io/byreal/api/dex/v2/copyfarmer/epoch-bonus?walletAddress=${address}&type=1`,
      { headers: BYREAL_API_HEADERS },
    ),
    fetch(
      `https://api2.byreal.io/byreal/api/dex/v2/copyfarmer/epoch-bonus?walletAddress=${address}&type=2`,
      { headers: BYREAL_API_HEADERS },
    ),
  ]);
  if (!r1.ok) throw new Error(`Byreal epoch-bonus type=1 ${r1.status}`);
  if (!r2.ok) throw new Error(`Byreal epoch-bonus type=2 ${r2.status}`);
  const d1 = (await r1.json()) as any;
  const d2 = (await r2.json()) as any;
  const bonus1 = parseFloat(d1?.result?.data?.['1']?.totalBonusUsd || '0');
  const bonus2 = parseFloat(d2?.result?.data?.['2']?.totalBonusUsd || '0');
  return bonus1 + bonus2;
}

// Dynamic rent per position — set at startup by initRentPerPosition(), fallback to known value
let rentPerPosition = 0.0090132;
let orcaRentPerPosition = 0.0074542;

export function setRentPerPosition(value: number): void {
  rentPerPosition = value;
}

export function setOrcaRentPerPosition(value: number): void {
  orcaRentPerPosition = value;
}

export function setOrcaLpFetcher(fetcher: OrcaLpFetcher): void {
  orcaLpFetcherRef = fetcher;
}

type MeteoraLpFetcher = () => Promise<{ lpUsd: number; feeUsd: number; count: number }>;
let meteoraRentPerPosition = 0.0089088;
let meteoraLpFetcherRef: MeteoraLpFetcher | null = null;

export function setMeteoraRentPerPosition(value: number): void {
  meteoraRentPerPosition = value;
}

export function setMeteoraLpFetcher(fetcher: MeteoraLpFetcher): void {
  meteoraLpFetcherRef = fetcher;
}

type PcsLpFetcher = () => Promise<{ lpUsd: number; feeUsd: number; count: number }>;
let pcsRentPerPosition = 0.0090132;
let pcsLpFetcherRef: PcsLpFetcher | null = null;

export function setPcsRentPerPosition(value: number): void {
  pcsRentPerPosition = value;
}

export function setPcsLpFetcher(fetcher: PcsLpFetcher): void {
  pcsLpFetcherRef = fetcher;
}

type DammV2LpFetcher = () => Promise<{ lpUsd: number; feeUsd: number; count: number }>;
let dammv2RentPerPosition = 0.0089088;
let dammv2LpFetcherRef: DammV2LpFetcher | null = null;

export function setDammV2RentPerPosition(value: number): void {
  dammv2RentPerPosition = value;
}

export function setDammV2LpFetcher(fetcher: DammV2LpFetcher): void {
  dammv2LpFetcherRef = fetcher;
}

/** Fetch all data sources and calculate a snapshot (does NOT write to trendData). */
async function fetchSnapshotData(address: string): Promise<AssetSnapshot> {
  const [jupHoldings, byrealData, epochBonusUsd, byrealUnclaimedUsd] = await Promise.all([
    fetchJupiterHoldings(address),
    fetchByrealOverview(address),
    fetchEpochBonus(address),
    fetchByrealUnclaimedFees(address).catch((err: any) => {
      logger.debug(
        MODULE,
        `Byreal unclaimed-v2 failed, fallback to providerOverview: ${(err.message || '').slice(0, 80)}`,
      );
      return null;
    }),
  ]);

  const mints = Object.keys(jupHoldings.holdings);
  const prices = await fetchJupiterPrices(mints);

  const SOL_MINT = 'So11111111111111111111111111111111111111112';
  const solPrice = prices[SOL_MINT] || getSolPrice();
  if (prices[SOL_MINT]) updateSolPrice(prices[SOL_MINT]);

  const solBalanceUsd = jupHoldings.solBalance * solPrice;
  let tokensUsd = solBalanceUsd;
  for (const [mint, uiAmount] of Object.entries(jupHoldings.holdings)) {
    const price = prices[mint] || priceCache.get(mint) || 0;
    tokensUsd += uiAmount * price;
  }

  const byrealLpUsd = byrealData.totalValue;
  const byrealFeesUsd = byrealUnclaimedUsd ?? byrealData.unclaimedFee + byrealData.unclaimedRewards;
  const bonusUsd = epochBonusUsd;
  const byrealLockedUsd = byrealData.openPositionCount * rentPerPosition * solPrice;

  let orcaLpUsd = 0;
  let orcaFeesUsd = 0;
  let orcaLockedUsd = 0;

  // Add Orca LP value + fees if available
  if (orcaLpFetcherRef) {
    try {
      const orcaData = await orcaLpFetcherRef();
      orcaLpUsd = orcaData.lpUsd;
      orcaFeesUsd = orcaData.feeUsd;
      orcaLockedUsd = orcaData.count * orcaRentPerPosition * solPrice;
      if (orcaData.count > 0) {
        logger.debug(
          MODULE,
          `Orca LP: $${orcaData.lpUsd.toFixed(2)} + fees $${orcaData.feeUsd.toFixed(2)} (${orcaData.count} positions)`,
        );
      }
    } catch (err: any) {
      logger.debug(MODULE, `Orca LP fetch failed: ${(err.message || '').slice(0, 80)}`);
    }
  }

  let meteoraLpUsd = 0;
  let meteoraFeesUsd = 0;
  let meteoraLockedUsd = 0;

  // Add Meteora LP value + fees if available
  if (meteoraLpFetcherRef) {
    try {
      const meteoraData = await meteoraLpFetcherRef();
      meteoraLpUsd = meteoraData.lpUsd;
      meteoraFeesUsd = meteoraData.feeUsd;
      meteoraLockedUsd = meteoraData.count * meteoraRentPerPosition * solPrice;
      if (meteoraData.count > 0) {
        logger.debug(
          MODULE,
          `Meteora LP: $${meteoraData.lpUsd.toFixed(2)} + fees $${meteoraData.feeUsd.toFixed(2)} (${meteoraData.count} positions)`,
        );
      }
    } catch (err: any) {
      logger.debug(MODULE, `Meteora LP fetch failed: ${(err.message || '').slice(0, 80)}`);
    }
  }

  let pcsLpUsd = 0;
  let pcsFeesUsd = 0;
  let pcsLockedUsd = 0;

  if (pcsLpFetcherRef) {
    try {
      const pcsData = await pcsLpFetcherRef();
      pcsLpUsd = pcsData.lpUsd;
      pcsFeesUsd = pcsData.feeUsd;
      pcsLockedUsd = pcsData.count * pcsRentPerPosition * solPrice;
      if (pcsData.count > 0) {
        logger.debug(
          MODULE,
          `PCS LP: $${pcsData.lpUsd.toFixed(2)} + fees $${pcsData.feeUsd.toFixed(2)} (${pcsData.count} positions)`,
        );
      }
    } catch (err: any) {
      logger.debug(MODULE, `PCS LP fetch failed: ${(err.message || '').slice(0, 80)}`);
    }
  }

  let dammv2LpUsd = 0;
  let dammv2FeesUsd = 0;
  let dammv2LockedUsd = 0;

  if (dammv2LpFetcherRef) {
    try {
      const dammv2Data = await dammv2LpFetcherRef();
      dammv2LpUsd = dammv2Data.lpUsd;
      dammv2FeesUsd = dammv2Data.feeUsd;
      dammv2LockedUsd = dammv2Data.count * dammv2RentPerPosition * solPrice;
      if (dammv2Data.count > 0) {
        logger.debug(
          MODULE,
          `DAMM v2 LP: $${dammv2Data.lpUsd.toFixed(2)} + fees $${dammv2Data.feeUsd.toFixed(2)} (${dammv2Data.count} positions)`,
        );
      }
    } catch (err: any) {
      logger.debug(MODULE, `DAMM v2 LP fetch failed: ${(err.message || '').slice(0, 80)}`);
    }
  }

  const lpValueUsd = byrealLpUsd + orcaLpUsd + meteoraLpUsd + pcsLpUsd + dammv2LpUsd;
  const unclaimedUsd = byrealFeesUsd + orcaFeesUsd + meteoraFeesUsd + pcsFeesUsd + dammv2FeesUsd;
  const lockedSolUsd =
    byrealLockedUsd + orcaLockedUsd + meteoraLockedUsd + pcsLockedUsd + dammv2LockedUsd;
  const totalUsd = tokensUsd + lpValueUsd + unclaimedUsd + bonusUsd + lockedSolUsd;

  return {
    ts: Date.now(),
    tokensUsd: +tokensUsd.toFixed(2),
    lpValueUsd: +lpValueUsd.toFixed(2),
    unclaimedUsd: +unclaimedUsd.toFixed(2),
    bonusUsd: +bonusUsd.toFixed(2),
    lockedSolUsd: +lockedSolUsd.toFixed(2),
    totalUsd: +totalUsd.toFixed(2),
    solPrice: +solPrice.toFixed(4),
    solBalanceUsd: +solBalanceUsd.toFixed(2),
    byrealLpUsd: +byrealLpUsd.toFixed(2),
    orcaLpUsd: +orcaLpUsd.toFixed(2),
    byrealFeesUsd: +byrealFeesUsd.toFixed(2),
    orcaFeesUsd: +orcaFeesUsd.toFixed(2),
    byrealLockedUsd: +byrealLockedUsd.toFixed(2),
    orcaLockedUsd: +orcaLockedUsd.toFixed(2),
    meteoraLpUsd: +meteoraLpUsd.toFixed(2),
    meteoraFeesUsd: +meteoraFeesUsd.toFixed(2),
    meteoraLockedUsd: +meteoraLockedUsd.toFixed(2),
    pcsLpUsd: +pcsLpUsd.toFixed(2),
    pcsFeesUsd: +pcsFeesUsd.toFixed(2),
    pcsLockedUsd: +pcsLockedUsd.toFixed(2),
    dammv2LpUsd: +dammv2LpUsd.toFixed(2),
    dammv2FeesUsd: +dammv2FeesUsd.toFixed(2),
    dammv2LockedUsd: +dammv2LockedUsd.toFixed(2),
  };
}

/** Write a snapshot to trendData, aggregate tiers, enforce retention, save, and notify. */
function commitSnapshot(snapshot: AssetSnapshot): void {
  trendData.raw.push(snapshot);
  aggregateTiers(snapshot);

  // Enforce retention limits
  const now = Date.now();
  const rawCutoff = now - 48 * 60 * 60 * 1000;
  const hourlyCutoff = now - 30 * 24 * 60 * 60 * 1000;
  trendData.raw = trendData.raw.filter((s) => s.ts >= rawCutoff);
  trendData.hourly = trendData.hourly.filter((s) => s.ts >= hourlyCutoff);

  if (trendData.raw.length > MAX_RAW) {
    trendData.raw.splice(0, trendData.raw.length - MAX_RAW);
  }
  if (trendData.hourly.length > MAX_HOURLY) {
    trendData.hourly.splice(0, trendData.hourly.length - MAX_HOURLY);
  }

  saveTrend();
  logger.info(
    MODULE,
    `Snapshot: $${snapshot.totalUsd.toFixed(2)} (tokens=$${snapshot.tokensUsd.toFixed(2)} lp=$${snapshot.lpValueUsd.toFixed(2)} fees=$${snapshot.unclaimedUsd.toFixed(2)} bonus=$${snapshot.bonusUsd.toFixed(2)} locked=$${snapshot.lockedSolUsd.toFixed(2)}) [raw=${trendData.raw.length} hourly=${trendData.hourly.length} daily=${trendData.daily.length}]`,
  );

  // Update shared portfolio state (used by concentration filter in byreal-position.ts)
  setLatestTotalUsd(snapshot.totalUsd);

  if (snapshotCallback) {
    try {
      snapshotCallback(snapshot.totalUsd);
    } catch {}
  }
}

async function collectAssetSnapshot(): Promise<void> {
  if (snapshotInProgress) return;
  snapshotInProgress = true;
  const address = getUserAddress().toBase58();

  try {
    let snapshot = await fetchSnapshotData(address);

    // Anomaly detection: totalUsd swings >5% → wait 60s, re-query, use fresh data
    if (trendData.raw.length > 0) {
      const prev = trendData.raw[trendData.raw.length - 1];
      if (prev.totalUsd > 0) {
        const pctChange = Math.abs(snapshot.totalUsd - prev.totalUsd) / prev.totalUsd;
        if (pctChange >= ANOMALY_PCT) {
          logger.warn(
            MODULE,
            `Anomaly detected: $${prev.totalUsd} → $${snapshot.totalUsd} (${(pctChange * 100).toFixed(1)}%), re-querying in 60s...`,
          );
          await new Promise((resolve) => setTimeout(resolve, ANOMALY_REQUERY_DELAY));
          if (cacheInvalidatorRef) cacheInvalidatorRef();
          snapshot = await fetchSnapshotData(address);
          snapshot.ts = Date.now();
          const newPct =
            prev.totalUsd > 0
              ? (Math.abs(snapshot.totalUsd - prev.totalUsd) / prev.totalUsd) * 100
              : 0;
          logger.info(
            MODULE,
            `Re-query result: $${snapshot.totalUsd.toFixed(2)} (${newPct.toFixed(1)}% from prev)`,
          );
        }
      }
    }

    commitSnapshot(snapshot);
  } catch (err: any) {
    logger.warn(MODULE, `Snapshot failed (skipped): ${err.message}`);
  } finally {
    snapshotInProgress = false;
  }
}

/** Check if we've crossed an hour/day boundary and aggregate */
function aggregateTiers(snapshot: AssetSnapshot): void {
  const currentHour = floorToHour(snapshot.ts);
  const currentDay = floorToDay(snapshot.ts);

  // Hourly: if we've moved to a new hour, take the last raw snapshot from the previous hour
  if (lastAggregatedHour > 0 && currentHour > lastAggregatedHour) {
    // Find the last raw snapshot from the previous hour
    const prevHourEnd = currentHour; // exclusive boundary
    const prevHourStart = lastAggregatedHour;
    const candidates = trendData.raw.filter((s) => s.ts >= prevHourStart && s.ts < prevHourEnd);
    if (candidates.length > 0) {
      trendData.hourly.push(candidates[candidates.length - 1]);
    }
  }
  lastAggregatedHour = currentHour;

  // Daily: if we've moved to a new day, take the last hourly snapshot from the previous day
  if (lastAggregatedDay > 0 && currentDay > lastAggregatedDay) {
    const prevDayEnd = currentDay;
    const prevDayStart = lastAggregatedDay;
    const candidates = trendData.hourly.filter((s) => s.ts >= prevDayStart && s.ts < prevDayEnd);
    if (candidates.length > 0) {
      trendData.daily.push(candidates[candidates.length - 1]);
    }
  }
  lastAggregatedDay = currentDay;
}

export function startAssetTrendCollector(cacheInvalidator?: CacheInvalidator): void {
  if (!config.jupApiKey) {
    logger.warn(MODULE, 'JUP_API_KEY not set, asset trend disabled');
    return;
  }
  if (cacheInvalidator) cacheInvalidatorRef = cacheInvalidator;
  loadTrend();
  logger.info(
    MODULE,
    `Loaded trend: raw=${trendData.raw.length} hourly=${trendData.hourly.length} daily=${trendData.daily.length}`,
  );

  // Collect immediately, then start fixed 5-min interval (independent of operations)
  collectAssetSnapshot().catch(() => {});
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    collectAssetSnapshot().catch(() => {});
  }, COLLECT_INTERVAL);
}

/** Force an immediate snapshot (called by dashboard refresh button). */
export function forceSnapshot(): void {
  collectAssetSnapshot().catch(() => {});
}

export function stopAssetTrendCollector(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
