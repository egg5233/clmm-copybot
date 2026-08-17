import { describe, expect, it } from 'vitest';
import type { AssetSnapshot } from '../../src/dashboard/asset-trend';
import { getPool } from '../../src/state/db';
import * as snapshots from '../../src/state/repo/snapshots';
import { canRunRepoTests, useTestDatabase } from './setup';

function snapshot(overrides: Partial<AssetSnapshot> = {}): AssetSnapshot {
  return {
    ts: 1_700_000_000_000,
    tokensUsd: 100.5,
    lpValueUsd: 200.25,
    unclaimedUsd: 3.5,
    bonusUsd: 1.25,
    lockedSolUsd: 4.75,
    totalUsd: 310.25,
    ...overrides,
  };
}

describe.skipIf(!canRunRepoTests)('snapshots repository', () => {
  useTestDatabase(['asset_snapshots']);

  describe('insert and read back', () => {
    it('round-trips the six required totals', async () => {
      const snap = snapshot();
      await snapshots.insert('raw', snap);

      expect(await snapshots.latest('raw', 10)).toEqual([snap]);
    });

    it('round-trips the full per-dex breakdown', async () => {
      const snap = snapshot({
        solPrice: 183.4521,
        solBalanceUsd: 42.5,
        byrealLpUsd: 10.1,
        byrealFeesUsd: 0.11,
        byrealLockedUsd: 1.01,
        orcaLpUsd: 20.2,
        orcaFeesUsd: 0.22,
        orcaLockedUsd: 2.02,
        meteoraLpUsd: 30.3,
        meteoraFeesUsd: 0.33,
        meteoraLockedUsd: 3.03,
        pcsLpUsd: 40.4,
        pcsFeesUsd: 0.44,
        pcsLockedUsd: 4.04,
        dammv2LpUsd: 50.5,
        dammv2FeesUsd: 0.55,
        dammv2LockedUsd: 5.05,
      });
      await snapshots.insert('raw', snap);

      expect(await snapshots.latest('raw', 10)).toEqual([snap]);
    });

    it('omits absent optional fields instead of returning null', async () => {
      await snapshots.insert('raw', snapshot());

      const [read] = await snapshots.latest('raw', 10);
      expect('solPrice' in read).toBe(false);
      expect('orcaLpUsd' in read).toBe(false);
    });

    it('keeps the tiers independent', async () => {
      await snapshots.insert('raw', snapshot({ ts: 1000, totalUsd: 1 }));
      await snapshots.insert('hourly', snapshot({ ts: 1000, totalUsd: 2 }));
      await snapshots.insert('daily', snapshot({ ts: 1000, totalUsd: 3 }));

      expect((await snapshots.latest('raw', 10))[0].totalUsd).toBe(1);
      expect((await snapshots.latest('hourly', 10))[0].totalUsd).toBe(2);
      expect((await snapshots.all('daily'))[0].totalUsd).toBe(3);
      expect(await snapshots.count('raw')).toBe(1);
    });

    it('rejects a granularity outside the three tiers', async () => {
      await expect(
        // The CHECK constraint is the guard; the type only stops honest callers.
        snapshots.insert('weekly' as snapshots.Granularity, snapshot()),
      ).rejects.toThrow(/asset_snapshots_granularity_check/);
    });
  });

  describe('unique (granularity, ts) conflict', () => {
    it('overwrites rather than duplicating', async () => {
      await snapshots.insert('hourly', snapshot({ ts: 5000, totalUsd: 100 }));
      await snapshots.insert('hourly', snapshot({ ts: 5000, totalUsd: 999 }));

      const rows = await snapshots.latest('hourly', 10);
      expect(rows).toHaveLength(1);
      // "Last write per bucket wins" — the rule loadTrend() applied by deduping
      // on read, made structural here.
      expect(rows[0].totalUsd).toBe(999);
    });

    it('clears fields the overwriting snapshot omits', async () => {
      await snapshots.insert('hourly', snapshot({ ts: 5000, solPrice: 180 }));
      await snapshots.insert('hourly', snapshot({ ts: 5000 }));

      const [read] = await snapshots.latest('hourly', 10);
      expect('solPrice' in read).toBe(false);
    });

    it('leaves the same ts in another tier untouched', async () => {
      await snapshots.insert('raw', snapshot({ ts: 5000, totalUsd: 1 }));
      await snapshots.insert('hourly', snapshot({ ts: 5000, totalUsd: 2 }));
      await snapshots.insert('raw', snapshot({ ts: 5000, totalUsd: 3 }));

      expect((await snapshots.latest('raw', 10))[0].totalUsd).toBe(3);
      expect((await snapshots.latest('hourly', 10))[0].totalUsd).toBe(2);
    });

    it('really is a unique index, not just an upsert convention', async () => {
      await snapshots.insert('daily', snapshot({ ts: 5000 }));
      await expect(
        getPool().query(
          `INSERT INTO asset_snapshots
             (granularity, ts, tokens_usd, lp_value_usd, unclaimed_usd, bonus_usd, locked_sol_usd, total_usd)
           VALUES ('daily', to_timestamp(5), 0, 0, 0, 0, 0, 0)`,
        ),
      ).rejects.toThrow(/asset_snapshots_granularity_ts_key/);
    });
  });

  describe('ordering and latest', () => {
    it('returns the newest `limit` oldest first', async () => {
      for (let i = 0; i < 5; i++) {
        await snapshots.insert('raw', snapshot({ ts: 1000 + i, totalUsd: i }));
      }

      expect((await snapshots.latest('raw', 3)).map((s) => s.totalUsd)).toEqual([2, 3, 4]);
      expect((await snapshots.all('raw')).map((s) => s.totalUsd)).toEqual([0, 1, 2, 3, 4]);
    });

    it('reports the newest timestamp, or 0 when empty', async () => {
      expect(await snapshots.latestTs('raw')).toBe(0);

      await snapshots.insert('raw', snapshot({ ts: 1000 }));
      await snapshots.insert('raw', snapshot({ ts: 3000 }));
      await snapshots.insert('raw', snapshot({ ts: 2000 }));

      expect(await snapshots.latestTs('raw')).toBe(3000);
    });
  });

  describe('retention', () => {
    it('prunes a tier to its cap without touching the others', async () => {
      for (let i = 0; i < 10; i++) {
        await snapshots.insert('raw', snapshot({ ts: 1000 + i }));
        await snapshots.insert('hourly', snapshot({ ts: 1000 + i }));
      }

      expect(await snapshots.prune('raw', 4)).toBe(6);
      expect(await snapshots.count('raw')).toBe(4);
      expect(await snapshots.count('hourly')).toBe(10);
      expect((await snapshots.latest('raw', 10)).map((s) => s.ts)).toEqual([
        1006, 1007, 1008, 1009,
      ]);
    });

    it('prunes by age, the other half of the file version’s retention', async () => {
      for (let i = 0; i < 5; i++) {
        await snapshots.insert('raw', snapshot({ ts: 1000 + i * 1000 }));
      }

      // Inserted 1000..5000; the cutoff is exclusive, so 3000 itself survives.
      expect(await snapshots.pruneOlderThan('raw', 3000)).toBe(2);
      expect((await snapshots.all('raw')).map((s) => s.ts)).toEqual([3000, 4000, 5000]);
    });

    it('leaves an under-cap tier alone', async () => {
      await snapshots.insert('daily', snapshot());
      expect(await snapshots.prune('daily', 100)).toBe(0);
      expect(await snapshots.count('daily')).toBe(1);
    });

    it('exposes the caps the file version enforced', () => {
      expect(snapshots.MAX_RAW).toBe(576);
      expect(snapshots.MAX_HOURLY).toBe(720);
    });
  });

  describe('precision', () => {
    it('keeps cent-level values exact through NUMERIC', async () => {
      // The collector rounds to 2dp before writing, so equality is the right bar.
      const snap = snapshot({ totalUsd: 123456.78, solPrice: 183.4521 });
      await snapshots.insert('raw', snap);

      const [read] = await snapshots.latest('raw', 1);
      expect(read.totalUsd).toBe(123456.78);
      expect(read.solPrice).toBe(183.4521);
    });
  });
});
