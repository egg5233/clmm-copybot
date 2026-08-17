import { describe, expect, it } from 'vitest';

import {
  isRefererDuplicateEntry,
  normalizeByrealAllowSameTickWallets,
  serializeWalletSet,
  shouldIgnoreRefererBlocker,
} from '../src/utils/byreal-allow-same-tick';

const walletA = 'WalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const walletB = 'WalletBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const walletC = 'WalletCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

describe('shouldIgnoreRefererBlocker', () => {
  it('does not let a flagged source wallet block a different candidate wallet', () => {
    expect(shouldIgnoreRefererBlocker(walletA, walletB, new Set([walletA]), new Set())).toBe(true);
  });

  it('does not let same-tick direction flags bypass same-wallet checks', () => {
    expect(
      shouldIgnoreRefererBlocker(walletA, walletA, new Set([walletA]), new Set([walletA])),
    ).toBe(false);
  });

  it('allows a flagged candidate wallet to open after a different source wallet', () => {
    expect(shouldIgnoreRefererBlocker(walletA, walletB, new Set(), new Set([walletB]))).toBe(true);
  });
});

describe('isRefererDuplicateEntry', () => {
  it('blocks B on an unflagged referer entry from A', () => {
    expect(
      isRefererDuplicateEntry({ targetWallet: walletA }, walletB, false, new Set(), new Set()),
    ).toBe(true);
  });

  it('does not block B when the referer entry from A is flagged', () => {
    expect(
      isRefererDuplicateEntry(
        { targetWallet: walletA },
        walletB,
        false,
        new Set([walletA]),
        new Set(),
      ),
    ).toBe(false);
  });

  it('does not block a flagged candidate wallet B', () => {
    expect(
      isRefererDuplicateEntry(
        { targetWallet: walletA },
        walletB,
        false,
        new Set(),
        new Set([walletB]),
      ),
    ).toBe(false);
  });

  it('still blocks A on direction flags when same-wallet reopen is disabled', () => {
    expect(
      isRefererDuplicateEntry(
        { targetWallet: walletA },
        walletA,
        false,
        new Set([walletA]),
        new Set([walletA]),
      ),
    ).toBe(true);
  });

  it('keeps the existing same-wallet reopen bypass', () => {
    expect(
      isRefererDuplicateEntry({ targetWallet: walletA }, walletA, true, new Set(), new Set()),
    ).toBe(false);
  });

  it('keeps legacy referer entries without targetWallet blocking', () => {
    expect(
      isRefererDuplicateEntry(
        { targetNft: 'legacy-target' },
        walletB,
        false,
        new Set([walletA]),
        new Set([walletB]),
      ),
    ).toBe(true);
  });
});

describe('normalizeByrealAllowSameTickWallets', () => {
  it('dedupes and prunes wallets that are not current Byreal full-copy targets', () => {
    const normalized = normalizeByrealAllowSameTickWallets(
      [walletA, walletB, walletA, ' ', walletC],
      [walletA, walletC],
    );

    expect(Array.from(normalized)).toEqual([walletA, walletC]);
  });

  it('serializes a wallet set as a comma-separated list', () => {
    const normalized = normalizeByrealAllowSameTickWallets(
      [walletA, walletB, walletA, ' ', walletC],
      [walletA, walletC],
    );

    expect(serializeWalletSet(normalized)).toBe(`${walletA},${walletC}`);
  });
});
