export interface ByrealNftAuditResult {
  mappedCount: number;
  onChainCount: number;
  unmappedOnChain: string[];
  mappedMissingOnChain: string[];
  importedToMapping: string[];
  closeQueued: string[];
  enqueueFailed: { nft: string; message: string }[];
}

export function diffByrealNftAudit(
  mappedNfts: string[],
  onChainNfts: string[],
): ByrealNftAuditResult {
  const mapped = new Set(mappedNfts);
  const onChain = new Set(onChainNfts);

  return {
    mappedCount: mapped.size,
    onChainCount: onChain.size,
    unmappedOnChain: [...onChain].filter((nft) => !mapped.has(nft)).sort(),
    mappedMissingOnChain: [...mapped].filter((nft) => !onChain.has(nft)).sort(),
    importedToMapping: [],
    closeQueued: [],
    enqueueFailed: [],
  };
}
