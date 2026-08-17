import { describe, expect, it } from 'vitest';
import * as openedReferers from '../../src/state/repo/openedReferers';
import { canRunRepoTests, useTestDatabase } from './setup';

describe.skipIf(!canRunRepoTests)('openedReferers repository', () => {
  useTestDatabase(['opened_referers']);

  it('round-trips an entry', async () => {
    await openedReferers.add('ref1', 'tgt1', 'our1', 'wallet1', 1_700_000_000_000);

    expect(await openedReferers.get('ref1')).toEqual({
      targetNft: 'tgt1',
      ourNft: 'our1',
      targetWallet: 'wallet1',
      openedAt: 1_700_000_000_000,
    });
    expect(await openedReferers.has('ref1')).toBe(true);
  });

  it('reports an unknown referer as absent', async () => {
    expect(await openedReferers.has('nope')).toBe(false);
    expect(await openedReferers.get('nope')).toBeUndefined();
  });

  it('accepts an empty ourNft, which is what the executor records pre-confirmation', async () => {
    await openedReferers.add('ref1', 'tgt1', '', 'wallet1');

    expect((await openedReferers.get('ref1'))?.ourNft).toBe('');
  });

  it('overwrites on re-add', async () => {
    await openedReferers.add('ref1', 'tgt1', 'our1', 'wallet1');
    await openedReferers.add('ref1', 'tgt2', 'our2', 'wallet2');

    expect(await openedReferers.get('ref1')).toMatchObject({
      targetNft: 'tgt2',
      ourNft: 'our2',
      targetWallet: 'wallet2',
    });
    expect(await openedReferers.count()).toBe(1);
  });

  it('deletes by referer position', async () => {
    await openedReferers.add('ref1', 'tgt1', 'our1', 'wallet1');
    await openedReferers.delete('ref1');

    expect(await openedReferers.has('ref1')).toBe(false);
  });

  describe('deleteByTargetNft', () => {
    it('removes the entry pointing at a closed position', async () => {
      await openedReferers.add('ref1', 'tgt1', 'our1', 'wallet1');
      await openedReferers.add('ref2', 'tgt2', 'our2', 'wallet2');

      expect(await openedReferers.deleteByTargetNft('tgt1')).toBe(true);

      expect(await openedReferers.has('ref1')).toBe(false);
      expect(await openedReferers.has('ref2')).toBe(true);
    });

    it('reports false when nothing matched', async () => {
      expect(await openedReferers.deleteByTargetNft('nope')).toBe(false);
    });
  });

  it('keys every entry by referer position', async () => {
    await openedReferers.add('ref1', 'tgt1', 'our1', 'wallet1');
    await openedReferers.add('ref2', 'tgt2', 'our2', 'wallet2');

    const all = await openedReferers.all();
    expect(Object.keys(all).sort()).toEqual(['ref1', 'ref2']);
    expect(all.ref2.targetWallet).toBe('wallet2');
  });
});
