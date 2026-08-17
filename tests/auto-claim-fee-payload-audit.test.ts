import assert from 'assert';
import fs from 'fs';
import path from 'path';

import { claimLpFeesCliParityForTest } from '../src/executor/auto-claim';

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'executor', 'auto-claim.ts'), 'utf-8');

function functionBody(name: string, nextName: string): string {
  const start = source.indexOf(name);
  const end = source.indexOf(nextName, start + name.length);
  assert.ok(start >= 0 && end > start, `should locate ${name}`);
  return source.slice(start, end);
}

function token(symbol: string, amount: string | number, decimals = 6) {
  return { tokenSymbol: symbol, tokenAmount: amount, tokenDecimals: decimals };
}

const claimCopyBonusBody = functionBody('export async function claimCopyBonusWithDepsForTest', 'export async function claimCopyBonus');
const claimLpFeesBody = functionBody('export async function claimLpFeesCliParityForTest', 'export async function sendSignedFeePayloadForTest');
const sendSignedBody = functionBody('export async function sendSignedFeePayloadForTest', 'async function signRewardPayload');
const signRewardBody = functionBody('async function signRewardPayload', 'async function sendFeePayload');
const sendFeeBody = functionBody('async function sendFeePayload', 'export async function claimLpFeesOffchain');

assert.ok(!source.includes('export function auditBackendPriorityFeePayload'), 'backend payload audit helper should remain removed after v1.29.2 restore');
assert.ok(!source.includes('export function rewriteBackendPriorityFeePayload'), 'backend payload rewrite helper should remain removed after v1.29.2 restore');
assert.ok(!source.includes('MIN_SDK_PRIORITY_FEE_MICROLAMPORTS'), 'auto-claim should not import priority-fee rewrite config');

assert.ok(
  claimCopyBonusBody.includes('signedTx: await deps.signRewardPayload(item.txPayload)'),
  'copy bonus external signer flow should sign the original backend txPayload',
);
assert.ok(
  !claimCopyBonusBody.includes('rewriteBackendPriorityFeePayload'),
  'copy bonus should not rewrite backend order-v2 payloads before signing',
);
assert.ok(
  claimLpFeesBody.includes('deps.signRewardPayload(item.txPayload)'),
  'LP reward path should sign the original backend order-v2 payload',
);
assert.ok(
  !claimLpFeesBody.includes('rewriteBackendPriorityFeePayload'),
  'LP reward path should not rewrite backend order-v2 payloads',
);
assert.ok(
  signRewardBody.includes("VersionedTransaction.deserialize(Buffer.from(txPayload, 'base64'))"),
  'signRewardPayload should deserialize the original backend payload',
);
assert.ok(
  !sendSignedBody.includes('rewriteBackendPriorityFeePayload'),
  'direct fee sender should not rewrite payloads after v1.29.2 restore',
);
assert.ok(
  sendFeeBody.includes('return sendSignedFeePayloadForTest(connection, entry.txPayload,'),
  'sendFeePayload should pass the original fee entry txPayload to the direct sender',
);

async function assertDependencyInjectedClaimFlowReceivesOriginalPayloads(): Promise<void> {
  const capturedRewardPayloads: string[] = [];
  const capturedFeePayloads: string[] = [];
  let unclaimedCalls = 0;

  const result = await claimLpFeesCliParityForTest({} as any, {
    getWalletAddress: () => 'wallet-1',
    apiGet: async (apiPath: string) => {
      if (apiPath.startsWith('position/unclaimed-data')) {
        unclaimedCalls += 1;
        return unclaimedCalls === 1
          ? { result: { data: { unclaimedOpenIncentives: [{ positionAddress: 'reward-position', syncedTokenAmount: 2, lockedTokenAmount: 0, claimedTokenAmount: 0 }], unclaimedClosedIncentives: [] } } }
          : { result: { data: { unclaimedOpenIncentives: [], unclaimedClosedIncentives: [] } } };
      }
      if (apiPath.startsWith('position/list')) {
        return { result: { data: { positions: [{ positionAddress: 'fee-position' }], total: 1 } } };
      }
      throw new Error(`unexpected apiGet ${apiPath}`);
    },
    apiPost: async (apiPath: string, body: any) => {
      if (apiPath === 'incentive/encode-v2') {
        return { result: { data: { orderCode: 'order-1', rewardEncodeItems: [{ txPayload: 'reward-payload', poolAddress: 'pool-1', txCode: 'reward-code', rewardClaimInfo: [] }] } } };
      }
      if (apiPath === 'incentive/order-v2') {
        return { result: { data: { txList: [{ txSignature: 'reward-sig' }], claimTokenList: [] } } };
      }
      if (apiPath === 'incentive/encode-fee') {
        assert.deepStrictEqual(body.positionAddresses, ['fee-position']);
        return { result: { data: [{ positionAddress: 'fee-position', txPayload: 'fee-payload', tokens: [token('USDC', '5')] }] } };
      }
      throw new Error(`unexpected apiPost ${apiPath}`);
    },
    signRewardPayload: async (txPayload: string) => {
      capturedRewardPayloads.push(txPayload);
      return 'signed-reward';
    },
    sendFeePayload: async (_connection, entry) => {
      capturedFeePayloads.push(entry.txPayload);
      return 'fee-sig';
    },
  });

  assert.deepStrictEqual(result.txSignatures, ['reward-sig', 'fee-sig']);
  assert.deepStrictEqual(capturedRewardPayloads, ['reward-payload']);
  assert.deepStrictEqual(capturedFeePayloads, ['fee-payload']);
}

assertDependencyInjectedClaimFlowReceivesOriginalPayloads().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
