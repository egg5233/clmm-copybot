import { describe, expect, it } from 'vitest';
import * as pendingSwaps from '../../src/state/repo/pendingSwaps';
import { canRunRepoTests, useTestDatabase } from './setup';

const MINT_A = 'So11111111111111111111111111111111111111112';
const MINT_B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe.skipIf(!canRunRepoTests)('pendingSwaps repository', () => {
  useTestDatabase(['pending_swaps']);

  describe('CRUD', () => {
    it('round-trips a payload', async () => {
      await pendingSwaps.set(MINT_A, { pending: '1000', botReceived: '500', createdAt: 42 });

      expect(await pendingSwaps.get(MINT_A)).toEqual({
        pending: '1000',
        botReceived: '500',
        createdAt: 42,
      });
    });

    it('returns undefined for an unknown mint', async () => {
      expect(await pendingSwaps.get('nope')).toBeUndefined();
    });

    it('replaces the payload on re-set', async () => {
      await pendingSwaps.set(MINT_A, { pending: '1000' });
      await pendingSwaps.set(MINT_A, { pending: '2000' });

      expect(await pendingSwaps.get(MINT_A)).toEqual({ pending: '2000' });
    });

    it('deletes one mint and clears them all', async () => {
      await pendingSwaps.set(MINT_A, { pending: '1' });
      await pendingSwaps.set(MINT_B, { pending: '2' });

      await pendingSwaps.delete(MINT_A);
      expect(await pendingSwaps.all()).toEqual({ [MINT_B]: { pending: '2' } });

      await pendingSwaps.clear();
      expect(await pendingSwaps.all()).toEqual({});
    });

    it('lists with update timestamps', async () => {
      await pendingSwaps.set(MINT_A, { pending: '1' });

      const rows = await pendingSwaps.list();
      expect(rows).toHaveLength(1);
      expect(rows[0].inputMint).toBe(MINT_A);
      expect(rows[0].updatedAt).toBeGreaterThan(0);
    });
  });

  describe('concurrent writers', () => {
    /**
     * The defect this table exists to fix: five executor modules used to parse
     * data/pending-swaps.json, mutate their own mint, and write the whole object
     * back. Interleaved writers clobbered each other's mints.
     */
    it('keeps every mint when twenty writers interleave', async () => {
      const mints = Array.from({ length: 20 }, (_, i) => `mint${i}`);

      await Promise.all(
        mints.map((mint, i) =>
          pendingSwaps.set(mint, { pending: String((i + 1) * 1000), botReceived: '0' }),
        ),
      );

      const all = await pendingSwaps.all();
      expect(Object.keys(all)).toHaveLength(20);
      for (const [i, mint] of mints.entries()) {
        expect(all[mint]).toEqual({ pending: String((i + 1) * 1000), botReceived: '0' });
      }
    });

    it('survives mixed writes, updates and deletes across mints', async () => {
      await pendingSwaps.set('keep', { pending: '1' });
      await pendingSwaps.set('drop', { pending: '2' });

      const writers = [
        ...Array.from({ length: 10 }, (_, i) => pendingSwaps.set(`new${i}`, { pending: '9' })),
        pendingSwaps.set('keep', { pending: '111' }),
        pendingSwaps.delete('drop'),
        ...Array.from({ length: 8 }, (_, i) =>
          pendingSwaps.set(`other${i}`, { pending: String(i) }),
        ),
      ];
      await Promise.all(writers);

      const all = await pendingSwaps.all();
      expect(Object.keys(all)).toHaveLength(19);
      expect(all.keep).toEqual({ pending: '111' });
      expect(all.drop).toBeUndefined();
    });

    it('does not lose a credit when twenty writers hit the same mint', async () => {
      // set() alone still needs the caller to read first; accumulate() moves the
      // addition into the statement so concurrent credits all land.
      await Promise.all(
        Array.from({ length: 20 }, () => pendingSwaps.accumulate(MINT_A, 'pending', '100')),
      );

      const payload = await pendingSwaps.get(MINT_A);
      expect(payload?.pending).toBe('2000');
      expect(payload?.botReceived).toBe('0');
    });

    it('accumulates the two amount fields independently', async () => {
      await Promise.all([
        ...Array.from({ length: 5 }, () => pendingSwaps.accumulate(MINT_A, 'pending', '10')),
        ...Array.from({ length: 3 }, () => pendingSwaps.accumulate(MINT_A, 'botReceived', '7')),
      ]);

      const payload = await pendingSwaps.get(MINT_A);
      expect(payload?.pending).toBe('50');
      expect(payload?.botReceived).toBe('21');
    });
  });

  describe('accumulate', () => {
    it('seeds a missing row with zeroed amounts and a createdAt', async () => {
      expect(await pendingSwaps.accumulate(MINT_A, 'pending', '500', 1234)).toBe('500');

      expect(await pendingSwaps.get(MINT_A)).toEqual({
        pending: '500',
        botReceived: '0',
        createdAt: 1234,
      });
    });

    it('subtracts with a negative delta', async () => {
      await pendingSwaps.accumulate(MINT_A, 'pending', '1000');
      expect(await pendingSwaps.accumulate(MINT_A, 'pending', '-250')).toBe('750');
    });

    it('stays exact past the safe-integer range', async () => {
      // u64-scale amounts: a JS number would round these, NUMERIC does not.
      await pendingSwaps.accumulate(MINT_A, 'pending', '18446744073709551615');
      expect(await pendingSwaps.accumulate(MINT_A, 'pending', '1')).toBe('18446744073709551616');
    });

    it('leaves other payload fields alone', async () => {
      await pendingSwaps.set(MINT_A, {
        pending: '10',
        botReceived: '0',
        createdAt: 7,
        tag: 'orca',
      });
      await pendingSwaps.accumulate(MINT_A, 'pending', '5');

      expect(await pendingSwaps.get(MINT_A)).toEqual({
        pending: '15',
        botReceived: '0',
        createdAt: 7,
        tag: 'orca',
      });
    });

    it('touches only the mint it names', async () => {
      await pendingSwaps.set(MINT_B, { pending: '999' });
      await pendingSwaps.accumulate(MINT_A, 'pending', '1');

      expect(await pendingSwaps.get(MINT_B)).toEqual({ pending: '999' });
    });
  });
});
