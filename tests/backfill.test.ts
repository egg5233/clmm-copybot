/**
 * The backfill script against a real database.
 *
 * Every assertion here is about the two things that make a migration script
 * trustworthy: that a legacy `./data/` directory ends up in Postgres intact —
 * including the formats the stores themselves no longer know how to read — and
 * that running it a second time changes nothing.
 *
 * The script is driven through its exported run() rather than by spawning
 * ts-node, so the suite and the script share one process, one DATABASE_URL and
 * one connection pool.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseArgs, run } from '../scripts/migrate-json-to-pg';
import type { BackfillReport } from '../scripts/migrate-json-to-pg';
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
import { canRunRepoTests, useOwnTestDatabase } from './repo/setup';

const HOUR = 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

/** A snapshot with only the fields the collector always writes. */
function snapshot(ts: number, totalUsd: number) {
  return {
    ts,
    tokensUsd: 100,
    lpValueUsd: 200,
    unclaimedUsd: 3,
    bonusUsd: 4,
    lockedSolUsd: 5,
    totalUsd,
  };
}

/** The legacy data directory the tests import from. */
const FIXTURE = {
  // One modern entry and one in the oldest format, where the value was a bare
  // `ourNft` string.
  'position-map.json': {
    'target-nft-1': {
      ourNft: 'our-nft-1',
      createdAt: T0,
      pool: 'MINTA/MINTB',
      targetWallet: 'wallet-1',
      lockedSol: 0.0079,
      tickLower: -120,
      tickUpper: 120,
      dex: 'orca',
      targetLiquidity: '340282366920938463463374607431768211455',
    },
    'target-nft-2': 'our-nft-2',
  },
  'event-log.json': {
    poolMap: { 'target-nft-1': 'MINTA/MINTB' },
    events: [
      { ts: T0, type: 'OPEN', targetWallet: 'wallet-1', txSig: 'sig-open', success: true },
      { ts: T0 + 1, type: 'CLOSE', targetWallet: 'wallet-1', txSig: 'sig-close', success: true },
      {
        ts: T0 + 2,
        type: 'SKIP',
        targetWallet: 'wallet-2',
        success: false,
        error: 'pool below TVL floor',
      },
    ],
  },
  'asset-trend.json': {
    raw: [snapshot(T0, 1000), snapshot(T0 + 300_000, 1010)],
    hourly: [snapshot(T0 - HOUR, 990)],
    daily: [snapshot(T0 - 24 * HOUR, 900)],
  },
  'pending-swaps.json': {
    'mint-a': { pending: '12345', botReceived: '999', createdAt: T0 },
  },
  'swap-history.json': [
    { ts: T0, inputMint: 'mint-a', txSig: 'swap-1', inputAmountRaw: '1000', inputDecimals: 6 },
    { ts: T0 + 1, inputMint: 'mint-b', txSig: 'swap-2', outputAmountRaw: '2000' },
  ],
  'auth-log.json': [
    { ts: T0, ip: '10.0.0.1', event: '登入成功' },
    { ts: T0 + 1, ip: '10.0.0.2', event: '密碼錯誤' },
  ],
  'claim-history.json': [
    { ts: T0, week: '2026-W30', totalPools: 2, totalBonusUsd: 5.5, txSignatures: ['claim-1'] },
    {
      ts: T0 + 1,
      week: '2026-W31',
      totalPools: 0,
      totalBonusUsd: 0,
      txSignatures: [],
      error: 'API 500',
    },
  ],
  'dac-history.json': [
    {
      ts: T0,
      profitUsd: 30,
      dacAmountUsd: 10,
      cbbtcReceived: '0.0001',
      swapSig: 'dac-swap',
      transferSig: 'dac-transfer',
      transferTo: 'destination',
      status: 'success',
    },
    {
      ts: T0 + 1,
      profitUsd: 1,
      dacAmountUsd: 10,
      cbbtcReceived: '',
      swapSig: null,
      transferSig: null,
      transferTo: 'destination',
      status: 'skipped',
      reason: 'below threshold',
    },
  ],
  'token-pnl.json': {
    'mint-a': { totalPnl: -12.5, tradeCount: 3, lastLossPnl: -4, lastTradeAt: T0 },
    'mint-b': { totalPnl: 7, tradeCount: 1, lastLossPnl: 0, lastTradeAt: T0 },
  },
  // The second entry predates the fields that are now NOT NULL columns.
  'opened-referers.json': {
    'referer-1': {
      targetNft: 'target-nft-1',
      ourNft: 'our-nft-1',
      targetWallet: 'wallet-1',
      openedAt: T0,
    },
    'referer-2': { targetNft: 'target-nft-2' },
  },
  'pump-pending.json': {
    'pump-mint-1': {
      mint: 'pump-mint-1',
      symbol: 'PUMP1',
      pool: 'pump-mint-1/SOL',
      targetWallet: 'wallet-1',
      detectedAt: T0,
      status: 'approved',
      notifiedAt: T0 + 10,
      resolvedAt: T0 + 20,
    },
    'pump-mint-2': {
      mint: 'pump-mint-2',
      symbol: 'PUMP2',
      pool: 'pump-mint-2/SOL',
      targetWallet: 'wallet-2',
      detectedAt: T0,
      status: 'pending',
    },
  },
  // Not state: these stay on disk and the script must leave them alone.
  'token-names.json': { 'mint-a': { symbol: 'AAA' } },
  'tvl-cache.json': { pools: [] },
};

/** The formats that predate the current ones, in a directory of their own. */
const LEGACY_FIXTURE = {
  // event-log.json was a bare array before it grew a poolMap.
  'event-log.json': [
    { ts: T0, type: 'OPEN', targetWallet: 'wallet-9', txSig: 'legacy-sig', success: true },
  ],
  // asset-trend.json was a flat array of raw snapshots with no aggregates; the
  // hourly and daily tiers have to be rebuilt from it. Two of these share an
  // hour, so the rebuild has to pick the later one.
  'asset-trend.json': [
    snapshot(T0 - 25 * HOUR, 800),
    snapshot(T0 - HOUR, 900),
    snapshot(T0 - HOUR + 60_000, 910),
    snapshot(T0, 1000),
  ],
};

function writeFixture(files: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copybot-backfill-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(content));
  }
  return dir;
}

/** Row counts for every table the backfill writes. */
async function tableCounts(): Promise<Record<string, number>> {
  return {
    positions: await positions.size(),
    events: await events.count(),
    eventPoolMap: Object.keys(await events.poolMap()).length,
    snapshotsRaw: await snapshots.count('raw'),
    snapshotsHourly: await snapshots.count('hourly'),
    snapshotsDaily: await snapshots.count('daily'),
    pendingSwaps: Object.keys(await pendingSwaps.all()).length,
    swapHistory: await swapHistory.count(),
    authLog: await authLog.count(),
    claimHistory: await histories.countClaims(),
    dacHistory: await histories.countDac(),
    tokenPnl: Object.keys(await tokenPnl.all()).length,
    openedReferers: await openedReferers.count(),
    pumpPending: (await pumpPending.list()).length,
  };
}

describe.skipIf(!canRunRepoTests)('JSON to Postgres backfill', () => {
  useOwnTestDatabase('copybot_backfill');

  let dataDir = '';
  let legacyDir = '';

  beforeAll(() => {
    dataDir = writeFixture(FIXTURE);
    legacyDir = writeFixture(LEGACY_FIXTURE);
  });

  afterAll(() => {
    for (const dir of [dataDir, legacyDir]) {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function importFixture(dir = dataDir): Promise<BackfillReport> {
    return run({ dataDir: dir, dryRun: false });
  }

  it('imports every store from a legacy data directory', async () => {
    const report = await importFixture();

    expect(await tableCounts()).toEqual({
      positions: 2,
      events: 3,
      eventPoolMap: 1,
      snapshotsRaw: 2,
      snapshotsHourly: 1,
      snapshotsDaily: 1,
      pendingSwaps: 1,
      swapHistory: 2,
      authLog: 2,
      claimHistory: 2,
      dacHistory: 2,
      tokenPnl: 2,
      openedReferers: 2,
      pumpPending: 2,
    });
    expect(report.events).toEqual({ read: 3, imported: 3, skipped: 0 });
    expect(report.assetSnapshots).toEqual({ read: 4, imported: 4, skipped: 0 });
  });

  it('changes nothing on a second run', async () => {
    await importFixture();
    const afterFirst = await tableCounts();

    const report = await importFixture();

    expect(await tableCounts()).toEqual(afterFirst);
    // The append-only logs recognise their own rows and skip them; the keyed
    // stores upsert, so they report the same writes without adding rows.
    expect(report.events).toEqual({ read: 3, imported: 0, skipped: 3 });
    expect(report.swapHistory).toEqual({ read: 2, imported: 0, skipped: 2 });
    expect(report.authLog).toEqual({ read: 2, imported: 0, skipped: 2 });
    expect(report.claimHistory).toEqual({ read: 2, imported: 0, skipped: 2 });
    expect(report.dacHistory).toEqual({ read: 2, imported: 0, skipped: 2 });
    expect(report.positions).toEqual({ read: 2, imported: 2, skipped: 0 });
  });

  it('keeps a position exactly as the file had it, open time included', async () => {
    await importFixture();

    expect(await positions.getEntry('target-nft-1')).toEqual({
      ourNft: 'our-nft-1',
      createdAt: T0,
      pool: 'MINTA/MINTB',
      targetWallet: 'wallet-1',
      lockedSol: 0.0079,
      tickLower: -120,
      tickUpper: 120,
      dex: 'orca',
      targetLiquidity: '340282366920938463463374607431768211455',
    });
  });

  it('converts the oldest position format, where the value was a bare NFT string', async () => {
    await importFixture();

    // createdAt 0 is what the retired loader substituted: an entry from that era
    // has no recorded open time, and inventing one would misreport its age.
    expect(await positions.getEntry('target-nft-2')).toMatchObject({
      ourNft: 'our-nft-2',
      createdAt: 0,
    });
  });

  it('carries pump decisions across instead of resetting them to pending', async () => {
    await importFixture();

    expect(await pumpPending.get('pump-mint-1')).toMatchObject({
      status: 'approved',
      resolvedAt: T0 + 20,
    });
    expect(await pumpPending.isPending('pump-mint-2', T0 + 1000)).toBe(true);
  });

  it('fills the NOT NULL columns a legacy referer entry never had', async () => {
    await importFixture();

    expect(await openedReferers.get('referer-2')).toMatchObject({
      targetNft: 'target-nft-2',
      ourNft: '',
      targetWallet: '',
    });
  });

  it('round-trips the histories and the untyped payloads', async () => {
    await importFixture();

    expect((await histories.latestSuccessfulClaim())?.week).toBe('2026-W30');
    expect((await histories.listDac()).map((d) => d.status)).toEqual(['success', 'skipped']);
    expect(await tokenPnl.get('mint-a')).toEqual({
      totalPnl: -12.5,
      tradeCount: 3,
      lastLossPnl: -4,
      lastTradeAt: T0,
    });
    expect(await pendingSwaps.get('mint-a')).toEqual({
      pending: '12345',
      botReceived: '999',
      createdAt: T0,
    });
  });

  it('reads the pre-poolMap event log and rebuilds the asset tiers from a flat array', async () => {
    const report = await importFixture(legacyDir);

    expect(report.events).toEqual({ read: 1, imported: 1, skipped: 0 });
    expect(Object.keys(await events.poolMap())).toEqual([]);

    // Four raw snapshots spanning three hours and two days.
    expect(await snapshots.count('raw')).toBe(4);
    expect(await snapshots.count('hourly')).toBe(3);
    expect(await snapshots.count('daily')).toBe(2);

    // Last snapshot in the bucket wins, which is how the collector aggregates.
    const hourly = await snapshots.all('hourly');
    expect(hourly.map((s) => s.totalUsd)).toEqual([800, 910, 1000]);
  });

  it('reports what the files hold without writing anything on a dry run', async () => {
    const report = await run({ dataDir, dryRun: true });

    expect(report.positions).toEqual({ read: 2, imported: 0, skipped: 0 });
    expect(report.assetSnapshots).toEqual({ read: 4, imported: 0, skipped: 0 });
    expect(report.pumpPending).toEqual({ read: 2, imported: 0, skipped: 0 });
    expect(await positions.size()).toBe(0);
    expect(await events.count()).toBe(0);
  });

  it('imports nothing and does not throw when the directory is absent', async () => {
    const report = await run({ dataDir: path.join(dataDir, 'no-such-dir'), dryRun: false });

    expect(report.positions.read).toBe(0);
    expect(await positions.size()).toBe(0);
  });

  it('skips a corrupt file and imports the rest', async () => {
    const dir = writeFixture(FIXTURE);
    fs.writeFileSync(path.join(dir, 'token-pnl.json'), '{ this is not json');

    try {
      const report = await run({ dataDir: dir, dryRun: false });

      expect(report.tokenPnl).toEqual({ read: 0, imported: 0, skipped: 0 });
      expect(await positions.size()).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('backfill argument parsing', () => {
  it('defaults to ./data and no dry run', () => {
    expect(parseArgs([])).toEqual({ dataDir: './data', dryRun: false, help: false });
  });

  it('accepts --data-dir in both spellings, and --dry-run', () => {
    expect(parseArgs(['--data-dir', '/tmp/x', '--dry-run'])).toEqual({
      dataDir: '/tmp/x',
      dryRun: true,
      help: false,
    });
    expect(parseArgs(['--data-dir=/tmp/y']).dataDir).toBe('/tmp/y');
  });

  it('refuses an argument it does not know rather than importing the wrong directory', () => {
    expect(() => parseArgs(['--data-dur', '/tmp/x'])).toThrow('Unknown argument: --data-dur');
  });
});
