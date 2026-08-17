import assert from 'assert';
import BN from 'bn.js';
import { PublicKey } from '@solana/web3.js';

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

  executor.enqueueReconcile(queue);
  await new Promise(resolve => setTimeout(resolve, 650));

  return { lookups, deleted, removedReferers, enqueued };
}

(async () => {
  {
    const result = await runScenario('null', 'null');
    assert.deepStrictEqual(result.deleted, [TARGET_NFT], 'target gone + our gone should delete mapping');
    assert.deepStrictEqual(result.removedReferers, [TARGET_NFT], 'target gone + our gone should remove referer');
    assert.deepStrictEqual(result.enqueued, [], 'target gone + our gone should not enqueue close');
    assert.deepStrictEqual(result.lookups, [TARGET_NFT, OUR_NFT], 'should check mapped our NFT after target is orphan');
  }

  {
    const result = await runScenario('null', 'active');
    assert.deepStrictEqual(result.deleted, [], 'target gone + our active should keep mapping for close');
    assert.strictEqual(result.enqueued.length, 1, 'target gone + our active should enqueue orphan close');
  }

  {
    const result = await runScenario('null', 'transient-error');
    assert.deepStrictEqual(result.deleted, [], 'own transient lookup error should keep mapping');
    assert.deepStrictEqual(result.removedReferers, [], 'own transient lookup error should keep referer');
    assert.deepStrictEqual(result.enqueued, [], 'own transient lookup error should not enqueue close this cycle');
  }

  {
    const result = await runScenario('null', 'gone-error');
    assert.deepStrictEqual(result.deleted, [TARGET_NFT], 'own not-found lookup error should delete mapping');
    assert.deepStrictEqual(result.removedReferers, [TARGET_NFT], 'own not-found lookup error should remove referer');
    assert.deepStrictEqual(result.enqueued, [], 'own not-found lookup error should not enqueue close');
  }

  {
    const result = await runScenario('unknown-error', 'null');
    assert.deepStrictEqual(result.lookups, [TARGET_NFT], 'target unknown errors should not read our NFT');
    assert.deepStrictEqual(result.deleted, [], 'target unknown errors should keep mapping');
    assert.deepStrictEqual(result.removedReferers, [], 'target unknown errors should keep referer');
    assert.deepStrictEqual(result.enqueued, [], 'target unknown errors should not enqueue close');
  }

  {
    const result = await runScenario('gone-error', 'null');
    assert.deepStrictEqual(result.deleted, [TARGET_NFT], 'target not-found + our gone should delete mapping');
    assert.deepStrictEqual(result.removedReferers, [TARGET_NFT], 'target not-found + our gone should remove referer');
    assert.deepStrictEqual(result.enqueued, [], 'target not-found + our gone should not enqueue close');
  }
})();
