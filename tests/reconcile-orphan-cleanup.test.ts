import { PublicKey } from '@solana/web3.js';
import BN from 'bn.js';
import { describe, expect, it } from 'vitest';

import { ByrealPositionExecutor } from '../src/executor/byreal-position';

const TARGET_NFT = 'So11111111111111111111111111111111111111112';
const OUR_NFT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

type LookupMode = 'null' | 'active' | 'transient-error' | 'gone-error' | 'unknown-error';

interface ScenarioResult {
  lookups: string[];
  deleted: string[];
  removedReferers: string[];
  enqueued: string[];
}

function activePosition(liquidity = 123) {
  return { rawPositionInfo: { liquidity: new BN(liquidity) } };
}

function errorFor(mode: LookupMode): Error {
  if (mode === 'transient-error') return new Error('429 Too Many Requests');
  if (mode === 'gone-error') return new Error('position not found');
  return new Error('SDK decode failed while parsing position account');
}

async function runScenario(targetMode: LookupMode, ourMode: LookupMode): Promise<ScenarioResult> {
  const lookups: string[] = [];
  const deleted: string[] = [];
  const removedReferers: string[] = [];
  const enqueued: string[] = [];

  const executor = Object.create(ByrealPositionExecutor.prototype) as any;
  executor.positionMap = {
    size: () => 1,
    entries: () => [[TARGET_NFT, OUR_NFT]],
    getDex: () => undefined,
    delete: (targetNft: string) => deleted.push(targetNft),
  };
  executor.chain = {
    getPositionInfoByNftMint: async (nft: PublicKey) => {
      const key = nft.toBase58();
      lookups.push(key);
      const mode = key === TARGET_NFT ? targetMode : ourMode;
      if (mode === 'null') return null;
      if (mode === 'active') return activePosition();
      throw errorFor(mode);
    },
  };
  executor.isOrcaPositionChecker = null;
  executor.isMeteoraPositionChecker = null;
  executor.isPcsPositionChecker = null;
  executor.removeReferer = (targetNft: string) => removedReferers.push(targetNft);

  const queue = {
    enqueue: (label: string) => {
      enqueued.push(label);
      return `q-${enqueued.length}`;
    },
  };

  // enqueueReconcile kicks off an unawaited background scan; the scan paces its
  // own RPC lookups, so give it a fixed window to drain before asserting.
  executor.enqueueReconcile(queue);
  await new Promise((resolve) => setTimeout(resolve, 650));

  return { lookups, deleted, removedReferers, enqueued };
}

describe('Byreal reconcile orphan cleanup', () => {
  it('deletes the mapping when both target and our position are gone', async () => {
    const result = await runScenario('null', 'null');

    expect(result.deleted).toEqual([TARGET_NFT]);
    expect(result.removedReferers).toEqual([TARGET_NFT]);
    expect(result.enqueued).toEqual([]);
    expect(result.lookups).toEqual([TARGET_NFT, OUR_NFT]);
  });

  it('keeps the mapping and enqueues a close when our position is still active', async () => {
    const result = await runScenario('null', 'active');

    expect(result.deleted).toEqual([]);
    expect(result.enqueued).toHaveLength(1);
  });

  it('keeps the mapping when our lookup fails transiently', async () => {
    const result = await runScenario('null', 'transient-error');

    expect(result.deleted).toEqual([]);
    expect(result.removedReferers).toEqual([]);
    expect(result.enqueued).toEqual([]);
  });

  it('deletes the mapping when our lookup reports the position as not found', async () => {
    const result = await runScenario('null', 'gone-error');

    expect(result.deleted).toEqual([TARGET_NFT]);
    expect(result.removedReferers).toEqual([TARGET_NFT]);
    expect(result.enqueued).toEqual([]);
  });

  it('stops before reading our NFT when the target lookup fails for an unknown reason', async () => {
    const result = await runScenario('unknown-error', 'null');

    expect(result.lookups).toEqual([TARGET_NFT]);
    expect(result.deleted).toEqual([]);
    expect(result.removedReferers).toEqual([]);
    expect(result.enqueued).toEqual([]);
  });

  it('deletes the mapping when the target lookup reports not found and our position is gone', async () => {
    const result = await runScenario('gone-error', 'null');

    expect(result.deleted).toEqual([TARGET_NFT]);
    expect(result.removedReferers).toEqual([TARGET_NFT]);
    expect(result.enqueued).toEqual([]);
  });
});
