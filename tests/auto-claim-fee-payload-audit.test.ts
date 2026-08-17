import type { Connection } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import { claimLpFeesCliParityForTest } from '../src/executor/auto-claim';

function token(symbol: string, amount: string | number, decimals = 6) {
  return { tokenSymbol: symbol, tokenAmount: amount, tokenDecimals: decimals };
}

describe('claimLpFeesCliParityForTest payload handling', () => {
  // v1.29.2 restore: an earlier build rewrote the priority fee inside the backend-supplied
  // order-v2 payloads before signing, which invalidated them. Both the reward and fee paths must
  // hand the untouched backend txPayload to the signer/sender.
  it('signs and sends the original backend payloads rather than rewritten ones', async () => {
    const signedRewardPayloads: string[] = [];
    const sentFeePayloads: string[] = [];
    let unclaimedCalls = 0;

    const result = await claimLpFeesCliParityForTest({} as Connection, {
      getWalletAddress: () => 'wallet-1',
      apiGet: async (apiPath: string) => {
        if (apiPath.startsWith('position/unclaimed-data')) {
          unclaimedCalls += 1;
          // Second round returns nothing so the claim loop terminates.
          return unclaimedCalls === 1
            ? {
              result: {
                data: {
                  unclaimedOpenIncentives: [
                    {
                      positionAddress: 'reward-position',
                      syncedTokenAmount: 2,
                      lockedTokenAmount: 0,
                      claimedTokenAmount: 0,
                    },
                  ],
                  unclaimedClosedIncentives: [],
                },
              },
            }
            : { result: { data: { unclaimedOpenIncentives: [], unclaimedClosedIncentives: [] } } };
        }
        if (apiPath.startsWith('position/list')) {
          return { result: { data: { positions: [{ positionAddress: 'fee-position' }], total: 1 } } };
        }
        throw new Error(`unexpected apiGet ${apiPath}`);
      },
      apiPost: async (apiPath: string) => {
        if (apiPath === 'incentive/encode-v2') {
          return {
            result: {
              data: {
                orderCode: 'order-1',
                rewardEncodeItems: [
                  {
                    txPayload: 'reward-payload',
                    poolAddress: 'pool-1',
                    txCode: 'reward-code',
                    rewardClaimInfo: [],
                  },
                ],
              },
            },
          };
        }
        if (apiPath === 'incentive/order-v2') {
          return { result: { data: { txList: [{ txSignature: 'reward-sig' }], claimTokenList: [] } } };
        }
        if (apiPath === 'incentive/encode-fee') {
          return {
            result: {
              data: [
                { positionAddress: 'fee-position', txPayload: 'fee-payload', tokens: [token('USDC', '5')] },
              ],
            },
          };
        }
        throw new Error(`unexpected apiPost ${apiPath}`);
      },
      signRewardPayload: async (txPayload: string) => {
        signedRewardPayloads.push(txPayload);
        return 'signed-reward';
      },
      sendFeePayload: async (_connection, entry) => {
        sentFeePayloads.push(entry.txPayload);
        return 'fee-sig';
      },
    });

    expect(signedRewardPayloads).toEqual(['reward-payload']);
    expect(sentFeePayloads).toEqual(['fee-payload']);
    expect(result.txSignatures).toEqual(['reward-sig', 'fee-sig']);
  });

  it('requests fee encoding only for the positions returned by the position list', async () => {
    const encodeFeeBodies: any[] = [];

    await claimLpFeesCliParityForTest({} as Connection, {
      getWalletAddress: () => 'wallet-1',
      apiGet: async (apiPath: string) => {
        if (apiPath.startsWith('position/unclaimed-data')) {
          return { result: { data: { unclaimedOpenIncentives: [], unclaimedClosedIncentives: [] } } };
        }
        if (apiPath.startsWith('position/list')) {
          return { result: { data: { positions: [{ positionAddress: 'fee-position' }], total: 1 } } };
        }
        throw new Error(`unexpected apiGet ${apiPath}`);
      },
      apiPost: async (apiPath: string, body: any) => {
        if (apiPath === 'incentive/encode-fee') {
          encodeFeeBodies.push(body);
          return {
            result: {
              data: [
                { positionAddress: 'fee-position', txPayload: 'fee-payload', tokens: [token('USDC', '5')] },
              ],
            },
          };
        }
        throw new Error(`unexpected apiPost ${apiPath}`);
      },
      signRewardPayload: async () => 'signed-reward',
      sendFeePayload: async () => 'fee-sig',
    });

    expect(encodeFeeBodies).toHaveLength(1);
    expect(encodeFeeBodies[0].positionAddresses).toEqual(['fee-position']);
  });
});
