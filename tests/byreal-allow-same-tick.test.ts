import assert from 'assert';
import {
  isRefererDuplicateEntry,
  normalizeByrealAllowSameTickWallets,
  serializeWalletSet,
  shouldIgnoreRefererBlocker,
} from '../src/utils/byreal-allow-same-tick';

const walletA = 'WalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const walletB = 'WalletBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const walletC = 'WalletCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

assert.strictEqual(
  shouldIgnoreRefererBlocker(walletA, walletB, new Set([walletA]), new Set()),
  true,
  'flagged source wallet should not block a different candidate wallet',
);
assert.strictEqual(
  shouldIgnoreRefererBlocker(walletA, walletA, new Set([walletA]), new Set([walletA])),
  false,
  'same-tick direction flags should not bypass same-wallet checks',
);
assert.strictEqual(
  shouldIgnoreRefererBlocker(walletA, walletB, new Set(), new Set([walletB])),
  true,
  'flagged candidate wallet should be allowed to open after a different source wallet',
);

assert.strictEqual(
  isRefererDuplicateEntry({ targetWallet: walletA }, walletB, false, new Set(), new Set()),
  true,
  'unflagged referer entry from A should block B',
);
assert.strictEqual(
  isRefererDuplicateEntry({ targetWallet: walletA }, walletB, false, new Set([walletA]), new Set()),
  false,
  'flagged referer entry from A should not block B',
);
assert.strictEqual(
  isRefererDuplicateEntry({ targetWallet: walletA }, walletB, false, new Set(), new Set([walletB])),
  false,
  'flagged candidate wallet B should not be blocked by A',
);
assert.strictEqual(
  isRefererDuplicateEntry({ targetWallet: walletA }, walletA, false, new Set([walletA]), new Set([walletA])),
  true,
  'direction flags should still block A when same-wallet reopen is disabled',
);
assert.strictEqual(
  isRefererDuplicateEntry({ targetWallet: walletA }, walletA, true, new Set(), new Set()),
  false,
  'same-wallet reopen should keep existing bypass behavior',
);
assert.strictEqual(
  isRefererDuplicateEntry({ targetNft: 'legacy-target' }, walletB, false, new Set([walletA]), new Set([walletB])),
  true,
  'legacy referer entries without targetWallet should remain blocking',
);

const normalized = normalizeByrealAllowSameTickWallets(
  [walletA, walletB, walletA, ' ', walletC],
  [walletA, walletC],
);
assert.deepStrictEqual(
  Array.from(normalized),
  [walletA, walletC],
  'normalization should dedupe and prune wallets not in current Byreal full-copy targets',
);
assert.strictEqual(
  serializeWalletSet(normalized),
  `${walletA},${walletC}`,
  'serialization should write comma-separated wallet addresses',
);
