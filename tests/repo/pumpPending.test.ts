import { describe, expect, it } from 'vitest';
import { getPool } from '../../src/state/db';
import * as pumpPending from '../../src/state/repo/pumpPending';
import { canRunRepoTests, useTestDatabase } from './setup';

const NOW = 1_700_000_000_000;

function entry(overrides: Partial<Omit<pumpPending.PumpPendingEntry, 'status'>> = {}) {
  return {
    mint: 'mint1',
    symbol: 'PUMP',
    pool: 'mint1/USDC',
    targetWallet: 'wallet1',
    detectedAt: NOW,
    ...overrides,
  };
}

describe.skipIf(!canRunRepoTests)('pumpPending repository', () => {
  useTestDatabase(['pump_pending']);

  describe('add', () => {
    it('records a token as pending', async () => {
      await pumpPending.add(entry({ notifiedAt: NOW + 100 }));

      expect(await pumpPending.get('mint1')).toEqual({
        mint: 'mint1',
        symbol: 'PUMP',
        pool: 'mint1/USDC',
        targetWallet: 'wallet1',
        detectedAt: NOW,
        status: 'pending',
        notifiedAt: NOW + 100,
        resolvedAt: undefined,
      });
    });

    it('re-detecting a resolved token puts it back in the pending queue', async () => {
      await pumpPending.add(entry());
      await pumpPending.reject('mint1');

      await pumpPending.add(entry({ detectedAt: NOW + 5000 }));

      const row = await pumpPending.get('mint1');
      expect(row?.status).toBe('pending');
      expect(row?.resolvedAt).toBeUndefined();
    });

    it('rejects a status outside the three the CHECK allows', async () => {
      await expect(
        getPool().query(
          `INSERT INTO pump_pending (mint, symbol, pool, target_wallet, detected_at, status)
           VALUES ('m', 's', 'p', 'w', now(), 'maybe')`,
        ),
      ).rejects.toThrow(/pump_pending_status_check/);
    });
  });

  describe('approve and reject', () => {
    it('stamps the resolution and returns the entry', async () => {
      await pumpPending.add(entry());

      const resolved = await pumpPending.approve('mint1', NOW + 60_000);

      expect(resolved?.status).toBe('approved');
      expect(resolved?.resolvedAt).toBe(NOW + 60_000);
      expect(await pumpPending.isApproved('mint1')).toBe(true);
      expect(await pumpPending.isRejected('mint1')).toBe(false);
    });

    it('will not flip an already-resolved token', async () => {
      await pumpPending.add(entry());
      await pumpPending.approve('mint1');

      // A late Discord reply must not overwrite the decision already taken.
      expect(await pumpPending.reject('mint1')).toBeUndefined();
      expect(await pumpPending.isApproved('mint1')).toBe(true);
    });

    it('returns undefined for an unknown mint', async () => {
      expect(await pumpPending.approve('nope')).toBeUndefined();
    });
  });

  describe('expiry', () => {
    it('reads a token past its hour as no longer pending', async () => {
      await pumpPending.add(entry());

      expect(await pumpPending.isPending('mint1', NOW + 1000)).toBe(true);
      // The file version applied the window on read too, before the poller ran.
      expect(await pumpPending.isPending('mint1', NOW + pumpPending.EXPIRY_MS + 1)).toBe(false);
      expect((await pumpPending.get('mint1'))?.status).toBe('pending');
    });

    it('rejects everything past the window and returns what it touched', async () => {
      await pumpPending.add(entry({ mint: 'old1' }));
      await pumpPending.add(entry({ mint: 'old2' }));
      await pumpPending.add(entry({ mint: 'fresh', detectedAt: NOW + pumpPending.EXPIRY_MS }));

      const expired = await pumpPending.expire(NOW + pumpPending.EXPIRY_MS + 1);

      expect(expired.map((e) => e.mint).sort()).toEqual(['old1', 'old2']);
      expect(expired.every((e) => e.status === 'rejected')).toBe(true);
      expect(await pumpPending.isRejected('old1')).toBe(true);
      expect((await pumpPending.get('fresh'))?.status).toBe('pending');
    });

    it('leaves already-resolved tokens alone', async () => {
      await pumpPending.add(entry());
      await pumpPending.approve('mint1');

      expect(await pumpPending.expire(NOW + pumpPending.EXPIRY_MS + 1)).toEqual([]);
      expect(await pumpPending.isApproved('mint1')).toBe(true);
    });

    it('reports whether anything is still awaiting approval', async () => {
      expect(await pumpPending.hasPending(NOW)).toBe(false);

      await pumpPending.add(entry());
      expect(await pumpPending.hasPending(NOW)).toBe(true);

      // pollApprovals() takes its early-out once the window has lapsed.
      expect(await pumpPending.hasPending(NOW + pumpPending.EXPIRY_MS + 1)).toBe(false);
    });

    it('uses the one-hour window the file version used', () => {
      expect(pumpPending.EXPIRY_MS).toBe(60 * 60 * 1000);
    });
  });

  describe('list and delete', () => {
    it('lists every token newest first, whatever its status', async () => {
      await pumpPending.add(entry({ mint: 'm1', detectedAt: NOW }));
      await pumpPending.add(entry({ mint: 'm2', detectedAt: NOW + 1000 }));
      await pumpPending.approve('m1');

      expect((await pumpPending.list()).map((e) => e.mint)).toEqual(['m2', 'm1']);
    });

    it('deletes one token', async () => {
      await pumpPending.add(entry());
      await pumpPending.delete('mint1');

      expect(await pumpPending.get('mint1')).toBeUndefined();
      expect(await pumpPending.list()).toEqual([]);
    });
  });
});
