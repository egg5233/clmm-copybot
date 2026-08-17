/**
 * The asset trend collector's boot load.
 *
 * The chart is drawn from three in-memory arrays, and what fills them changed
 * from "parse asset-trend.json, recover from its .bak, then dedup both aggregate
 * tiers" to three queries. This pins the part the dashboard can see: after
 * starting, the tiers hold what Postgres holds, at their retention limits.
 *
 * The collector takes its first snapshot immediately, which needs a wallet and
 * the network. Neither exists here, so that attempt fails inside the collector's
 * own catch — `fetch` is stubbed to make the independence explicit rather than
 * incidental.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { config } from '../src/config';
import type { AssetSnapshot } from '../src/dashboard/asset-trend';
import {
  flushAssetTrend,
  getAssetTrend,
  getTrendLatestTs,
  startAssetTrendCollector,
  stopAssetTrendCollector,
} from '../src/dashboard/asset-trend';
import { snapshots } from '../src/state/repo';
import { canRunRepoTests, useOwnTestDatabase } from './repo/setup';

const T0 = 1_700_000_000_000;
const MINUTE = 60 * 1000;

function snapshot(ts: number, totalUsd: number): AssetSnapshot {
  return {
    ts,
    tokensUsd: 1,
    lpValueUsd: 2,
    unclaimedUsd: 3,
    bonusUsd: 4,
    lockedSolUsd: 5,
    totalUsd,
  };
}

describe.skipIf(!canRunRepoTests)('asset trend boot load', () => {
  useOwnTestDatabase('copybot_asset_trend_store', ['asset_snapshots']);

  const originalJupApiKey = config.jupApiKey;

  beforeEach(() => {
    config.jupApiKey = 'test-key';
    vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in tests')));
  });

  afterEach(async () => {
    stopAssetTrendCollector();
    await flushAssetTrend();
    vi.unstubAllGlobals();
    config.jupApiKey = originalJupApiKey;
  });

  it('fills the three tiers from Postgres', async () => {
    await snapshots.insert('raw', snapshot(T0, 1000));
    await snapshots.insert('raw', snapshot(T0 + 5 * MINUTE, 1010));
    await snapshots.insert('hourly', snapshot(T0 - 60 * MINUTE, 990));
    await snapshots.insert('daily', snapshot(T0 - 24 * 60 * MINUTE, 900));

    await startAssetTrendCollector();

    const trend = getAssetTrend();
    expect(trend.raw.map((s) => s.totalUsd)).toEqual([1000, 1010]);
    expect(trend.hourly.map((s) => s.totalUsd)).toEqual([990]);
    expect(trend.daily.map((s) => s.totalUsd)).toEqual([900]);
    expect(getTrendLatestTs()).toBe(T0 + 5 * MINUTE);
  });

  it('loads the raw tier at its retention limit, newest kept', async () => {
    const overCap = snapshots.MAX_RAW + 10;
    for (let i = 0; i < overCap; i++) {
      await snapshots.insert('raw', snapshot(T0 + i * MINUTE, i));
    }

    await startAssetTrendCollector();

    const { raw } = getAssetTrend();
    expect(raw).toHaveLength(snapshots.MAX_RAW);
    expect(raw[0].totalUsd).toBe(10);
    expect(raw.at(-1)?.totalUsd).toBe(overCap - 1);
  });

  it('starts empty rather than failing when nothing has been collected yet', async () => {
    await startAssetTrendCollector();

    expect(getAssetTrend()).toEqual({ raw: [], hourly: [], daily: [] });
    expect(getTrendLatestTs()).toBe(0);
  });

  it('does not load anything when JUP_API_KEY is unset', async () => {
    await startAssetTrendCollector();
    await snapshots.insert('raw', snapshot(T0, 1000));

    config.jupApiKey = '';
    await startAssetTrendCollector();

    // Unchanged from the file version: no key means no collector at all, so the
    // row written after the first load is not picked up by the second start.
    expect(getAssetTrend().raw).toEqual([]);
  });
});
