import { describe, expect, it } from 'vitest';
import * as positions from '../../src/state/repo/positions';
import { canRunRepoTests, useTestDatabase } from './setup';

describe.skipIf(!canRunRepoTests)('positions repository', () => {
  useTestDatabase(['positions']);

  describe('CRUD', () => {
    it('round-trips a full entry', async () => {
      await positions.set('tgt1', 'our1', 'MNT/USDC', 'wallet1', -100, 200, 'orca');

      expect(await positions.get('tgt1')).toBe('our1');
      expect(await positions.getPool('tgt1')).toBe('MNT/USDC');
      expect(await positions.getDex('tgt1')).toBe('orca');

      const entry = await positions.getEntry('tgt1');
      expect(entry).toMatchObject({
        ourNft: 'our1',
        pool: 'MNT/USDC',
        targetWallet: 'wallet1',
        tickLower: -100,
        tickUpper: 200,
        dex: 'orca',
      });
      expect(entry?.createdAt).toBeGreaterThan(0);
    });

    it('leaves optional fields undefined rather than null', async () => {
      await positions.set('tgt1', 'our1');

      const entry = await positions.getEntry('tgt1');
      expect(entry).toEqual({
        ourNft: 'our1',
        createdAt: expect.any(Number),
        pool: undefined,
        targetWallet: undefined,
        lockedSol: undefined,
        tickLower: undefined,
        tickUpper: undefined,
        dex: undefined,
        targetLiquidity: undefined,
      });
    });

    it('returns undefined for an unknown target NFT', async () => {
      expect(await positions.get('nope')).toBeUndefined();
      expect(await positions.getEntry('nope')).toBeUndefined();
      expect(await positions.getPool('nope')).toBeUndefined();
      expect(await positions.getDex('nope')).toBeUndefined();
    });

    it('deletes by target NFT', async () => {
      await positions.set('tgt1', 'our1');
      await positions.delete('tgt1');

      expect(await positions.get('tgt1')).toBeUndefined();
      expect(await positions.size()).toBe(0);
    });

    it('counts and lists entries', async () => {
      await positions.set('tgt1', 'our1');
      await positions.set('tgt2', 'our2');

      expect(await positions.size()).toBe(2);
      expect(await positions.entries()).toEqual([
        ['tgt1', 'our1'],
        ['tgt2', 'our2'],
      ]);
      expect((await positions.getAllMyNfts()).sort()).toEqual(['our1', 'our2']);
    });

    it('replaces rather than merges on re-set, matching PositionMap.set()', async () => {
      await positions.set('tgt1', 'our1', 'MNT/USDC', 'wallet1');
      await positions.setLockedSol('tgt1', 0.009);
      await positions.setTargetLiquidity('tgt1', '123456789');

      await positions.set('tgt1', 'our2', 'SOL/USDC', 'wallet2');

      const entry = await positions.getEntry('tgt1');
      expect(entry?.ourNft).toBe('our2');
      expect(entry?.pool).toBe('SOL/USDC');
      // The JSON version wrote a fresh object here too, dropping both fields.
      expect(entry?.lockedSol).toBeUndefined();
      expect(entry?.targetLiquidity).toBeUndefined();
    });
  });

  describe('reverse lookup by our NFT', () => {
    it('finds the target NFT', async () => {
      await positions.set('tgt1', 'our1');
      await positions.set('tgt2', 'our2');

      expect(await positions.findByOurNft('our2')).toBe('tgt2');
      expect(await positions.findByOurNft('missing')).toBeUndefined();
    });

    it('reports whether a delete removed anything', async () => {
      await positions.set('tgt1', 'our1');

      expect(await positions.deleteByOurNft('our1')).toBe(true);
      expect(await positions.deleteByOurNft('our1')).toBe(false);
      expect(await positions.size()).toBe(0);
    });
  });

  describe('field updates', () => {
    it('backfills pool, dex, lockedSol and targetLiquidity', async () => {
      await positions.set('tgt1', 'our1');

      await positions.setPool('tgt1', 'MNT/USDC');
      await positions.setDex('tgt1', 'meteora');
      await positions.setLockedSol('tgt1', 0.0089088);
      await positions.setTargetLiquidity('tgt1', '340282366920938463463374607431768211455');

      const entry = await positions.getEntry('tgt1');
      expect(entry?.pool).toBe('MNT/USDC');
      expect(entry?.dex).toBe('meteora');
      expect(entry?.lockedSol).toBeCloseTo(0.0089088, 9);
      // u128 max: NUMERIC keeps it exact where a JS number would not.
      expect(entry?.targetLiquidity).toBe('340282366920938463463374607431768211455');
    });

    it('falls back when lockedSol was never recorded', async () => {
      await positions.set('tgt1', 'our1');
      expect(await positions.getLockedSol('tgt1', 0.0090132)).toBeCloseTo(0.0090132, 9);

      await positions.setLockedSol('tgt1', 0.5);
      expect(await positions.getLockedSol('tgt1', 0.0090132)).toBeCloseTo(0.5, 9);
    });

    it('lists entries needing a backfill', async () => {
      await positions.set('tgt1', 'our1', 'MNT/USDC');
      await positions.set('tgt2', 'our2');
      await positions.setLockedSol('tgt1', 0.009);

      expect(await positions.entriesMissingPool()).toEqual([['tgt2', 'our2']]);
      expect(await positions.entriesMissingLockedSol()).toEqual([['tgt2', 'our2']]);
    });
  });

  describe('duplicate tick range detection', () => {
    it('matches on wallet + pool + both ticks', async () => {
      await positions.set('tgt1', 'our1', 'MNT/USDC', 'wallet1', -100, 200);

      expect(await positions.hasDuplicateTickRange('wallet1', 'MNT/USDC', -100, 200)).toBe(true);
      expect(await positions.hasDuplicateTickRange('wallet2', 'MNT/USDC', -100, 200)).toBe(false);
      expect(await positions.hasDuplicateTickRange('wallet1', 'SOL/USDC', -100, 200)).toBe(false);
      expect(await positions.hasDuplicateTickRange('wallet1', 'MNT/USDC', -100, 201)).toBe(false);
    });
  });

  describe('dex aggregation', () => {
    it('counts untagged rows as byreal', async () => {
      await positions.set('t1', 'o1');
      await positions.set('t2', 'o2', undefined, undefined, undefined, undefined, 'byreal');
      await positions.set('t3', 'o3', undefined, undefined, undefined, undefined, 'orca');
      await positions.set('t4', 'o4', undefined, undefined, undefined, undefined, 'meteora');
      await positions.set('t5', 'o5', undefined, undefined, undefined, undefined, 'pancakeswap');
      await positions.set('t6', 'o6', undefined, undefined, undefined, undefined, 'dammv2');

      expect(await positions.countByDex()).toEqual({
        byreal: 2,
        orca: 1,
        meteora: 1,
        pancakeswap: 1,
        dammv2: 1,
      });
      expect(await positions.getByrealOpenCount()).toBe(2);
      expect((await positions.getByrealNfts()).sort()).toEqual(['o1', 'o2']);
    });

    it('substitutes the per-dex fallback for unrecorded lockedSol', async () => {
      await positions.set('t1', 'o1'); // byreal, no lockedSol -> fallback
      await positions.set('t2', 'o2');
      await positions.setLockedSol('t2', 0.01); // byreal, recorded
      await positions.set('t3', 'o3', undefined, undefined, undefined, undefined, 'orca');

      const totals = await positions.getTotalLockedSolByDex(0.009, 0.0074);
      expect(totals.byreal).toBeCloseTo(0.009 + 0.01, 9);
      expect(totals.orca).toBeCloseTo(0.0074, 9);
      expect(totals.meteora).toBe(0);

      expect(await positions.getTotalLockedSol(0.009)).toBeCloseTo(0.009 * 2 + 0.01, 9);
    });

    it('returns zeroes for an empty table', async () => {
      expect(await positions.countByDex()).toEqual({
        byreal: 0,
        orca: 0,
        meteora: 0,
        pancakeswap: 0,
        dammv2: 0,
      });
      expect(await positions.getTotalLockedSol(0.009)).toBe(0);
    });
  });

  describe('toJSON', () => {
    it('keys entries by target NFT', async () => {
      await positions.set('tgt1', 'our1', 'MNT/USDC');
      await positions.set('tgt2', 'our2');

      const json = await positions.toJSON();
      expect(Object.keys(json).sort()).toEqual(['tgt1', 'tgt2']);
      expect(json.tgt1.pool).toBe('MNT/USDC');
      expect(json.tgt2.ourNft).toBe('our2');
    });
  });
});
