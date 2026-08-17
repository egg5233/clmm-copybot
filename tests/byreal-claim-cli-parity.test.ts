import assert from 'assert';
import fs from 'fs';
import path from 'path';

import {
  claimCopyBonusWithDepsForTest,
  claimLpFeesCliParityForTest,
  parseByrealJsonResponseForTest,
  sendSignedFeePayloadForTest,
} from '../src/executor/auto-claim';

type ApiPath = string;
type ApiBody = any;
type FeeEntry = { positionAddress: string; txPayload: string; tokens?: any[] };

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
      assert.strictEqual(apiPath, 'copyfarmer/epoch-bonus?walletAddress=wallet-1&type=-1');
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
        if (encodeItem) {
          return { result: { data: encodeItem } };
        }
        return {
          result: {
            data: {
              orderCode: 'copy-order-1',
              rewardEncodeItems: [
                { poolAddress: 'pool-copy', txCode: 'copy-tx', txPayload: 'copy-payload', rewardClaimInfo: [token('B', '12.5')] },
              ],
            },
          },
        };
      }
      if (apiPath === 'incentive/order-v2') {
        const err = options.orderErrors?.[orderAttempts++];
        if (err) throw err;
        return { result: { data: { txList: [{ txSignature: 'copy-sig-1' }], claimTokenList: [token('B', '12.5')] } } };
      }
      throw new Error(`unexpected POST ${apiPath}`);
    },
  };

  return { deps, postCalls, signCalls, sleepCalls };
}

async function testCliParityFlow(): Promise<void> {
  const calls: string[] = [];
  let unclaimedCalls = 0;
  let encodeFeeCalls = 0;
  const sentRefs: string[] = [];

  const result = await claimLpFeesCliParityForTest({} as any, {
    getWalletAddress: () => 'wallet-1',
    signRewardPayload: async (payload: string) => `signed-${payload}`,
    sendFeePayload: async (_connection: any, entry: FeeEntry) => {
      sentRefs.push(entry.positionAddress);
      return 'fee-sig-1';
    },
    apiGet: async (apiPath: ApiPath) => {
      calls.push(apiPath);
      if (apiPath.startsWith('position/unclaimed-data')) {
        unclaimedCalls += 1;
        if (unclaimedCalls > 1) {
          return { result: { data: { unclaimedOpenIncentives: [], unclaimedClosedIncentives: [] } } };
        }
        return {
          result: {
            data: {
              unclaimedOpenIncentives: [
                { positionAddress: 'reward-open', syncedTokenAmount: '2', lockedTokenAmount: '0', claimedTokenAmount: '1' },
                { positionAddress: 'reward-zero', syncedTokenAmount: '1', lockedTokenAmount: '0', claimedTokenAmount: '1' },
              ],
              unclaimedClosedIncentives: [
                { positionAddress: 'reward-closed', syncedTokenAmount: '5', lockedTokenAmount: '1', claimedTokenAmount: '1' },
              ],
            },
          },
        };
      }
      if (apiPath.startsWith('position/list')) {
        return { result: { data: { positions: [{ positionAddress: 'fee-pos-positive' }], total: 1 } } };
      }
      throw new Error(`unexpected GET ${apiPath}`);
    },
    apiPost: async (apiPath: ApiPath, body: ApiBody) => {
      calls.push(apiPath);
      if (apiPath === 'incentive/encode-v2') {
        assert.deepStrictEqual(body.positionAddresses, ['reward-open', 'reward-closed']);
        assert.strictEqual(body.type, 1);
        return {
          result: {
            data: {
              orderCode: 'order-1',
              rewardEncodeItems: [
                { poolAddress: 'pool-1', txCode: 'tx-1', txPayload: 'payload-1', rewardClaimInfo: [token('RWD', '3')] },
              ],
            },
          },
        };
      }
      if (apiPath === 'incentive/order-v2') {
        assert.strictEqual(body.orderCode, 'order-1');
        assert.deepStrictEqual(body.signedTxPayload, [{ poolAddress: 'pool-1', txCode: 'tx-1', signedTx: 'signed-payload-1' }]);
        return { result: { data: { txList: [{ txSignature: 'reward-sig-1' }], claimTokenList: [token('RWD', '3')] } } };
      }
      if (apiPath === 'incentive/encode-fee') {
        encodeFeeCalls += 1;
        assert.deepStrictEqual(body.positionAddresses, ['fee-pos-positive']);
        return {
          result: {
            data: [
              { positionAddress: 'fee-pos-positive', txPayload: 'fee-payload-1', tokens: [token('USDC', '5')] },
            ],
          },
        };
      }
      throw new Error(`unexpected POST ${apiPath}`);
    },
  });

  assert.strictEqual(encodeFeeCalls, 1, 'encode-fee should be called once');
  assert.deepStrictEqual(sentRefs, ['fee-pos-positive']);
  assert.ok(!calls.includes('incentive/encode-v3'));
  assert.ok(!calls.includes('incentive/order-v3'));
  assert.ok(!calls.includes('liquidity/send'));
  assert.deepStrictEqual(result.txSignatures, ['reward-sig-1', 'fee-sig-1']);
  assert.strictEqual(result.totalItems, result.txSignatures.length);
  assert.deepStrictEqual(result.failures, []);
  assert.deepStrictEqual(result.claimedTokens.sort((a: any, b: any) => a.symbol.localeCompare(b.symbol)), [
    { symbol: 'RWD', amount: 3, decimals: 6 },
    { symbol: 'USDC', amount: 5, decimals: 6 },
  ]);
}

async function testNonJsonError(): Promise<void> {
  const fakeResponse = {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => '<!DOCTYPE html><html>timeout</html>',
  };

  await assert.rejects(
    () => parseByrealJsonResponseForTest('POST', 'incentive/encode-fee', fakeResponse as any),
    (err: any) => {
      assert.ok(err.message.includes('POST incentive/encode-fee returned non-JSON'));
      assert.ok(!err.message.includes('Unexpected token'));
      return true;
    },
  );
}

async function testDirectSender(): Promise<void> {
  let sendOptions: any;
  let confirmArg: any;
  const connection = {
    sendRawTransaction: async (_bytes: Buffer, options: any) => {
      sendOptions = options;
      return 'fee-sig-1';
    },
    getLatestBlockhash: async (commitment: string) => {
      assert.strictEqual(commitment, 'confirmed');
      return { blockhash: 'latest-blockhash', lastValidBlockHeight: 123 };
    },
    confirmTransaction: async (arg: any, commitment: string) => {
      confirmArg = arg;
      assert.strictEqual(commitment, 'confirmed');
      return { value: { err: null } };
    },
  };
  const signPayload = async () => ({
    serialize: () => Buffer.from([1, 2, 3]),
    message: { recentBlockhash: 'payload-blockhash' },
  });

  const sig = await sendSignedFeePayloadForTest(connection as any, 'payload', signPayload as any, false);

  assert.strictEqual(sig, 'fee-sig-1');
  assert.deepStrictEqual(sendOptions, { skipPreflight: false, maxRetries: 3 });
  assert.deepStrictEqual(confirmArg, { signature: 'fee-sig-1', blockhash: 'payload-blockhash', lastValidBlockHeight: 123 });
}

async function testDuplicateAndFailedOutputs(): Promise<void> {
  const result = await claimLpFeesCliParityForTest({} as any, {
    getWalletAddress: () => 'wallet-1',
    signRewardPayload: async (payload: string) => `signed-${payload}`,
    sendFeePayload: async (_connection: any, entry: FeeEntry) => {
      if (entry.positionAddress === 'fee-fail') throw new Error('confirm failed');
      return 'dup-sig';
    },
    apiGet: async (apiPath: ApiPath) => {
      if (apiPath.startsWith('position/unclaimed-data')) {
        return {
          result: {
            data: {
              unclaimedOpenIncentives: [{ positionAddress: 'reward-pos', syncedTokenAmount: '2', lockedTokenAmount: '0', claimedTokenAmount: '1' }],
              unclaimedClosedIncentives: [],
            },
          },
        };
      }
      if (apiPath.startsWith('position/list')) {
        return { result: { data: { positions: [{ positionAddress: 'fee-ok' }, { positionAddress: 'fee-fail' }], total: 2 } } };
      }
      throw new Error(`unexpected GET ${apiPath}`);
    },
    apiPost: async (apiPath: ApiPath, body: ApiBody) => {
      if (apiPath === 'incentive/encode-v2') {
        return { result: { data: { orderCode: 'order-1', rewardEncodeItems: [{ poolAddress: 'pool', txCode: 'tx', txPayload: 'payload', rewardClaimInfo: [token('RWD', '99')] }] } } };
      }
      if (apiPath === 'incentive/order-v2') {
        return { result: { data: { txList: [{ txSignature: 'dup-sig' }, { txSignature: 'dup-sig' }], claimTokenList: [token('RWD', '10')] } } };
      }
      if (apiPath === 'incentive/encode-fee') {
        assert.deepStrictEqual(body.positionAddresses, ['fee-ok', 'fee-fail']);
        return {
          result: {
            data: [
              { positionAddress: 'fee-ok', txPayload: 'fee-ok', tokens: [token('USDC', '5')] },
              { positionAddress: 'fee-fail', txPayload: 'fee-fail', tokens: [token('USDC', '100')] },
            ],
          },
        };
      }
      throw new Error(`unexpected POST ${apiPath}`);
    },
  });

  assert.deepStrictEqual(result.txSignatures, ['dup-sig']);
  assert.strictEqual(result.totalItems, 1);
  assert.strictEqual(result.failures.length, 1);
  assert.strictEqual(result.failures[0].phase, 'fee-send');
  assert.deepStrictEqual(result.claimedTokens, [{ symbol: 'RWD', amount: 10, decimals: 6 }, { symbol: 'USDC', amount: 5, decimals: 6 }]);
}

async function testNoFeeResend(): Promise<void> {
  let encodeFeeCalls = 0;
  const sent = new Set<string>();
  await claimLpFeesCliParityForTest({} as any, {
    getWalletAddress: () => 'wallet-1',
    signRewardPayload: async (payload: string) => `signed-${payload}`,
    sendFeePayload: async (_connection: any, entry: FeeEntry) => {
      assert.ok(!sent.has(entry.positionAddress), `duplicate fee send ${entry.positionAddress}`);
      sent.add(entry.positionAddress);
      return `sig-${entry.positionAddress}`;
    },
    apiGet: async (apiPath: ApiPath) => {
      if (apiPath.startsWith('position/unclaimed-data')) return { result: { data: { unclaimedOpenIncentives: [], unclaimedClosedIncentives: [] } } };
      if (apiPath.startsWith('position/list')) {
        return { result: { data: { positions: [{ positionAddress: 'fee-pos-positive' }, { positionAddress: 'fee-pos-empty' }], total: 2 } } };
      }
      throw new Error(`unexpected GET ${apiPath}`);
    },
    apiPost: async (apiPath: ApiPath, body: ApiBody) => {
      if (apiPath === 'incentive/encode-fee') {
        encodeFeeCalls += 1;
        if (encodeFeeCalls > 1) throw new Error('encode-fee called more than once');
        assert.deepStrictEqual(body.positionAddresses, ['fee-pos-positive', 'fee-pos-empty']);
        return {
          result: {
            data: [
              { positionAddress: 'fee-pos-positive', txPayload: 'p1', tokens: [token('USDC', '5')] },
              { positionAddress: 'fee-pos-empty', txPayload: 'p2', tokens: [] },
            ],
          },
        };
      }
      throw new Error(`unexpected POST ${apiPath}`);
    },
  });

  assert.strictEqual(encodeFeeCalls, 1);
  assert.deepStrictEqual([...sent], ['fee-pos-positive', 'fee-pos-empty']);
}

async function testCopyBonusSkipsEncodeWhenEpochMissing(): Promise<void> {
  const { deps, postCalls } = makeCopyBonusDeps({ epochData: {} });
  const entry = await claimCopyBonusWithDepsForTest(deps, 1000);
  assert.deepStrictEqual(postCalls, []);
  assert.ok(entry.error);
}

async function testCopyBonusMalformedEpochFailsClosed(): Promise<void> {
  for (const badEpoch of [
    { '3': claimableEpoch({ totalBonusUsd: 'abc' }) },
    { '3': { totalBonusUsd: '12.5', endTime: 2000 } },
    { '3': { totalBonusUsd: '12.5', claimTime: 1000 } },
  ]) {
    const { deps, postCalls } = makeCopyBonusDeps({ epochData: badEpoch });
    const entry = await claimCopyBonusWithDepsForTest(deps, 1000);
    assert.deepStrictEqual(postCalls, []);
    assert.ok(entry.error);
  }
}

async function testCopyBonusSkipsEncodeOutsideWindow(): Promise<void> {
  const { deps, postCalls } = makeCopyBonusDeps({ epochData: { '3': claimableEpoch() } });
  const entry = await claimCopyBonusWithDepsForTest(deps, 2000);
  assert.deepStrictEqual(postCalls, []);
  assert.ok(entry.error);
}

async function testCopyBonusAllowsAtClaimTime(): Promise<void> {
  const { deps, postCalls, signCalls } = makeCopyBonusDeps({});
  const entry = await claimCopyBonusWithDepsForTest(deps, 1000);
  assert.deepStrictEqual(postCalls[0], {
    apiPath: 'incentive/encode-v2',
    body: { walletAddress: 'wallet-1', positionAddresses: [], type: 2 },
  });
  assert.deepStrictEqual(signCalls, ['copy-payload']);
  assert.deepStrictEqual(postCalls[1], {
    apiPath: 'incentive/order-v2',
    body: {
      orderCode: 'copy-order-1',
      walletAddress: 'wallet-1',
      signedTxPayload: [{ txCode: 'copy-tx', poolAddress: 'pool-copy', signedTx: 'signed-copy-payload' }],
    },
  });
  assert.deepStrictEqual(entry.txSignatures, ['copy-sig-1']);
  assert.strictEqual(entry.totalBonusUsd, 12.5);
}

async function testCopyBonusEncodeRetry504(): Promise<void> {
  const { deps, postCalls, signCalls, sleepCalls } = makeCopyBonusDeps({
    encodeErrors: [new Error('POST incentive/encode-v2 504 Gateway Time-out')],
  });
  const entry = await claimCopyBonusWithDepsForTest(deps, 1000);
  assert.strictEqual(postCalls.filter((call) => call.apiPath === 'incentive/encode-v2').length, 2);
  assert.deepStrictEqual(sleepCalls.slice(0, 1), [5000]);
  assert.deepStrictEqual(signCalls, ['copy-payload']);
  assert.deepStrictEqual(entry.txSignatures, ['copy-sig-1']);
}

async function testCopyBonusOrderRetryDoesNotReencodeOrResign(): Promise<void> {
  const { deps, postCalls, signCalls, sleepCalls } = makeCopyBonusDeps({
    orderErrors: [new Error('POST incentive/order-v2 504 Gateway Time-out')],
  });
  const entry = await claimCopyBonusWithDepsForTest(deps, 1000);
  const encodeCalls = postCalls.filter((call) => call.apiPath === 'incentive/encode-v2');
  const orderCalls = postCalls.filter((call) => call.apiPath === 'incentive/order-v2');
  assert.strictEqual(encodeCalls.length, 1);
  assert.strictEqual(signCalls.length, 1);
  assert.strictEqual(orderCalls.length, 2);
  assert.deepStrictEqual(orderCalls[0].body, orderCalls[1].body);
  assert.deepStrictEqual(sleepCalls.slice(0, 1), [5000]);
  assert.deepStrictEqual(entry.txSignatures, ['copy-sig-1']);
}

async function testCopyBonusOrderRetryExhaustedDoesNotReencodeOrResign(): Promise<void> {
  const { deps, postCalls, signCalls, sleepCalls } = makeCopyBonusDeps({
    orderErrors: [
      new Error('POST incentive/order-v2 504 Gateway Time-out 1'),
      new Error('POST incentive/order-v2 504 Gateway Time-out 2'),
      new Error('POST incentive/order-v2 504 Gateway Time-out final'),
    ],
  });
  const entry = await claimCopyBonusWithDepsForTest(deps, 1000);
  const encodeCalls = postCalls.filter((call) => call.apiPath === 'incentive/encode-v2');
  const orderCalls = postCalls.filter((call) => call.apiPath === 'incentive/order-v2');
  assert.strictEqual(encodeCalls.length, 1);
  assert.strictEqual(signCalls.length, 1);
  assert.strictEqual(orderCalls.length, 3);
  assert.deepStrictEqual(orderCalls[0].body, orderCalls[1].body);
  assert.deepStrictEqual(orderCalls[1].body, orderCalls[2].body);
  assert.deepStrictEqual(sleepCalls, [5000, 10000]);
  assert.ok(entry.error?.includes('final'));
  assert.deepStrictEqual(entry.txSignatures, []);
}

async function testCopyBonusEncodeRetryExhaustedSetsError(): Promise<void> {
  const { deps, postCalls, signCalls, sleepCalls } = makeCopyBonusDeps({
    encodeErrors: [
      new Error('POST incentive/encode-v2 504 Gateway Time-out 1'),
      new Error('POST incentive/encode-v2 504 Gateway Time-out 2'),
      new Error('POST incentive/encode-v2 504 Gateway Time-out final'),
    ],
  });
  const entry = await claimCopyBonusWithDepsForTest(deps, 1000);
  assert.strictEqual(postCalls.filter((call) => call.apiPath === 'incentive/encode-v2').length, 3);
  assert.strictEqual(postCalls.filter((call) => call.apiPath === 'incentive/order-v2').length, 0);
  assert.deepStrictEqual(signCalls, []);
  assert.deepStrictEqual(sleepCalls, [5000, 10000]);
  assert.ok(entry.error?.includes('final'));
}

async function testCopyBonusAllSignaturesFailedSetsError(): Promise<void> {
  const { deps, postCalls } = makeCopyBonusDeps({ signError: new Error('sign failed') });
  const entry = await claimCopyBonusWithDepsForTest(deps, 1000);
  assert.strictEqual(postCalls.filter((call) => call.apiPath === 'incentive/order-v2').length, 0);
  assert.strictEqual(entry.error, 'all signatures failed');
}

async function testCopyBonusEpochFetchFailureFailsClosed(): Promise<void> {
  const { deps, postCalls } = makeCopyBonusDeps({ apiGetError: new Error('epoch down') });
  const entry = await claimCopyBonusWithDepsForTest(deps, 1000);
  assert.deepStrictEqual(postCalls, []);
  assert.ok(entry.error?.includes('epoch down'));
}

async function testCopyBonusLoopsUntilEpochZero(): Promise<void> {
  const { deps, postCalls, signCalls } = makeCopyBonusDeps({
    epochData: [
      { '3': claimableEpoch({ totalBonusUsd: '12.5' }) },
      { '3': claimableEpoch({ totalBonusUsd: '4.25' }) },
      { '3': claimableEpoch({ totalBonusUsd: '0' }) },
    ],
    encodeItems: [
      {
        orderCode: 'copy-order-1',
        rewardEncodeItems: [{ poolAddress: 'pool-copy-1', txCode: 'copy-tx-1', txPayload: 'copy-payload-1' }],
      },
      {
        orderCode: 'copy-order-2',
        rewardEncodeItems: [{ poolAddress: 'pool-copy-2', txCode: 'copy-tx-2', txPayload: 'copy-payload-2' }],
      },
    ],
  });
  const entry = await claimCopyBonusWithDepsForTest(deps, 1000);
  assert.strictEqual(postCalls.filter((call) => call.apiPath === 'incentive/encode-v2').length, 2);
  assert.strictEqual(postCalls.filter((call) => call.apiPath === 'incentive/order-v2').length, 2);
  assert.deepStrictEqual(signCalls, ['copy-payload-1', 'copy-payload-2']);
  assert.strictEqual(entry.totalPools, 2);
  assert.deepStrictEqual(entry.txSignatures, ['copy-sig-1', 'copy-sig-1']);
  assert.strictEqual(entry.error, undefined);
}

async function testCopyBonusPostSuccessEmptyItemsStopsCleanly(): Promise<void> {
  const { deps, postCalls } = makeCopyBonusDeps({
    epochData: [
      { '3': claimableEpoch() },
      { '3': claimableEpoch() },
    ],
    encodeItems: [
      {
        orderCode: 'copy-order-1',
        rewardEncodeItems: [{ poolAddress: 'pool-copy-1', txCode: 'copy-tx-1', txPayload: 'copy-payload-1' }],
      },
      { orderCode: 'copy-order-2', rewardEncodeItems: [] },
    ],
  });
  const entry = await claimCopyBonusWithDepsForTest(deps, 1000);
  assert.strictEqual(postCalls.filter((call) => call.apiPath === 'incentive/encode-v2').length, 2);
  assert.strictEqual(postCalls.filter((call) => call.apiPath === 'incentive/order-v2').length, 1);
  assert.deepStrictEqual(entry.txSignatures, ['copy-sig-1']);
  assert.strictEqual(entry.error, undefined);
}

async function testCopyBonusPostSuccessEpochStopsCleanly(): Promise<void> {
  for (const terminalEpoch of [
    {},
    { '3': claimableEpoch({ totalBonusUsd: 'bad' }) },
    { '3': claimableEpoch({ claimTime: 1500 }) },
    { '3': claimableEpoch({ endTime: 1000 }) },
  ]) {
    const { deps } = makeCopyBonusDeps({
      epochData: [
        { '3': claimableEpoch() },
        terminalEpoch,
      ],
      encodeItems: [
        {
          orderCode: 'copy-order-1',
          rewardEncodeItems: [{ poolAddress: 'pool-copy-1', txCode: 'copy-tx-1', txPayload: 'copy-payload-1' }],
        },
      ],
    });
    const entry = await claimCopyBonusWithDepsForTest(deps, 1000);
    assert.deepStrictEqual(entry.txSignatures, ['copy-sig-1']);
    assert.strictEqual(entry.error, undefined);
  }
}

async function testCopyBonusContinuesPastTenUntilEpochZero(): Promise<void> {
  const encodeItems = Array.from({ length: 12 }, (_value, index) => ({
    orderCode: `copy-order-${index}`,
    rewardEncodeItems: [{ poolAddress: `pool-copy-${index}`, txCode: `copy-tx-${index}`, txPayload: `copy-payload-${index}` }],
  }));
  const { deps, postCalls, signCalls } = makeCopyBonusDeps({
    epochData: [
      ...Array.from({ length: 12 }, () => ({ '3': claimableEpoch() })),
      { '3': claimableEpoch({ totalBonusUsd: '0' }) },
    ],
    encodeItems,
  });
  const entry = await claimCopyBonusWithDepsForTest(deps, 1000);
  assert.strictEqual(postCalls.filter((call) => call.apiPath === 'incentive/encode-v2').length, 12);
  assert.strictEqual(postCalls.filter((call) => call.apiPath === 'incentive/order-v2').length, 12);
  assert.strictEqual(signCalls.length, 12);
  assert.strictEqual(entry.totalPools, 12);
  assert.strictEqual(entry.error, undefined);
}

async function testCopyBonusDuplicateBatchStopsBeforeSecondOrder(): Promise<void> {
  const { deps, postCalls, signCalls } = makeCopyBonusDeps({
    epochData: [
      { '3': claimableEpoch() },
      { '3': claimableEpoch() },
    ],
    encodeItems: [
      {
        orderCode: 'copy-order-1',
        rewardEncodeItems: [{ poolAddress: 'pool-copy-1', txCode: 'copy-tx-1', txPayload: 'copy-payload-1' }],
      },
      {
        orderCode: 'copy-order-1',
        rewardEncodeItems: [{ poolAddress: 'pool-copy-1', txCode: 'copy-tx-1', txPayload: 'copy-payload-duplicate' }],
      },
    ],
  });
  const entry = await claimCopyBonusWithDepsForTest(deps, 1000);
  assert.strictEqual(postCalls.filter((call) => call.apiPath === 'incentive/encode-v2').length, 2);
  assert.strictEqual(postCalls.filter((call) => call.apiPath === 'incentive/order-v2').length, 1);
  assert.deepStrictEqual(signCalls, ['copy-payload-1']);
  assert.deepStrictEqual(entry.txSignatures, ['copy-sig-1']);
  assert.strictEqual(entry.error, undefined);
}

function testDashboardRouteShape(): void {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'dashboard', 'server.ts'), 'utf-8');
  const start = source.indexOf("if (method === 'POST' && pathname === '/api/actions/claim-all-byreal-fees')");
  const end = source.indexOf("if (method === 'POST' && pathname === '/api/actions/force-swap')", start);
  assert.ok(start >= 0 && end > start, 'claim-all route should be found');
  const body = source.slice(start, end);
  assert.ok(body.includes('claimLpFeesOffchain(conn)'));
  for (const field of ['ok:', 'totalItems:', 'txCount:', 'failures:', 'claimedTokens:', 'summary:']) {
    assert.ok(body.includes(field), `route should return ${field}`);
  }
}

async function main(): Promise<void> {
  await testCliParityFlow();
  await testNonJsonError();
  await testDirectSender();
  await testDuplicateAndFailedOutputs();
  await testNoFeeResend();
  await testCopyBonusSkipsEncodeWhenEpochMissing();
  await testCopyBonusMalformedEpochFailsClosed();
  await testCopyBonusSkipsEncodeOutsideWindow();
  await testCopyBonusAllowsAtClaimTime();
  await testCopyBonusEncodeRetry504();
  await testCopyBonusOrderRetryDoesNotReencodeOrResign();
  await testCopyBonusOrderRetryExhaustedDoesNotReencodeOrResign();
  await testCopyBonusEncodeRetryExhaustedSetsError();
  await testCopyBonusAllSignaturesFailedSetsError();
  await testCopyBonusEpochFetchFailureFailsClosed();
  await testCopyBonusLoopsUntilEpochZero();
  await testCopyBonusPostSuccessEmptyItemsStopsCleanly();
  await testCopyBonusPostSuccessEpochStopsCleanly();
  await testCopyBonusContinuesPastTenUntilEpochZero();
  await testCopyBonusDuplicateBatchStopsBeforeSecondOrder();
  testDashboardRouteShape();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
