import { describe, expect, it } from 'vitest';

import { diffByrealNftAudit } from '../src/executor/byreal-nft-audit';

describe('diffByrealNftAudit', () => {
  it('splits NFTs into unmapped-on-chain and mapped-missing-on-chain buckets', () => {
    expect(
      diffByrealNftAudit(
        ['mapped-a', 'mapped-b', 'mapped-c'],
        ['mapped-b', 'mapped-c', 'chain-only'],
      ),
    ).toEqual({
      mappedCount: 3,
      onChainCount: 3,
      unmappedOnChain: ['chain-only'],
      mappedMissingOnChain: ['mapped-a'],
      importedToMapping: [],
      closeQueued: [],
      enqueueFailed: [],
    });
  });

  it('dedupes repeated NFTs on both sides before counting', () => {
    expect(diffByrealNftAudit(['same', 'same'], ['same', 'same'])).toEqual({
      mappedCount: 1,
      onChainCount: 1,
      unmappedOnChain: [],
      mappedMissingOnChain: [],
      importedToMapping: [],
      closeQueued: [],
      enqueueFailed: [],
    });
  });
});
