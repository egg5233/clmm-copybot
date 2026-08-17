type RefererEntry = {
  targetWallet?: unknown;
} & Record<string, unknown>;

export function shouldIgnoreRefererBlocker(
  blockerTargetWallet: unknown,
  candidateTargetWallet: string,
  allowOpenedByWallets: Set<string>,
  allowOpenAfterOthersWallets: Set<string>,
): boolean {
  const blocker = typeof blockerTargetWallet === 'string' ? blockerTargetWallet.trim() : '';
  const candidate = candidateTargetWallet.trim();
  return (
    blocker.length > 0 &&
    candidate.length > 0 &&
    blocker !== candidate &&
    (allowOpenedByWallets.has(blocker) || allowOpenAfterOthersWallets.has(candidate))
  );
}

export function isRefererDuplicateEntry(
  entry: RefererEntry | null | undefined,
  candidateTargetWallet: string,
  allowSameWalletReopen: boolean,
  allowOpenedByWallets: Set<string>,
  allowOpenAfterOthersWallets: Set<string>,
): boolean {
  if (!entry) return false;

  const blockerTargetWallet = entry.targetWallet;
  if (allowSameWalletReopen && blockerTargetWallet === candidateTargetWallet) {
    return false;
  }
  if (
    shouldIgnoreRefererBlocker(
      blockerTargetWallet,
      candidateTargetWallet,
      allowOpenedByWallets,
      allowOpenAfterOthersWallets,
    )
  ) {
    return false;
  }
  return true;
}

export function normalizeByrealAllowSameTickWallets(
  inputWallets: unknown,
  byrealTargetWallets: Iterable<string>,
): Set<string> {
  const targetSet = new Set(Array.from(byrealTargetWallets, (w) => w.trim()).filter(Boolean));
  const out = new Set<string>();
  if (!Array.isArray(inputWallets)) return out;

  for (const wallet of inputWallets) {
    const addr = String(wallet).trim();
    if (targetSet.has(addr)) out.add(addr);
  }
  return out;
}

export function parseWalletSet(raw: string): Set<string> {
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

export function serializeWalletSet(wallets: Iterable<string>): string {
  return Array.from(wallets).join(',');
}
