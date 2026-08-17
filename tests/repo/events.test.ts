import { describe, expect, it } from 'vitest';
import type { EventLogEntry } from '../../src/dashboard/context';
import * as events from '../../src/state/repo/events';
import { canRunRepoTests, useTestDatabase } from './setup';

function event(overrides: Partial<EventLogEntry> = {}): EventLogEntry {
  return {
    ts: Date.now(),
    type: 'OPEN',
    targetWallet: 'wallet1',
    success: true,
    ...overrides,
  };
}

describe.skipIf(!canRunRepoTests)('events repository', () => {
  useTestDatabase(['events', 'event_pool_map']);

  describe('append and read back', () => {
    it('round-trips every field', async () => {
      const entry = event({
        ts: 1_700_000_000_000,
        type: 'CLOSE',
        targetNft: 'tgt1',
        ourNft: 'our1',
        txSig: 'sig1',
        success: false,
        error: 'boom',
        pool: 'MNT/USDC',
        dex: 'byreal',
      });
      await events.append(entry);

      expect(await events.recent()).toEqual([entry]);
    });

    it('leaves absent optional fields undefined', async () => {
      await events.append(event({ ts: 1_700_000_000_000 }));

      expect(await events.recent()).toEqual([
        {
          ts: 1_700_000_000_000,
          type: 'OPEN',
          targetWallet: 'wallet1',
          success: true,
          targetNft: undefined,
          ourNft: undefined,
          txSig: undefined,
          error: undefined,
          pool: undefined,
          dex: undefined,
        },
      ]);
    });

    it('returns events oldest first, matching the old on-disk array order', async () => {
      for (let i = 0; i < 5; i++) {
        await events.append(event({ ts: 1_700_000_000_000 + i, txSig: `sig${i}` }));
      }

      const recent = await events.recent();
      expect(recent.map((e) => e.txSig)).toEqual(['sig0', 'sig1', 'sig2', 'sig3', 'sig4']);
    });

    it('honours a limit, keeping the newest', async () => {
      for (let i = 0; i < 5; i++) {
        await events.append(event({ txSig: `sig${i}` }));
      }

      const recent = await events.recent(2);
      expect(recent.map((e) => e.txSig)).toEqual(['sig3', 'sig4']);
    });
  });

  describe('pool map', () => {
    it('records NFT to pool when the event names both', async () => {
      await events.append(event({ targetNft: 'tgt1', pool: 'MNT/USDC' }));

      expect(await events.getPoolFor('tgt1')).toBe('MNT/USDC');
      expect(await events.poolMap()).toEqual({ tgt1: 'MNT/USDC' });
    });

    it('skips events missing either half', async () => {
      await events.append(event({ targetNft: 'tgt1' }));
      await events.append(event({ pool: 'MNT/USDC' }));

      expect(await events.poolMap()).toEqual({});
    });

    it('updates an existing NFT to its newest pool', async () => {
      await events.append(event({ targetNft: 'tgt1', pool: 'MNT/USDC' }));
      await events.append(event({ targetNft: 'tgt1', pool: 'SOL/USDC' }));

      expect(await events.getPoolFor('tgt1')).toBe('SOL/USDC');
    });

    it('outlives the event cap', async () => {
      await events.append(event({ targetNft: 'tgt1', pool: 'MNT/USDC' }), 3);
      for (let i = 0; i < 5; i++) {
        await events.append(event({ txSig: `sig${i}` }), 3);
      }

      expect(await events.count()).toBe(3);
      // The whole point of the separate table: the mapping survives eviction.
      expect(await events.getPoolFor('tgt1')).toBe('MNT/USDC');
    });

    it('records a mapping without logging an event', async () => {
      await events.setPoolFor('tgt1', 'MNT/USDC');

      expect(await events.getPoolFor('tgt1')).toBe('MNT/USDC');
      expect(await events.count()).toBe(0);
    });

    it('returns undefined for an unknown NFT', async () => {
      expect(await events.getPoolFor('nope')).toBeUndefined();
    });
  });

  describe('cap enforcement', () => {
    it('keeps the newest `cap` events and drops the oldest', async () => {
      for (let i = 0; i < 8; i++) {
        await events.append(event({ txSig: `sig${i}` }), 5);
      }

      expect(await events.count()).toBe(5);
      const recent = await events.recent();
      expect(recent.map((e) => e.txSig)).toEqual(['sig3', 'sig4', 'sig5', 'sig6', 'sig7']);
    });

    it('never exceeds the cap even momentarily', async () => {
      for (let i = 0; i < 20; i++) {
        await events.append(event(), 5);
        expect(await events.count()).toBeLessThanOrEqual(5);
      }
    });

    it('prunes on demand', async () => {
      for (let i = 0; i < 10; i++) {
        await events.append(event({ txSig: `sig${i}` }), 1000);
      }

      expect(await events.prune(4)).toBe(6);
      expect(await events.count()).toBe(4);
      expect((await events.recent()).map((e) => e.txSig)).toEqual(['sig6', 'sig7', 'sig8', 'sig9']);
    });

    it('leaves an under-cap table alone', async () => {
      await events.append(event());
      expect(await events.prune(1000)).toBe(0);
      expect(await events.count()).toBe(1);
    });

    it('defaults to the 1000-event cap the JSON file enforced', () => {
      expect(events.MAX_EVENTS).toBe(1000);
    });
  });
});
