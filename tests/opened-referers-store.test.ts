/**
 * The opened-referers store's write-through, and the one behaviour the Byreal
 * executor depends on beyond storage: closing a position releases the referer it
 * was opened under, so the underlying position becomes copyable again.
 */

import { describe, expect, it } from 'vitest';

import {
  addOpenedReferer,
  allOpenedReferers,
  countOpenedReferers,
  flushOpenedReferers,
  getOpenedReferer,
  initOpenedReferers,
  removeOpenedRefererByTargetNft,
} from '../src/state/opened-referers-store';
import { openedReferers } from '../src/state/repo';
import { canRunRepoTests, useOwnTestDatabase } from './repo/setup';

describe.skipIf(!canRunRepoTests)('opened referers store', () => {
  useOwnTestDatabase('copybot_opened_referers_store', ['opened_referers']);

  it('serves a referer from memory before the write has landed', async () => {
    await initOpenedReferers();

    addOpenedReferer('referer-1', 'target-nft', 'our-nft', 'wallet-1');

    // No await: the open path checks this while deciding whether to copy.
    expect(getOpenedReferer('referer-1')).toMatchObject({
      targetNft: 'target-nft',
      ourNft: 'our-nft',
      targetWallet: 'wallet-1',
    });
    expect(countOpenedReferers()).toBe(1);
    await flushOpenedReferers();
  });

  it('reloads what it persisted, open time included', async () => {
    await initOpenedReferers();
    addOpenedReferer('referer-1', 'target-nft', 'our-nft', 'wallet-1');
    await flushOpenedReferers();
    const openedAt = getOpenedReferer('referer-1')?.openedAt;

    await initOpenedReferers();

    expect(getOpenedReferer('referer-1')?.openedAt).toBe(openedAt);
    expect(Object.keys(allOpenedReferers())).toEqual(['referer-1']);
  });

  it('releases the referer a closed position was opened under', async () => {
    await initOpenedReferers();
    addOpenedReferer('referer-1', 'target-nft-1', 'our-nft-1', 'wallet-1');
    addOpenedReferer('referer-2', 'target-nft-2', 'our-nft-2', 'wallet-2');

    expect(removeOpenedRefererByTargetNft('target-nft-1')).toBe(true);
    await flushOpenedReferers();

    expect(getOpenedReferer('referer-1')).toBeUndefined();
    expect(await openedReferers.get('referer-1')).toBeUndefined();
    // The other target's referer is untouched.
    expect(await openedReferers.get('referer-2')).toBeDefined();
  });

  it('reports no removal when nothing was opened under that target NFT', async () => {
    await initOpenedReferers();

    expect(removeOpenedRefererByTargetNft('never-seen')).toBe(false);
  });
});
