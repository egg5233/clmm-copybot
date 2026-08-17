import assert from 'assert';

const { diffByrealNftAudit } = require('../src/executor/byreal-nft-audit') as typeof import('../src/executor/byreal-nft-audit');

assert.deepStrictEqual(
  diffByrealNftAudit(['mapped-a', 'mapped-b', 'mapped-c'], ['mapped-b', 'mapped-c', 'chain-only']),
  {
    mappedCount: 3,
    onChainCount: 3,
    unmappedOnChain: ['chain-only'],
    mappedMissingOnChain: ['mapped-a'],
    importedToMapping: [],
    closeQueued: [],
    enqueueFailed: [],
  },
);

assert.deepStrictEqual(
  diffByrealNftAudit(['same', 'same'], ['same', 'same']),
  {
    mappedCount: 1,
    onChainCount: 1,
    unmappedOnChain: [],
    mappedMissingOnChain: [],
    importedToMapping: [],
    closeQueued: [],
    enqueueFailed: [],
  },
);
