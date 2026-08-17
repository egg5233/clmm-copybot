import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { ComputeBudgetProgram, PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js';

process.env.RPC_URL ||= 'http://127.0.0.1:8899';
process.env.WS_URL ||= 'ws://127.0.0.1:8900';
process.env.BOT2_WALLET ||= '11111111111111111111111111111111';

const root = path.join(__dirname, '..');
const configSource = fs.readFileSync(path.join(root, 'src', 'config.ts'), 'utf-8');
const byrealSource = fs.readFileSync(path.join(root, 'src', 'executor', 'byreal-position.ts'), 'utf-8');
const pcsSource = fs.readFileSync(path.join(root, 'src', 'executor', 'pancakeswap-position.ts'), 'utf-8');
const jupiterSource = fs.readFileSync(path.join(root, 'src', 'executor', 'jupiter-swap.ts'), 'utf-8');
const dashboardSource = fs.readFileSync(path.join(root, 'src', 'dashboard', 'server.ts'), 'utf-8');
const uiSource = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf-8');
const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf-8');
const readmeSource = fs.readFileSync(path.join(root, 'README.md'), 'utf-8');
const changelogSource = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf-8');

function count(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

function assertNoUnsupportedDirectOptions(source: string, fileLabel: string, sdkCalls = ['collectFeesInstructions', 'decreaseLiquidityInstructions', 'decreaseFullLiquidityInstructions']): void {
  for (const sdkCall of sdkCalls) {
    let index = source.indexOf(sdkCall);
    while (index >= 0) {
      const localCall = source.slice(index, index + 350);
      assert.ok(!localCall.includes('computeBudgetOptions'), `${fileLabel} should not pass computeBudgetOptions directly to ${sdkCall}`);
      index = source.indexOf(sdkCall, index + sdkCall.length);
    }
  }
}

assert.ok(
  configSource.includes('export const MIN_SDK_PRIORITY_FEE_MICROLAMPORTS = 1;'),
  'config should export the SDK minimum priority fee constant for Pancake compatibility',
);
assert.ok(
  configSource.includes("priorityFeeLamports: parseInt(process.env.PRIORITY_FEE_LAMPORTS || '50000')"),
  'config should keep priorityFeeLamports env parsing for legacy Dashboard compatibility',
);
assert.ok(
  configSource.includes('Byreal local transactions intentionally use zero priority fee') &&
    configSource.includes('Pancake SDK local transactions use MIN_SDK_PRIORITY_FEE_MICROLAMPORTS'),
  'config should document that Byreal uses zero priority fee while Pancake keeps the minimum fee constant',
);

assert.ok(
  !jupiterSource.includes('prioritizationFeeLamports') &&
    !jupiterSource.includes('config.priorityFeeLamports') &&
    jupiterSource.includes('stripJupiterComputeUnitPrice(tx)'),
  'Jupiter should strip compute-unit price before signing and should not request priority fee',
);
assert.ok(
  dashboardSource.includes('priorityFeeLamports'),
  'dashboard API should keep priorityFeeLamports compatibility',
);
assert.ok(uiSource.includes('priorityFeeLamports'), 'dashboard UI should keep priorityFeeLamports compatibility');
assert.ok(envExample.includes('PRIORITY_FEE_LAMPORTS'), '.env.example should keep PRIORITY_FEE_LAMPORTS');
assert.ok(readmeSource.includes('PRIORITY_FEE_LAMPORTS'), 'README should keep PRIORITY_FEE_LAMPORTS');
assert.ok(changelogSource.includes('v1.30.0'), 'CHANGELOG should remain readable and unchanged by this test scope');

assert.ok(
  !byrealSource.includes("import { config, MIN_SDK_PRIORITY_FEE_MICROLAMPORTS } from '../config';"),
  'Byreal executor should not import the SDK minimum fee constant',
);
assert.strictEqual(
  count(byrealSource, 'config.priorityFeeLamports'),
  0,
  'Byreal executor should not read config.priorityFeeLamports',
);
assert.ok(
  byrealSource.includes('makeByrealZeroPriorityTransaction') &&
    byrealSource.includes('makeSdkTransactionWithoutPriorityFee'),
  'Byreal executor should rebuild SDK instruction results through a zero-priority helper',
);
assert.ok(
  byrealSource.includes('stripByrealComputeUnitPriceInstructions') &&
    byrealSource.includes('ComputeBudgetProgram.programId') &&
    byrealSource.includes('isComputeBudgetInstructionType(ix, 3)'),
  'Byreal helper should strip SDK-provided setComputeUnitPrice instructions before building the transaction',
);
assert.ok(
  count(byrealSource, 'makeSdkTransactionWithoutPriorityFee(result)') >= 7,
  'Byreal close/decrease/collect paths should use the zero-priority helper',
);
assert.strictEqual(
  count(byrealSource, 'computeUnitPrice: MIN_SDK_PRIORITY_FEE_MICROLAMPORTS'),
  0,
  'Byreal should not add the SDK minimum compute unit price',
);
assert.strictEqual(
  count(byrealSource, 'makeTransaction({'),
  0,
  'Byreal should not call SDK makeTransaction because it defaults computeUnitPrice to 50000',
);
assertNoUnsupportedDirectOptions(byrealSource, 'Byreal executor', [
  'collectFeesInstructions',
  'decreaseLiquidityInstructions',
  'decreaseFullLiquidityInstructions',
  'addLiquidityInstructions',
]);

function decodedComputeBudget(tx: VersionedTransaction): Array<{ type: number; limit?: number; price?: bigint }> {
  const result: Array<{ type: number; limit?: number; price?: bigint }> = [];
  for (const ix of tx.message.compiledInstructions) {
    const programId = tx.message.staticAccountKeys[ix.programIdIndex];
    if (!programId?.equals(ComputeBudgetProgram.programId)) continue;
    const data = Buffer.from(ix.data);
    const entry: { type: number; limit?: number; price?: bigint } = { type: data[0] };
    if (data[0] === 2 && data.length >= 5) entry.limit = data.readUInt32LE(1);
    if (data[0] === 3 && data.length >= 9) entry.price = data.readBigUInt64LE(1);
    result.push(entry);
  }
  return result;
}

async function assertByrealZeroPriorityBuilder(): Promise<void> {
  const { makeByrealZeroPriorityTransaction } = require('../src/executor/byreal-position') as typeof import('../src/executor/byreal-position');
  assert.strictEqual(typeof makeByrealZeroPriorityTransaction, 'function', 'Byreal should export a testable zero-priority transaction builder');

  const payer = new PublicKey('11111111111111111111111111111111');
  const mockConnection = {
    getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111' }),
    simulateTransaction: async () => ({ value: { logs: ['ok'], unitsConsumed: 123456 } }),
  };

  const baseInstruction = SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 });
  const withExistingBudget = await makeByrealZeroPriorityTransaction({
    connection: mockConnection as any,
    payerPublicKey: payer,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 266515 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 }),
      baseInstruction,
    ],
  });
  const existingBudget = decodedComputeBudget(withExistingBudget);
  assert.strictEqual(existingBudget.filter((ix) => ix.type === 3).length, 0, 'existing SDK price instruction should be stripped');
  assert.deepStrictEqual(
    existingBudget.filter((ix) => ix.type === 2).map((ix) => ix.limit),
    [266515],
    'existing compute unit limit should be preserved without adding a duplicate limit',
  );

  const withoutExistingBudget = await makeByrealZeroPriorityTransaction({
    connection: mockConnection as any,
    payerPublicKey: payer,
    instructions: [baseInstruction],
  });
  const inferredBudget = decodedComputeBudget(withoutExistingBudget);
  assert.strictEqual(inferredBudget.filter((ix) => ix.type === 3).length, 0, 'builder should never add a price instruction');
  assert.deepStrictEqual(
    inferredBudget.filter((ix) => ix.type === 2).map((ix) => ix.limit),
    [223456],
    'builder should estimate and prepend one compute unit limit when none exists',
  );
}

assert.ok(
  pcsSource.includes("import { config, MIN_SDK_PRIORITY_FEE_MICROLAMPORTS } from '../config';"),
  'Pancake executor should import the SDK minimum fee constant',
);
assert.strictEqual(
  count(pcsSource, 'config.priorityFeeLamports'),
  0,
  'Pancake executor should not read config.priorityFeeLamports',
);
assert.ok(
  pcsSource.includes('makeSdkTransactionWithMinimumPriorityFee'),
  'Pancake executor should rebuild unsupported SDK instruction results through a minimum-fee helper',
);
assert.ok(
  pcsSource.includes('stripSdkComputeUnitPriceInstructions') &&
    pcsSource.includes('ComputeBudgetProgram.programId') &&
    pcsSource.includes('data[0] !== 3'),
  'Pancake helper should strip SDK-provided setComputeUnitPrice instructions before adding the minimum fee',
);
assert.ok(
  count(pcsSource, 'makeSdkTransactionWithMinimumPriorityFee(result)') >= 5 &&
    pcsSource.includes('makeSdkTransactionWithMinimumPriorityFee(feeResult)'),
  'Pancake close/decrease/collect paths should use the minimum-fee helper',
);
assert.ok(
  count(pcsSource, 'computeUnitPrice: MIN_SDK_PRIORITY_FEE_MICROLAMPORTS') >= 3,
  'Pancake create, add, and helper paths should use the minimum fee constant',
);
assertNoUnsupportedDirectOptions(pcsSource, 'Pancake executor');

assertByrealZeroPriorityBuilder().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
