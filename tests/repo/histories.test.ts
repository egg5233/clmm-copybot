import { describe, expect, it } from 'vitest';
import * as histories from '../../src/state/repo/histories';
import { canRunRepoTests, useTestDatabase } from './setup';

function claim(overrides: Partial<histories.ClaimHistoryEntry> = {}): histories.ClaimHistoryEntry {
  return {
    ts: 1_700_000_000_000,
    week: '2026-W33',
    totalPools: 3,
    totalBonusUsd: 12.34,
    txSignatures: ['sig1', 'sig2'],
    ...overrides,
  };
}

function dac(overrides: Partial<histories.DacRecord> = {}): histories.DacRecord {
  return {
    ts: 1_700_000_000_000,
    profitUsd: 25.5,
    dacAmountUsd: 10,
    cbbtcReceived: '0.00009123',
    swapSig: 'swapsig',
    transferSig: 'transfersig',
    transferTo: 'destination',
    status: 'success',
    ...overrides,
  };
}

describe.skipIf(!canRunRepoTests)('histories repository', () => {
  useTestDatabase(['claim_history', 'dac_history']);

  describe('claim history', () => {
    it('round-trips an entry including the signature array', async () => {
      const entry = claim({ snapshotTs: 1_699_999_000_000 });
      await histories.pushClaim(entry);

      expect(await histories.listClaims()).toEqual([entry]);
    });

    it('returns claims oldest first', async () => {
      for (let i = 0; i < 4; i++) {
        await histories.pushClaim(claim({ week: `2026-W0${i}` }));
      }

      expect((await histories.listClaims()).map((c) => c.week)).toEqual([
        '2026-W00',
        '2026-W01',
        '2026-W02',
        '2026-W03',
      ]);
    });

    it('keeps 52 of 55 pushes', async () => {
      for (let i = 0; i < 55; i++) {
        await histories.pushClaim(claim({ week: `week${i}` }));
      }

      expect(await histories.countClaims()).toBe(52);

      const rows = await histories.listClaims();
      expect(rows[0].week).toBe('week3');
      expect(rows.at(-1)?.week).toBe('week54');
      expect(histories.MAX_CLAIM_HISTORY).toBe(52);
    });

    it('finds the newest claim that recorded no error', async () => {
      await histories.pushClaim(claim({ week: 'week1' }));
      await histories.pushClaim(claim({ week: 'week2' }));
      await histories.pushClaim(claim({ week: 'week3', error: 'API 500', totalPools: 0 }));

      // auto-claim.ts scans backwards for this on startup to restore lastClaimWeek.
      expect((await histories.latestSuccessfulClaim())?.week).toBe('week2');
    });

    it('reports no successful claim when every entry failed', async () => {
      await histories.pushClaim(claim({ error: 'boom', totalPools: 0 }));

      expect(await histories.latestSuccessfulClaim()).toBeUndefined();
    });
  });

  describe('DAC history', () => {
    it('round-trips a record, nulls and all', async () => {
      const record = dac({
        status: 'swap_failed',
        swapSig: null,
        transferSig: null,
        reason: 'slippage',
        tokenSymbol: 'cbBTC',
      });
      await histories.pushDac(record);

      expect(await histories.listDac()).toEqual([record]);
    });

    it('returns records oldest first', async () => {
      for (let i = 0; i < 4; i++) {
        await histories.pushDac(dac({ profitUsd: i }));
      }

      expect((await histories.listDac()).map((d) => d.profitUsd)).toEqual([0, 1, 2, 3]);
    });

    it('keeps 365 of 370 pushes', async () => {
      for (let i = 0; i < 370; i++) {
        await histories.pushDac(dac({ profitUsd: i }));
      }

      expect(await histories.countDac()).toBe(365);

      const rows = await histories.listDac();
      expect(rows[0].profitUsd).toBe(5);
      expect(rows.at(-1)?.profitUsd).toBe(369);
      expect(histories.MAX_DAC_HISTORY).toBe(365);
    });

    it('reports the newest run timestamp, or 0 when empty', async () => {
      expect(await histories.latestDacTs()).toBe(0);

      await histories.pushDac(dac({ ts: 1000 }));
      await histories.pushDac(dac({ ts: 5000 }));

      expect(await histories.latestDacTs()).toBe(5000);
    });
  });

  describe('isolation', () => {
    it('keeps the two histories in separate tables', async () => {
      await histories.pushClaim(claim());
      await histories.pushDac(dac());

      expect(await histories.countClaims()).toBe(1);
      expect(await histories.countDac()).toBe(1);
    });
  });
});
