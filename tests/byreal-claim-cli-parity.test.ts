import type { Connection } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import {
  claimCopyBonusWithDepsForTest,
  claimLpFeesCliParityForTest,
  parseByrealJsonResponseForTest,
  sendSignedFeePayloadForTest,
} from '../src/executor/auto-claim';

type FeeEntry = { positionAddress: string; txPayload: string; tokens?: any[] };

const NO_CONNECTION = {} as Connection;

function token(symbol: string, amount: string | number, decimals = 6) {
  return { tokenSymbol: symbol, tokenAmount: amount, tokenDecimals: decimals };
}

function claimableEpoch(overrides: any = {}) {
  return {
    totalBonusUsd: '12.5',
    claimTime: 1000,
    endTime: 2000,
    ...overrides,
  };
}

type CopyBonusPostCall = { apiPath: string; body: any };

/**
 * Fake backend for the weekly copy-bonus claim. The epoch endpoint can return a sequence, one
 * entry per claim round, so tests can drive the loop to its terminating condition. encodeErrors /
 * orderErrors inject a failure on the Nth attempt of that endpoint.
 */
function makeCopyBonusDeps(options: {
  epochData?: any | any[];
  apiGetError?: Error;
  encodeErrors?: Error[];
  orderErrors?: Error[];
  signError?: Error;
  encodeItems?: Array<{ orderCode: string; rewardEncodeItems: any[] }>;
}) {
  const postCalls: CopyBonusPostCall[] = [];
  const signCalls: string[] = [];
  const sleepCalls: number[] = [];
  const epochPaths: string[] = [];
  let epochCalls = 0;
  let encodeAttempts = 0;
  let orderAttempts = 0;
  const defaultEpochSequence = [
    { '3': claimableEpoch() },
    { '3': claimableEpoch({ totalBonusUsd: '0' }) },
  ];

  const deps = {
    getWalletAddress: () => 'wallet-1',
    sleep: async (ms: number) => {
      sleepCalls.push(ms);
    },
    signRewardPayload: async (payload: string) => {
      signCalls.push(payload);
      if (options.signError) throw options.signError;
      return `signed-${payload}`;
    },
    apiGet: async (apiPath: string) => {
      epochPaths.push(apiPath);
      if (options.apiGetError) throw options.apiGetError;
      const epochSource = options.epochData ?? defaultEpochSequence;
      const epochData = Array.isArray(epochSource)
        ? epochSource[Math.min(epochCalls, epochSource.length - 1)]
        : epochSource;
      epochCalls += 1;
      return { result: { data: epochData } };
    },
    apiPost: async (apiPath: string, body: any) => {
      postCalls.push({ apiPath, body });
      if (apiPath === 'incentive/encode-v2') {
        const encodeIndex = encodeAttempts++;
        const err = options.encodeErrors?.[encodeIndex];
        if (err) throw err;
        const encodeItem = options.encodeItems?.[encodeIndex];
        if (encodeItem) return { result: { data: encodeItem } };
        return {
          result: {
            data: {
              orderCode: 'copy-order-1',
              rewardEncodeItems: [
                {
                  poolAddress: 'pool-copy',
                  txCode: 'copy-tx',
                  txPayload: 'copy-payload',
                  rewardClaimInfo: [token('B', '12.5')],
                },
              ],
            },
          },
        };
      }
      if (apiPath === 'incentive/order-v2') {
        const err = options.orderErrors?.[orderAttempts++];
        if (err) throw err;
        return {
          result: {
            data: { txList: [{ txSignature: 'copy-sig-1' }], claimTokenList: [token('B', '12.5')] },
          },
        };
      }
      throw new Error(`unexpected POST ${apiPath}`);
    },
  };

  return { deps, postCalls, signCalls, sleepCalls, epochPaths };
}

function postCallsTo(postCalls: CopyBonusPostCall[], apiPath: string): CopyBonusPostCall[] {
  return postCalls.filter((call) => call.apiPath === apiPath);
}

describe('claimLpFeesCliParityForTest', () => {
  it('claims rewards then fees in a single pass using only the v2 endpoints', async () => {
    const calls: string[] = [];
    const bodies = new Map<string, any>();
    const sentRefs: string[] = [];
    let unclaimedCalls = 0;
    let encodeFeeCalls = 0;

    const result = await claimLpFeesCliParityForTest(NO_CONNECTION, {
      getWalletAddress: () => 'wallet-1',
      signRewardPayload: async (payload: string) => `signed-${payload}`,
      sendFeePayload: async (_connection, entry: FeeEntry) => {
        sentRefs.push(entry.positionAddress);
        return 'fee-sig-1';
      },
      apiGet: async (apiPath: string) => {
        calls.push(apiPath);
        if (apiPath.startsWith('position/unclaimed-data')) {
          unclaimedCalls += 1;
          if (unclaimedCalls > 1) {
            return {
              result: { data: { unclaimedOpenIncentives: [], unclaimedClosedIncentives: [] } },
            };
          }
          return {
            result: {
              data: {
                unclaimedOpenIncentives: [
                  {
                    positionAddress: 'reward-open',
                    syncedTokenAmount: '2',
                    lockedTokenAmount: '0',
                    claimedTokenAmount: '1',
                  },
                  // synced 1 - claimed 1 = 0 unclaimed, so this one must be filtered out.
                  {
                    positionAddress: 'reward-zero',
                    syncedTokenAmount: '1',
                    lockedTokenAmount: '0',
                    claimedTokenAmount: '1',
                  },
                ],
                unclaimedClosedIncentives: [
                  {
                    positionAddress: 'reward-closed',
                    syncedTokenAmount: '5',
                    lockedTokenAmount: '1',
                    claimedTokenAmount: '1',
                  },
                ],
              },
            },
          };
        }
        if (apiPath.startsWith('position/list')) {
          return {
            result: { data: { positions: [{ positionAddress: 'fee-pos-positive' }], total: 1 } },
          };
        }
        throw new Error(`unexpected GET ${apiPath}`);
      },
      apiPost: async (apiPath: string, body: any) => {
        calls.push(apiPath);
        bodies.set(apiPath, body);
        if (apiPath === 'incentive/encode-v2') {
          return {
            result: {
              data: {
                orderCode: 'order-1',
                rewardEncodeItems: [
                  {
                    poolAddress: 'pool-1',
                    txCode: 'tx-1',
                    txPayload: 'payload-1',
                    rewardClaimInfo: [token('RWD', '3')],
                  },
                ],
              },
            },
          };
        }
        if (apiPath === 'incentive/order-v2') {
          return {
            result: {
              data: {
                txList: [{ txSignature: 'reward-sig-1' }],
                claimTokenList: [token('RWD', '3')],
              },
            },
          };
        }
        if (apiPath === 'incentive/encode-fee') {
          encodeFeeCalls += 1;
          return {
            result: {
              data: [
                {
                  positionAddress: 'fee-pos-positive',
                  txPayload: 'fee-payload-1',
                  tokens: [token('USDC', '5')],
                },
              ],
            },
          };
        }
        throw new Error(`unexpected POST ${apiPath}`);
      },
    });

    expect(bodies.get('incentive/encode-v2').positionAddresses).toEqual([
      'reward-open',
      'reward-closed',
    ]);
    expect(bodies.get('incentive/encode-v2').type).toBe(1);
    expect(bodies.get('incentive/order-v2').orderCode).toBe('order-1');
    expect(bodies.get('incentive/order-v2').signedTxPayload).toEqual([
      { poolAddress: 'pool-1', txCode: 'tx-1', signedTx: 'signed-payload-1' },
    ]);
    expect(bodies.get('incentive/encode-fee').positionAddresses).toEqual(['fee-pos-positive']);

    expect(encodeFeeCalls).toBe(1);
    expect(sentRefs).toEqual(['fee-pos-positive']);
    expect(result.txSignatures).toEqual(['reward-sig-1', 'fee-sig-1']);
    expect(result.totalItems).toBe(result.txSignatures.length);
    expect(result.failures).toEqual([]);
    expect(result.claimedTokens.sort((a: any, b: any) => a.symbol.localeCompare(b.symbol))).toEqual(
      [
        { symbol: 'RWD', amount: 3, decimals: 6 },
        { symbol: 'USDC', amount: 5, decimals: 6 },
      ],
    );
  });

  it('never falls back to the v3 or liquidity/send endpoints', async () => {
    const calls: string[] = [];

    await claimLpFeesCliParityForTest(NO_CONNECTION, {
      getWalletAddress: () => 'wallet-1',
      signRewardPayload: async (payload: string) => `signed-${payload}`,
      sendFeePayload: async () => 'fee-sig-1',
      apiGet: async (apiPath: string) => {
        calls.push(apiPath);
        if (apiPath.startsWith('position/unclaimed-data')) {
          return {
            result: { data: { unclaimedOpenIncentives: [], unclaimedClosedIncentives: [] } },
          };
        }
        if (apiPath.startsWith('position/list')) {
          return { result: { data: { positions: [{ positionAddress: 'fee-pos' }], total: 1 } } };
        }
        throw new Error(`unexpected GET ${apiPath}`);
      },
      apiPost: async (apiPath: string) => {
        calls.push(apiPath);
        if (apiPath === 'incentive/encode-fee') {
          return {
            result: {
              data: [{ positionAddress: 'fee-pos', txPayload: 'p1', tokens: [token('USDC', '5')] }],
            },
          };
        }
        throw new Error(`unexpected POST ${apiPath}`);
      },
    });

    expect(calls).not.toContain('incentive/encode-v3');
    expect(calls).not.toContain('incentive/order-v3');
    expect(calls).not.toContain('liquidity/send');
  });

  it('deduplicates repeated signatures and records a failed fee send without losing the good one', async () => {
    const result = await claimLpFeesCliParityForTest(NO_CONNECTION, {
      getWalletAddress: () => 'wallet-1',
      signRewardPayload: async (payload: string) => `signed-${payload}`,
      sendFeePayload: async (_connection, entry: FeeEntry) => {
        if (entry.positionAddress === 'fee-fail') throw new Error('confirm failed');
        return 'dup-sig';
      },
      apiGet: async (apiPath: string) => {
        if (apiPath.startsWith('position/unclaimed-data')) {
          return {
            result: {
              data: {
                unclaimedOpenIncentives: [
                  {
                    positionAddress: 'reward-pos',
                    syncedTokenAmount: '2',
                    lockedTokenAmount: '0',
                    claimedTokenAmount: '1',
                  },
                ],
                unclaimedClosedIncentives: [],
              },
            },
          };
        }
        if (apiPath.startsWith('position/list')) {
          return {
            result: {
              data: {
                positions: [{ positionAddress: 'fee-ok' }, { positionAddress: 'fee-fail' }],
                total: 2,
              },
            },
          };
        }
        throw new Error(`unexpected GET ${apiPath}`);
      },
      apiPost: async (apiPath: string) => {
        if (apiPath === 'incentive/encode-v2') {
          return {
            result: {
              data: {
                orderCode: 'order-1',
                rewardEncodeItems: [
                  {
                    poolAddress: 'pool',
                    txCode: 'tx',
                    txPayload: 'payload',
                    rewardClaimInfo: [token('RWD', '99')],
                  },
                ],
              },
            },
          };
        }
        if (apiPath === 'incentive/order-v2') {
          // Backend returns the same signature twice; it must only be counted once.
          return {
            result: {
              data: {
                txList: [{ txSignature: 'dup-sig' }, { txSignature: 'dup-sig' }],
                claimTokenList: [token('RWD', '10')],
              },
            },
          };
        }
        if (apiPath === 'incentive/encode-fee') {
          return {
            result: {
              data: [
                { positionAddress: 'fee-ok', txPayload: 'fee-ok', tokens: [token('USDC', '5')] },
                {
                  positionAddress: 'fee-fail',
                  txPayload: 'fee-fail',
                  tokens: [token('USDC', '100')],
                },
              ],
            },
          };
        }
        throw new Error(`unexpected POST ${apiPath}`);
      },
    });

    expect(result.txSignatures).toEqual(['dup-sig']);
    expect(result.totalItems).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].phase).toBe('fee-send');
    // The failed position's 100 USDC must not be reported as claimed.
    expect(result.claimedTokens).toEqual([
      { symbol: 'RWD', amount: 10, decimals: 6 },
      { symbol: 'USDC', amount: 5, decimals: 6 },
    ]);
  });

  it('encodes fees once and never resends a position, including ones with no fee tokens', async () => {
    const sent: string[] = [];
    const encodeFeeBodies: any[] = [];

    await claimLpFeesCliParityForTest(NO_CONNECTION, {
      getWalletAddress: () => 'wallet-1',
      signRewardPayload: async (payload: string) => `signed-${payload}`,
      sendFeePayload: async (_connection, entry: FeeEntry) => {
        sent.push(entry.positionAddress);
        return `sig-${entry.positionAddress}`;
      },
      apiGet: async (apiPath: string) => {
        if (apiPath.startsWith('position/unclaimed-data')) {
          return {
            result: { data: { unclaimedOpenIncentives: [], unclaimedClosedIncentives: [] } },
          };
        }
        if (apiPath.startsWith('position/list')) {
          return {
            result: {
              data: {
                positions: [
                  { positionAddress: 'fee-pos-positive' },
                  { positionAddress: 'fee-pos-empty' },
                ],
                total: 2,
              },
            },
          };
        }
        throw new Error(`unexpected GET ${apiPath}`);
      },
      apiPost: async (apiPath: string, body: any) => {
        if (apiPath === 'incentive/encode-fee') {
          encodeFeeBodies.push(body);
          return {
            result: {
              data: [
                {
                  positionAddress: 'fee-pos-positive',
                  txPayload: 'p1',
                  tokens: [token('USDC', '5')],
                },
                { positionAddress: 'fee-pos-empty', txPayload: 'p2', tokens: [] },
              ],
            },
          };
        }
        throw new Error(`unexpected POST ${apiPath}`);
      },
    });

    expect(encodeFeeBodies).toHaveLength(1);
    expect(encodeFeeBodies[0].positionAddresses).toEqual(['fee-pos-positive', 'fee-pos-empty']);
    expect(sent).toEqual(['fee-pos-positive', 'fee-pos-empty']);
    expect(new Set(sent).size).toBe(sent.length);
  });
});

describe('parseByrealJsonResponseForTest', () => {
  it('reports a readable non-JSON error instead of leaking the JSON parser message', async () => {
    const htmlResponse = {
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '<!DOCTYPE html><html>timeout</html>',
    };

    await expect(
      parseByrealJsonResponseForTest('POST', 'incentive/encode-fee', htmlResponse as any),
    ).rejects.toThrow(/POST incentive\/encode-fee returned non-JSON/);

    await expect(
      parseByrealJsonResponseForTest('POST', 'incentive/encode-fee', htmlResponse as any),
    ).rejects.not.toThrow(/Unexpected token/);
  });
});

describe('sendSignedFeePayloadForTest', () => {
  it("sends with preflight settings intact and confirms against the payload's own blockhash", async () => {
    let sendOptions: any;
    let confirmArg: any;
    const commitments: string[] = [];
    const connection = {
      sendRawTransaction: async (_bytes: Buffer, options: any) => {
        sendOptions = options;
        return 'fee-sig-1';
      },
      getLatestBlockhash: async (commitment: string) => {
        commitments.push(commitment);
        return { blockhash: 'latest-blockhash', lastValidBlockHeight: 123 };
      },
      confirmTransaction: async (arg: any, commitment: string) => {
        commitments.push(commitment);
        confirmArg = arg;
        return { value: { err: null } };
      },
    };
    const signPayload = async () => ({
      serialize: () => Buffer.from([1, 2, 3]),
      message: { recentBlockhash: 'payload-blockhash' },
    });

    const sig = await sendSignedFeePayloadForTest(connection as any, 'payload', signPayload, false);

    expect(sig).toBe('fee-sig-1');
    expect(sendOptions).toEqual({ skipPreflight: false, maxRetries: 3 });
    // Confirmation must use the blockhash the payload was signed against, not the freshly
    // fetched one, or the confirmation watches the wrong expiry window.
    expect(confirmArg).toEqual({
      signature: 'fee-sig-1',
      blockhash: 'payload-blockhash',
      lastValidBlockHeight: 123,
    });
    expect(commitments).toEqual(['confirmed', 'confirmed']);
  });
});

describe('claimCopyBonusWithDepsForTest epoch gating', () => {
  it('skips encoding entirely when the epoch payload is empty', async () => {
    const { deps, postCalls } = makeCopyBonusDeps({ epochData: {} });

    const entry = await claimCopyBonusWithDepsForTest(deps, 1000);

    expect(postCalls).toEqual([]);
    expect(entry.error).toBeTruthy();
  });

  const malformedEpochs = [
    { label: 'a non-numeric bonus', epoch: { '3': claimableEpoch({ totalBonusUsd: 'abc' }) } },
    { label: 'a missing claimTime', epoch: { '3': { totalBonusUsd: '12.5', endTime: 2000 } } },
    { label: 'a missing endTime', epoch: { '3': { totalBonusUsd: '12.5', claimTime: 1000 } } },
  ];

  for (const { label, epoch } of malformedEpochs) {
    it(`fails closed on ${label} rather than claiming blind`, async () => {
      const { deps, postCalls } = makeCopyBonusDeps({ epochData: epoch });

      const entry = await claimCopyBonusWithDepsForTest(deps, 1000);

      expect(postCalls).toEqual([]);
      expect(entry.error).toBeTruthy();
    });
  }

  it('skips encoding when now is outside the claim window', async () => {
    const { deps, postCalls } = makeCopyBonusDeps({ epochData: { '3': claimableEpoch() } });

    const entry = await claimCopyBonusWithDepsForTest(deps, 2000);

    expect(postCalls).toEqual([]);
    expect(entry.error).toBeTruthy();
  });

  it('fails closed when the epoch endpoint itself is down', async () => {
    const { deps, postCalls } = makeCopyBonusDeps({ apiGetError: new Error('epoch down') });

    const entry = await claimCopyBonusWithDepsForTest(deps, 1000);

    expect(postCalls).toEqual([]);
    expect(entry.error).toContain('epoch down');
  });

  it('claims at the exact claimTime boundary, sending the type=2 copy-bonus request shape', async () => {
    const { deps, postCalls, signCalls, epochPaths } = makeCopyBonusDeps({});

    const entry = await claimCopyBonusWithDepsForTest(deps, 1000);

    expect(epochPaths[0]).toBe('copyfarmer/epoch-bonus?walletAddress=wallet-1&type=-1');
    expect(postCalls[0]).toEqual({
      apiPath: 'incentive/encode-v2',
      body: { walletAddress: 'wallet-1', positionAddresses: [], type: 2 },
    });
    expect(signCalls).toEqual(['copy-payload']);
    expect(postCalls[1]).toEqual({
      apiPath: 'incentive/order-v2',
      body: {
        orderCode: 'copy-order-1',
        walletAddress: 'wallet-1',
        signedTxPayload: [
          { txCode: 'copy-tx', poolAddress: 'pool-copy', signedTx: 'signed-copy-payload' },
        ],
      },
    });
    expect(entry.txSignatures).toEqual(['copy-sig-1']);
    expect(entry.totalBonusUsd).toBe(12.5);
  });
});

describe('claimCopyBonusWithDepsForTest retries', () => {
  it('retries a 504 from encode and still signs only once', async () => {
    const { deps, postCalls, signCalls, sleepCalls } = makeCopyBonusDeps({
      encodeErrors: [new Error('POST incentive/encode-v2 504 Gateway Time-out')],
    });

    const entry = await claimCopyBonusWithDepsForTest(deps, 1000);

    expect(postCallsTo(postCalls, 'incentive/encode-v2')).toHaveLength(2);
    expect(sleepCalls.slice(0, 1)).toEqual([5000]);
    expect(signCalls).toEqual(['copy-payload']);
    expect(entry.txSignatures).toEqual(['copy-sig-1']);
  });

  it('retries a 504 from order without re-encoding or re-signing, replaying the identical body', async () => {
    const { deps, postCalls, signCalls, sleepCalls } = makeCopyBonusDeps({
      orderErrors: [new Error('POST incentive/order-v2 504 Gateway Time-out')],
    });

    const entry = await claimCopyBonusWithDepsForTest(deps, 1000);

    const orderCalls = postCallsTo(postCalls, 'incentive/order-v2');
    expect(postCallsTo(postCalls, 'incentive/encode-v2')).toHaveLength(1);
    expect(signCalls).toHaveLength(1);
    expect(orderCalls).toHaveLength(2);
    expect(orderCalls[0].body).toEqual(orderCalls[1].body);
    expect(sleepCalls.slice(0, 1)).toEqual([5000]);
    expect(entry.txSignatures).toEqual(['copy-sig-1']);
  });

  it('exhausts order retries with backoff, still never re-encoding or re-signing', async () => {
    const { deps, postCalls, signCalls, sleepCalls } = makeCopyBonusDeps({
      orderErrors: [
        new Error('POST incentive/order-v2 504 Gateway Time-out 1'),
        new Error('POST incentive/order-v2 504 Gateway Time-out 2'),
        new Error('POST incentive/order-v2 504 Gateway Time-out final'),
      ],
    });

    const entry = await claimCopyBonusWithDepsForTest(deps, 1000);

    const orderCalls = postCallsTo(postCalls, 'incentive/order-v2');
    expect(postCallsTo(postCalls, 'incentive/encode-v2')).toHaveLength(1);
    expect(signCalls).toHaveLength(1);
    expect(orderCalls).toHaveLength(3);
    expect(orderCalls[0].body).toEqual(orderCalls[1].body);
    expect(orderCalls[1].body).toEqual(orderCalls[2].body);
    expect(sleepCalls).toEqual([5000, 10000]);
    expect(entry.error).toContain('final');
    expect(entry.txSignatures).toEqual([]);
  });

  it('exhausts encode retries without ever signing or placing an order', async () => {
    const { deps, postCalls, signCalls, sleepCalls } = makeCopyBonusDeps({
      encodeErrors: [
        new Error('POST incentive/encode-v2 504 Gateway Time-out 1'),
        new Error('POST incentive/encode-v2 504 Gateway Time-out 2'),
        new Error('POST incentive/encode-v2 504 Gateway Time-out final'),
      ],
    });

    const entry = await claimCopyBonusWithDepsForTest(deps, 1000);

    expect(postCallsTo(postCalls, 'incentive/encode-v2')).toHaveLength(3);
    expect(postCallsTo(postCalls, 'incentive/order-v2')).toEqual([]);
    expect(signCalls).toEqual([]);
    expect(sleepCalls).toEqual([5000, 10000]);
    expect(entry.error).toContain('final');
  });

  it('does not place an order when every signature failed', async () => {
    const { deps, postCalls } = makeCopyBonusDeps({ signError: new Error('sign failed') });

    const entry = await claimCopyBonusWithDepsForTest(deps, 1000);

    expect(postCallsTo(postCalls, 'incentive/order-v2')).toEqual([]);
    expect(entry.error).toBe('all signatures failed');
  });
});

describe('claimCopyBonusWithDepsForTest claim loop', () => {
  it('keeps claiming round after round until the epoch bonus reaches zero', async () => {
    const { deps, postCalls, signCalls } = makeCopyBonusDeps({
      epochData: [
        { '3': claimableEpoch({ totalBonusUsd: '12.5' }) },
        { '3': claimableEpoch({ totalBonusUsd: '4.25' }) },
        { '3': claimableEpoch({ totalBonusUsd: '0' }) },
      ],
      encodeItems: [
        {
          orderCode: 'copy-order-1',
          rewardEncodeItems: [
            { poolAddress: 'pool-copy-1', txCode: 'copy-tx-1', txPayload: 'copy-payload-1' },
          ],
        },
        {
          orderCode: 'copy-order-2',
          rewardEncodeItems: [
            { poolAddress: 'pool-copy-2', txCode: 'copy-tx-2', txPayload: 'copy-payload-2' },
          ],
        },
      ],
    });

    const entry = await claimCopyBonusWithDepsForTest(deps, 1000);

    expect(postCallsTo(postCalls, 'incentive/encode-v2')).toHaveLength(2);
    expect(postCallsTo(postCalls, 'incentive/order-v2')).toHaveLength(2);
    expect(signCalls).toEqual(['copy-payload-1', 'copy-payload-2']);
    expect(entry.totalPools).toBe(2);
    expect(entry.txSignatures).toEqual(['copy-sig-1', 'copy-sig-1']);
    expect(entry.error).toBeUndefined();
  });

  it('runs past ten rounds instead of stopping at an arbitrary cap', async () => {
    const encodeItems = Array.from({ length: 12 }, (_value, index) => ({
      orderCode: `copy-order-${index}`,
      rewardEncodeItems: [
        {
          poolAddress: `pool-copy-${index}`,
          txCode: `copy-tx-${index}`,
          txPayload: `copy-payload-${index}`,
        },
      ],
    }));
    const { deps, postCalls, signCalls } = makeCopyBonusDeps({
      epochData: [
        ...Array.from({ length: 12 }, () => ({ '3': claimableEpoch() })),
        { '3': claimableEpoch({ totalBonusUsd: '0' }) },
      ],
      encodeItems,
    });

    const entry = await claimCopyBonusWithDepsForTest(deps, 1000);

    expect(postCallsTo(postCalls, 'incentive/encode-v2')).toHaveLength(12);
    expect(postCallsTo(postCalls, 'incentive/order-v2')).toHaveLength(12);
    expect(signCalls).toHaveLength(12);
    expect(entry.totalPools).toBe(12);
    expect(entry.error).toBeUndefined();
  });

  it('stops cleanly when a later round encodes no reward items', async () => {
    const { deps, postCalls } = makeCopyBonusDeps({
      epochData: [{ '3': claimableEpoch() }, { '3': claimableEpoch() }],
      encodeItems: [
        {
          orderCode: 'copy-order-1',
          rewardEncodeItems: [
            { poolAddress: 'pool-copy-1', txCode: 'copy-tx-1', txPayload: 'copy-payload-1' },
          ],
        },
        { orderCode: 'copy-order-2', rewardEncodeItems: [] },
      ],
    });

    const entry = await claimCopyBonusWithDepsForTest(deps, 1000);

    expect(postCallsTo(postCalls, 'incentive/encode-v2')).toHaveLength(2);
    expect(postCallsTo(postCalls, 'incentive/order-v2')).toHaveLength(1);
    expect(entry.txSignatures).toEqual(['copy-sig-1']);
    expect(entry.error).toBeUndefined();
  });

  it('stops before a second order when the backend re-encodes the same batch', async () => {
    const { deps, postCalls, signCalls } = makeCopyBonusDeps({
      epochData: [{ '3': claimableEpoch() }, { '3': claimableEpoch() }],
      encodeItems: [
        {
          orderCode: 'copy-order-1',
          rewardEncodeItems: [
            { poolAddress: 'pool-copy-1', txCode: 'copy-tx-1', txPayload: 'copy-payload-1' },
          ],
        },
        {
          orderCode: 'copy-order-1',
          rewardEncodeItems: [
            {
              poolAddress: 'pool-copy-1',
              txCode: 'copy-tx-1',
              txPayload: 'copy-payload-duplicate',
            },
          ],
        },
      ],
    });

    const entry = await claimCopyBonusWithDepsForTest(deps, 1000);

    expect(postCallsTo(postCalls, 'incentive/encode-v2')).toHaveLength(2);
    expect(postCallsTo(postCalls, 'incentive/order-v2')).toHaveLength(1);
    expect(signCalls).toEqual(['copy-payload-1']);
    expect(entry.txSignatures).toEqual(['copy-sig-1']);
    expect(entry.error).toBeUndefined();
  });

  const terminalEpochs = [
    { label: 'the epoch payload goes empty', epoch: {} },
    {
      label: 'the bonus becomes unparseable',
      epoch: { '3': claimableEpoch({ totalBonusUsd: 'bad' }) },
    },
    {
      label: 'the claim window has not opened yet',
      epoch: { '3': claimableEpoch({ claimTime: 1500 }) },
    },
    { label: 'the claim window has closed', epoch: { '3': claimableEpoch({ endTime: 1000 }) } },
  ];

  for (const { label, epoch } of terminalEpochs) {
    it(`keeps the first round's success and reports no error when ${label}`, async () => {
      const { deps } = makeCopyBonusDeps({
        epochData: [{ '3': claimableEpoch() }, epoch],
        encodeItems: [
          {
            orderCode: 'copy-order-1',
            rewardEncodeItems: [
              { poolAddress: 'pool-copy-1', txCode: 'copy-tx-1', txPayload: 'copy-payload-1' },
            ],
          },
        ],
      });

      const entry = await claimCopyBonusWithDepsForTest(deps, 1000);

      expect(entry.txSignatures).toEqual(['copy-sig-1']);
      expect(entry.error).toBeUndefined();
    });
  }
});
