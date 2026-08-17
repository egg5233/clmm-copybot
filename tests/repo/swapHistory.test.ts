import { describe, expect, it } from 'vitest';
import type { SwapHistoryEntry } from '../../src/dashboard/context';
import * as swapHistory from '../../src/state/repo/swapHistory';
import { canRunRepoTests, useTestDatabase } from './setup';

function swap(overrides: Partial<SwapHistoryEntry> = {}): SwapHistoryEntry {
  return {
    ts: 1_700_000_000_000,
    inputMint: 'So11111111111111111111111111111111111111112',
    txSig: 'sig',
    ...overrides,
  };
}

describe.skipIf(!canRunRepoTests)('swapHistory repository', () => {
  useTestDatabase(['swap_history']);

  describe('push and list', () => {
    it('round-trips every field', async () => {
      const entry = swap({
        inputAmountRaw: '1234567890',
        inputDecimals: 9,
        outputAmountRaw: '987654',
      });
      await swapHistory.push(entry);

      expect(await swapHistory.list()).toEqual([entry]);
    });

    it('leaves absent optional fields undefined', async () => {
      await swapHistory.push(swap());

      expect(await swapHistory.list()).toEqual([
        {
          ts: 1_700_000_000_000,
          inputMint: 'So11111111111111111111111111111111111111112',
          txSig: 'sig',
          inputAmountRaw: undefined,
          inputDecimals: undefined,
          outputAmountRaw: undefined,
        },
      ]);
    });

    it('returns swaps oldest first', async () => {
      for (let i = 0; i < 5; i++) {
        await swapHistory.push(swap({ txSig: `sig${i}` }));
      }

      expect((await swapHistory.list()).map((s) => s.txSig)).toEqual([
        'sig0',
        'sig1',
        'sig2',
        'sig3',
        'sig4',
      ]);
    });

    it('keeps u64 amounts exact by storing them as text', async () => {
      await swapHistory.push(swap({ inputAmountRaw: '18446744073709551615' }));

      expect((await swapHistory.list())[0].inputAmountRaw).toBe('18446744073709551615');
    });
  });

  describe('cap enforcement', () => {
    it('keeps 40 of 45 pushes, dropping the oldest five', async () => {
      for (let i = 0; i < 45; i++) {
        await swapHistory.push(swap({ txSig: `sig${i}` }));
      }

      expect(await swapHistory.count()).toBe(40);

      const rows = await swapHistory.list();
      expect(rows).toHaveLength(40);
      expect(rows[0].txSig).toBe('sig5');
      expect(rows[39].txSig).toBe('sig44');
    });

    it('never exceeds the cap even momentarily', async () => {
      for (let i = 0; i < 15; i++) {
        await swapHistory.push(swap(), 5);
        expect(await swapHistory.count()).toBeLessThanOrEqual(5);
      }
    });

    it('defaults to the cap both original writers applied', () => {
      expect(swapHistory.MAX_SWAP_HISTORY).toBe(40);
    });

    it('lets two independent writers interleave without either truncating the other', async () => {
      // src/index.ts and the dashboard force-swap route both append here. On disk
      // each rewrote the file from its own array, so the loser's rows vanished.
      await Promise.all([
        ...Array.from({ length: 10 }, (_, i) => swapHistory.push(swap({ txSig: `bot${i}` }))),
        ...Array.from({ length: 10 }, (_, i) => swapHistory.push(swap({ txSig: `dash${i}` }))),
      ]);

      const sigs = (await swapHistory.list()).map((s) => s.txSig);
      expect(sigs).toHaveLength(20);
      expect(sigs.filter((s) => s.startsWith('bot'))).toHaveLength(10);
      expect(sigs.filter((s) => s.startsWith('dash'))).toHaveLength(10);
    });
  });
});
