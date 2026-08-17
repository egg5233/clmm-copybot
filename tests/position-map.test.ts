/**
 * The store's own behaviour plus its write-through: the same API assertions the
 * file-backed version made, now against Postgres. What used to be "the JSON file
 * ends up empty" is "the row is gone and a fresh instance agrees".
 */

import { describe, expect, it } from 'vitest';

import { PositionMap } from '../src/state/position-map';
import { positions } from '../src/state/repo';
import { canRunRepoTests, useOwnTestDatabase } from './repo/setup';

describe.skipIf(!canRunRepoTests)('PositionMap', () => {
  useOwnTestDatabase('copybot_position_map_store', ['positions']);

  /** A store that has loaded from the database and is persisting its mutations. */
  async function newMap(): Promise<PositionMap> {
    const map = new PositionMap();
    await map.init();
    return map;
  }

  it('maps target NFT to our NFT and deletes by our NFT', async () => {
    const map = await newMap();
    const targetNft = 'target-position-nft';
    const ourNft = 'our-position-nft';

    map.set(targetNft, ourNft, 'MINTA/MINTB', 'target-wallet');

    expect(map.get(targetNft)).toBe(ourNft);
    expect(map.findByOurNft(ourNft)).toBe(targetNft);
    expect(map.deleteByOurNft(ourNft)).toBe(true);
    expect(map.findByOurNft(ourNft)).toBeUndefined();
    expect(map.toJSON()).toEqual({});
    expect(map.deleteByOurNft('missing-nft')).toBe(false);
  });

  it('persists a mapping and its later edits to Postgres', async () => {
    const map = await newMap();

    map.set('target', 'ours', 'MINTA/MINTB', 'target-wallet', -100, 100, 'orca');
    map.setLockedSol('target', 0.0079);
    map.setTargetLiquidity('target', '123456789');
    await map.flush();

    expect(await positions.getEntry('target')).toMatchObject({
      ourNft: 'ours',
      pool: 'MINTA/MINTB',
      targetWallet: 'target-wallet',
      tickLower: -100,
      tickUpper: 100,
      dex: 'orca',
      lockedSol: 0.0079,
      targetLiquidity: '123456789',
    });
  });

  it('reloads what it persisted, and a delete removes the row', async () => {
    const first = await newMap();
    first.set('target', 'ours', 'MINTA/MINTB', 'target-wallet', undefined, undefined, 'meteora');
    first.setLockedSol('target', 0.0079);
    await first.flush();

    const reloaded = await newMap();
    expect(reloaded.size()).toBe(1);
    expect(reloaded.get('target')).toBe('ours');
    expect(reloaded.getPool('target')).toBe('MINTA/MINTB');
    expect(reloaded.getDex('target')).toBe('meteora');
    expect(reloaded.getLockedSol('target', 0)).toBe(0.0079);

    reloaded.delete('target');
    await reloaded.flush();

    expect(await positions.getEntry('target')).toBeUndefined();
    expect((await newMap()).size()).toBe(0);
  });

  it('serves reads from memory before the write has landed', async () => {
    const map = await newMap();

    map.set('target', 'ours', 'MINTA/MINTB', 'target-wallet');

    // No await: the point of the write-through is that the trading path never
    // waits for Postgres, so the mapping has to be readable immediately.
    expect(map.get('target')).toBe('ours');
    expect(map.entries()).toEqual([['target', 'ours']]);
    await map.flush();
  });

  it('keeps a repository failure out of the caller', async () => {
    const map = await newMap();
    map.set('target', 'ours');
    await map.flush();

    // target_liquidity is NUMERIC, so this UPDATE cannot land. The failure is
    // logged by the write chain: the caller sees nothing, and the position stays
    // usable in memory rather than the close path throwing.
    expect(() => map.setTargetLiquidity('target', 'not-a-number')).not.toThrow();
    await map.flush();

    expect(map.getTargetLiquidity('target')).toBe('not-a-number');
    expect((await positions.getEntry('target'))?.targetLiquidity).toBeUndefined();
    expect(map.get('target')).toBe('ours');
  });
});
