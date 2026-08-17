/**
 * One-shot import of a legacy `./data/` directory into Postgres.
 *
 *   npm run backfill -- --data-dir ./data
 *   npm run backfill -- --dry-run
 *
 * Every JSON file the bot used to keep as state is read and written through the
 * repository layer — no SQL lives here, and the script gets exactly the upserts,
 * caps and type conversions the running bot gets.
 *
 * ## Idempotency
 *
 * Re-running must not duplicate anything, and the two kinds of store get there
 * differently:
 *
 * - **Keyed stores** (positions, pending swaps, token PnL, opened referers, pump
 *   pending, asset snapshots, the event pool map) upsert on their primary key.
 *   A second run rewrites the same rows with the same values, so it is reported
 *   as `imported` again while the table's row count does not move.
 * - **Append-only logs** (events, swap history, auth log, claim history, DAC
 *   history) have no natural key, so each one is matched against what the table
 *   already holds on a heuristic — a tuple of fields that a genuine record is
 *   not expected to repeat. Anything that matches is skipped.
 *
 * The per-store heuristics are documented at each importer. They are chosen to
 * be conservative in the direction that matters: a false match loses one
 * display-only history row, whereas a missed match would put a duplicate in
 * front of the operator on every re-run.
 *
 * ## Scope
 *
 * This is meant to run once, against a database that the migration has just
 * created. Running it against a populated database still refuses to duplicate,
 * but the capped logs are appended to rather than merged by timestamp, so their
 * cap may evict rows that were already there.
 *
 * `data/token-names.json`, `data/tvl-cache.json` and `data/bot.lock` are not
 * imported: they are caches and a lock file, and they stay on disk by design
 * (see docs/postgres-migration.md).
 */

import fs from 'fs';
import path from 'path';

import type { AssetSnapshot } from '../src/dashboard/asset-trend';
import type { EventLogEntry, SwapHistoryEntry } from '../src/dashboard/context';
import { closePool } from '../src/state/db';
import {
  authLog,
  events,
  histories,
  openedReferers,
  pendingSwaps,
  positions,
  pumpPending,
  snapshots,
  swapHistory,
  tokenPnl,
} from '../src/state/repo';
import type { ClaimHistoryEntry, DacRecord } from '../src/state/repo/histories';
import type { PositionEntry } from '../src/state/repo/positions';
import type { PumpPendingEntry } from '../src/state/repo/pumpPending';

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export interface StoreResult {
  /** Records the file held. */
  read: number;
  /** Records written to Postgres. */
  imported: number;
  /** Records not written: already present, or beyond the store's retention cap. */
  skipped: number;
}

/** One entry per store, keyed by the name printed in the summary. */
export type BackfillReport = Record<string, StoreResult>;

export interface BackfillOptions {
  /** Directory holding the legacy JSON files. */
  dataDir: string;
  /** Report what the files hold without connecting to Postgres. */
  dryRun: boolean;
}

const STORES = [
  'positions',
  'events',
  'eventPoolMap',
  'assetSnapshots',
  'pendingSwaps',
  'swapHistory',
  'authLog',
  'claimHistory',
  'dacHistory',
  'tokenPnl',
  'openedReferers',
  'pumpPending',
] as const;

type StoreName = (typeof STORES)[number];

function emptyReport(): BackfillReport {
  const report: BackfillReport = {};
  for (const store of STORES) report[store] = { read: 0, imported: 0, skipped: 0 };
  return report;
}

// ---------------------------------------------------------------------------
// Reading the legacy files
// ---------------------------------------------------------------------------

function warn(message: string): void {
  console.warn(`  ! ${message}`);
}

/**
 * Parse one file, or return undefined when it is absent, empty or unparseable.
 *
 * A corrupt file is a warning rather than a failure: the other eleven stores can
 * still be imported, and stopping the whole run over one of them would mean
 * hand-editing JSON before any of it lands.
 */
function readJson<T>(dataDir: string, file: string): T | undefined {
  const filePath = path.join(dataDir, file);
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    if (!content.trim()) return undefined;
    return JSON.parse(content) as T;
  } catch (err: unknown) {
    warn(`${file}: ${err instanceof Error ? err.message : String(err)} — skipping this store`);
    return undefined;
  }
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

// ---------------------------------------------------------------------------
// positions — data/position-map.json
// ---------------------------------------------------------------------------

/**
 * The file's oldest format stored a bare `ourNft` string per target NFT. The
 * store dropped that conversion when it moved to Postgres, because a JSON file
 * is no longer what it loads — so it lives here, which is the last thing that
 * will ever read one of those files.
 *
 * `createdAt: 0` is what the old loader substituted, and it is kept: an entry
 * from that era genuinely has no recorded open time, and inventing `now()` would
 * make every migrated position look freshly opened.
 */
function toPositionEntry(value: string | PositionEntry): PositionEntry {
  return typeof value === 'string' ? { ourNft: value, createdAt: 0 } : value;
}

async function importPositions(
  dataDir: string,
  result: StoreResult,
  dryRun: boolean,
): Promise<void> {
  const raw = readJson<Record<string, string | PositionEntry>>(dataDir, 'position-map.json');
  if (!raw) return;

  const entries = Object.entries(raw);
  result.read = entries.length;
  if (dryRun) return;

  for (const [targetNft, value] of entries) {
    await positions.importEntry(targetNft, toPositionEntry(value));
    result.imported++;
  }
}

// ---------------------------------------------------------------------------
// events + event_pool_map — data/event-log.json
// ---------------------------------------------------------------------------

interface EventLogFile {
  poolMap?: Record<string, string>;
  events?: EventLogEntry[];
}

/**
 * An event has no id of its own. `(ts, txSig, type)` is used as its identity:
 * the bot stamps `ts` with `Date.now()` at the moment it logs, so two events
 * sharing a millisecond, a signature and a type are the same event seen twice.
 */
function eventKey(entry: EventLogEntry): string {
  return `${entry.ts}|${entry.txSig ?? ''}|${entry.type}`;
}

async function importEvents(dataDir: string, report: BackfillReport, dryRun: boolean) {
  const raw = readJson<EventLogFile | EventLogEntry[]>(dataDir, 'event-log.json');
  if (!raw) return;

  // Both on-disk shapes: the current {poolMap, events} object and the bare array
  // it replaced.
  const entries = Array.isArray(raw) ? raw : asArray<EventLogEntry>(raw.events);
  const poolMap = Array.isArray(raw) ? {} : (raw.poolMap ?? {});

  const eventResult = report.events;
  const poolResult = report.eventPoolMap;
  eventResult.read = entries.length;
  poolResult.read = Object.keys(poolMap).length;
  if (dryRun) return;

  const existing = new Set((await events.recent(events.MAX_EVENTS)).map(eventKey));
  for (const entry of entries) {
    if (existing.has(eventKey(entry))) {
      eventResult.skipped++;
      continue;
    }
    await events.append(entry);
    eventResult.imported++;
  }

  for (const [targetNft, pool] of Object.entries(poolMap)) {
    await events.setPoolFor(targetNft, pool);
    poolResult.imported++;
  }
}

// ---------------------------------------------------------------------------
// asset_snapshots — data/asset-trend.json
// ---------------------------------------------------------------------------

interface TrendFile {
  raw?: AssetSnapshot[];
  hourly?: AssetSnapshot[];
  daily?: AssetSnapshot[];
}

/** Last snapshot in each bucket wins — the rule the collector aggregates by. */
function bucketBy(source: AssetSnapshot[], sizeMs: number): AssetSnapshot[] {
  const buckets = new Map<number, AssetSnapshot>();
  for (const snap of source) buckets.set(Math.floor(snap.ts / sizeMs) * sizeMs, snap);
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, snap]) => snap);
}

/** The newest `keep` snapshots, oldest first. */
function newest(source: AssetSnapshot[], keep: number): AssetSnapshot[] {
  const sorted = [...source].sort((a, b) => a.ts - b.ts);
  return sorted.slice(Math.max(0, sorted.length - keep));
}

async function importAssetSnapshots(
  dataDir: string,
  result: StoreResult,
  dryRun: boolean,
): Promise<void> {
  const raw = readJson<TrendFile | AssetSnapshot[]>(dataDir, 'asset-trend.json');
  if (!raw) return;

  // The oldest format was a flat array of raw snapshots with no aggregates. The
  // collector used to rebuild the tiers from it on first load; that rebuild lives
  // here now, so the store only ever sees a database with all three tiers.
  const isFlat = Array.isArray(raw);
  const rawTier = isFlat ? raw : asArray<AssetSnapshot>(raw.raw);
  const hourly = isFlat ? bucketBy(rawTier, 60 * 60 * 1000) : asArray<AssetSnapshot>(raw.hourly);
  const daily = isFlat ? bucketBy(rawTier, 24 * 60 * 60 * 1000) : asArray<AssetSnapshot>(raw.daily);

  result.read = rawTier.length + hourly.length + daily.length;
  if (dryRun) return;

  // Trimmed to the same limits the collector enforces, so an import lands the
  // database in the state a running bot would have kept it in.
  const tiers = [
    ['raw', newest(rawTier, snapshots.MAX_RAW)],
    ['hourly', newest(hourly, snapshots.MAX_HOURLY)],
    ['daily', daily],
  ] as const;

  for (const [granularity, tier] of tiers) {
    for (const snapshot of tier) {
      await snapshots.insert(granularity, snapshot);
      result.imported++;
    }
  }
  result.skipped = result.read - result.imported;
}

// ---------------------------------------------------------------------------
// pending_swaps — data/pending-swaps.json
// ---------------------------------------------------------------------------

async function importPendingSwaps(
  dataDir: string,
  result: StoreResult,
  dryRun: boolean,
): Promise<void> {
  const raw = readJson<Record<string, Record<string, unknown>>>(dataDir, 'pending-swaps.json');
  if (!raw) return;

  const entries = Object.entries(raw);
  result.read = entries.length;
  if (dryRun) return;

  for (const [inputMint, payload] of entries) {
    await pendingSwaps.set(inputMint, payload);
    result.imported++;
  }
}

// ---------------------------------------------------------------------------
// swap_history — data/swap-history.json
// ---------------------------------------------------------------------------

/**
 * A swap is identified by `(ts, txSig, inputMint)`. The signature alone would be
 * enough on-chain, but the file also holds entries whose send failed before a
 * signature was known, and those carry an empty string.
 */
function swapKey(entry: SwapHistoryEntry): string {
  return `${entry.ts}|${entry.txSig}|${entry.inputMint}`;
}

async function importSwapHistory(
  dataDir: string,
  result: StoreResult,
  dryRun: boolean,
): Promise<void> {
  const entries = asArray<SwapHistoryEntry>(
    readJson<SwapHistoryEntry[]>(dataDir, 'swap-history.json'),
  );
  result.read = entries.length;
  if (dryRun || entries.length === 0) return;

  const existing = new Set((await swapHistory.list(swapHistory.MAX_SWAP_HISTORY)).map(swapKey));
  for (const entry of entries) {
    if (existing.has(swapKey(entry))) {
      result.skipped++;
      continue;
    }
    await swapHistory.push(entry);
    result.imported++;
  }
}

// ---------------------------------------------------------------------------
// auth_log — data/auth-log.json
// ---------------------------------------------------------------------------

interface AuthLogRecord {
  ts: number;
  ip: string;
  event: string;
}

/** The whole row is the key: an attempt is a timestamp, an address and a label. */
function authKey(entry: AuthLogRecord): string {
  return `${entry.ts}|${entry.ip}|${entry.event}`;
}

async function importAuthLog(dataDir: string, result: StoreResult, dryRun: boolean): Promise<void> {
  const entries = asArray<AuthLogRecord>(readJson<AuthLogRecord[]>(dataDir, 'auth-log.json'));
  result.read = entries.length;
  if (dryRun || entries.length === 0) return;

  const existing = new Set((await authLog.list(authLog.MAX_AUTH_LOG)).map(authKey));
  for (const entry of entries) {
    if (existing.has(authKey(entry))) {
      result.skipped++;
      continue;
    }
    await authLog.push(entry.ip, entry.event, entry.ts);
    result.imported++;
  }
}

// ---------------------------------------------------------------------------
// claim_history — data/claim-history.json
// ---------------------------------------------------------------------------

/**
 * `(ts, week)` identifies a claim run. A week can hold a failed attempt and a
 * later successful one, so the week alone would collapse them; the timestamp
 * separates them.
 */
function claimKey(entry: ClaimHistoryEntry): string {
  return `${entry.ts}|${entry.week}`;
}

async function importClaimHistory(
  dataDir: string,
  result: StoreResult,
  dryRun: boolean,
): Promise<void> {
  const entries = asArray<ClaimHistoryEntry>(
    readJson<ClaimHistoryEntry[]>(dataDir, 'claim-history.json'),
  );
  result.read = entries.length;
  if (dryRun || entries.length === 0) return;

  const existing = new Set((await histories.listClaims()).map(claimKey));
  for (const entry of entries) {
    if (existing.has(claimKey(entry))) {
      result.skipped++;
      continue;
    }
    await histories.pushClaim(entry);
    result.imported++;
  }
}

// ---------------------------------------------------------------------------
// dac_history — data/dac-history.json
// ---------------------------------------------------------------------------

/**
 * `(ts, status, swapSig)` identifies a DAC run. The status and signature are in
 * the key because a skipped run has no signature at all, and several of those
 * can share a day — only the timestamp tells them apart.
 */
function dacKey(record: DacRecord): string {
  return `${record.ts}|${record.status}|${record.swapSig ?? ''}`;
}

async function importDacHistory(
  dataDir: string,
  result: StoreResult,
  dryRun: boolean,
): Promise<void> {
  const records = asArray<DacRecord>(readJson<DacRecord[]>(dataDir, 'dac-history.json'));
  result.read = records.length;
  if (dryRun || records.length === 0) return;

  const existing = new Set((await histories.listDac()).map(dacKey));
  for (const record of records) {
    if (existing.has(dacKey(record))) {
      result.skipped++;
      continue;
    }
    await histories.pushDac(record);
    result.imported++;
  }
}

// ---------------------------------------------------------------------------
// token_pnl — data/token-pnl.json
// ---------------------------------------------------------------------------

async function importTokenPnl(
  dataDir: string,
  result: StoreResult,
  dryRun: boolean,
): Promise<void> {
  const raw = readJson<Record<string, Record<string, unknown>>>(dataDir, 'token-pnl.json');
  if (!raw) return;

  const entries = Object.entries(raw);
  result.read = entries.length;
  if (dryRun) return;

  for (const [mint, payload] of entries) {
    await tokenPnl.upsert(mint, payload);
    result.imported++;
  }
}

// ---------------------------------------------------------------------------
// opened_referers — data/opened-referers.json
// ---------------------------------------------------------------------------

interface RefererRecord {
  targetNft?: string;
  ourNft?: string;
  targetWallet?: string;
  openedAt?: number;
}

async function importOpenedReferers(
  dataDir: string,
  result: StoreResult,
  dryRun: boolean,
): Promise<void> {
  const raw = readJson<Record<string, RefererRecord>>(dataDir, 'opened-referers.json');
  if (!raw) return;

  const entries = Object.entries(raw);
  result.read = entries.length;
  if (dryRun) return;

  for (const [refererPosition, entry] of entries) {
    // The columns are NOT NULL, and entries written before a field existed omit
    // it. Empty string is what the schema already expects for our_nft — a referer
    // is recorded before the open TX confirms.
    await openedReferers.add(
      refererPosition,
      entry.targetNft ?? '',
      entry.ourNft ?? '',
      entry.targetWallet ?? '',
      entry.openedAt ?? Date.now(),
    );
    result.imported++;
  }
}

// ---------------------------------------------------------------------------
// pump_pending — data/pump-pending.json
// ---------------------------------------------------------------------------

async function importPumpPending(
  dataDir: string,
  result: StoreResult,
  dryRun: boolean,
): Promise<void> {
  const raw = readJson<Record<string, PumpPendingEntry>>(dataDir, 'pump-pending.json');
  if (!raw) return;

  const entries = Object.entries(raw);
  result.read = entries.length;
  if (dryRun) return;

  for (const [mint, entry] of entries) {
    // importEntry rather than add(): the file's approved and rejected decisions
    // have to survive, and add() lands every row as pending.
    await pumpPending.importEntry({ ...entry, mint: entry.mint ?? mint });
    result.imported++;
  }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/**
 * Import every store from `dataDir`.
 *
 * Stores run one after another rather than in parallel: this is a one-shot
 * migration where a readable failure matters more than the runtime, and the
 * capped logs depend on insertion order.
 */
export async function run(options: BackfillOptions): Promise<BackfillReport> {
  const { dataDir, dryRun } = options;
  const report = emptyReport();

  if (!fs.existsSync(dataDir)) {
    warn(`${dataDir} does not exist — nothing to import`);
    return report;
  }

  await importPositions(dataDir, report.positions, dryRun);
  await importEvents(dataDir, report, dryRun);
  await importAssetSnapshots(dataDir, report.assetSnapshots, dryRun);
  await importPendingSwaps(dataDir, report.pendingSwaps, dryRun);
  await importSwapHistory(dataDir, report.swapHistory, dryRun);
  await importAuthLog(dataDir, report.authLog, dryRun);
  await importClaimHistory(dataDir, report.claimHistory, dryRun);
  await importDacHistory(dataDir, report.dacHistory, dryRun);
  await importTokenPnl(dataDir, report.tokenPnl, dryRun);
  await importOpenedReferers(dataDir, report.openedReferers, dryRun);
  await importPumpPending(dataDir, report.pumpPending, dryRun);

  return report;
}

const USAGE = `Import a legacy ./data/ directory into Postgres.

Usage: npm run backfill -- [options]

Options:
  --data-dir <path>   Directory holding the JSON files (default: ./data)
  --dry-run           Report what the files hold; do not touch Postgres
  --help              Show this message

DATABASE_URL must point at a migrated database unless --dry-run is given.`;

export function parseArgs(argv: string[]): BackfillOptions & { help: boolean } {
  const options = { dataDir: './data', dryRun: false, help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--data-dir') options.dataDir = argv[++i] ?? options.dataDir;
    else if (arg.startsWith('--data-dir=')) options.dataDir = arg.slice('--data-dir='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printReport(report: BackfillReport, dryRun: boolean): void {
  const width = Math.max(...STORES.map((s) => s.length));
  console.log('');
  for (const store of STORES) {
    const { read, imported, skipped } = report[store as StoreName];
    const detail = dryRun ? '' : `  imported ${imported}  skipped ${skipped}`;
    console.log(`  ${store.padEnd(width)}  read ${String(read).padStart(5)}${detail}`);
  }
  console.log('');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const mode = options.dryRun ? 'DRY RUN — nothing will be written' : 'importing';
  console.log(`Backfill from ${path.resolve(options.dataDir)} (${mode})`);

  try {
    printReport(await run(options), options.dryRun);
  } finally {
    if (!options.dryRun) await closePool();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
