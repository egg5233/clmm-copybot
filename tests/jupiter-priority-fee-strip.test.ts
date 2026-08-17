import assert from 'assert';
import fs from 'fs';
import path from 'path';
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';

process.env.RPC_URL ||= 'http://127.0.0.1:8899';
process.env.WS_URL ||= 'ws://127.0.0.1:8900';
process.env.BOT2_WALLET ||= '11111111111111111111111111111111';

import {
  getJupiterComputeBudgetInstructionType,
  stripJupiterComputeUnitPrice,
} from '../src/executor/jupiter-swap';

const payer = new PublicKey('11111111111111111111111111111111');
const blockhash = '11111111111111111111111111111111';

function buildTx(extraInstructions: any[] = []): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 }),
      SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 }),
      ...extraInstructions,
    ],
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

function instructionTypes(tx: VersionedTransaction): Array<number | null> {
  return tx.message.compiledInstructions.map((ix) => getJupiterComputeBudgetInstructionType(tx, ix));
}

function cloneCompiledInstructions(tx: VersionedTransaction) {
  return tx.message.compiledInstructions.map((ix) => ({
    programIdIndex: ix.programIdIndex,
    accountKeyIndexes: [...ix.accountKeyIndexes],
    data: Buffer.from(ix.data).toString('hex'),
  }));
}

function testRemovesPriceAndKeepsLimit() {
  const tx = buildTx();
  const result = stripJupiterComputeUnitPrice(tx);

  assert.strictEqual(result.removed, 1);
  assert.deepStrictEqual(instructionTypes(tx), [2, null]);
}

function testRemovesMultiplePriceInstructions() {
  const tx = buildTx([
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2 }),
  ]);
  const result = stripJupiterComputeUnitPrice(tx);

  assert.strictEqual(result.removed, 3);
  assert.strictEqual(instructionTypes(tx).filter((type) => type === 3).length, 0);
  assert.strictEqual(instructionTypes(tx).filter((type) => type === 2).length, 1);
}

function testNoPriceNoop() {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
      SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 }),
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  const before = cloneCompiledInstructions(tx);

  const result = stripJupiterComputeUnitPrice(tx);

  assert.strictEqual(result.removed, 0);
  assert.deepStrictEqual(cloneCompiledInstructions(tx), before);
}

function testPreservesNonComputeBudgetInstruction() {
  const tx = buildTx();
  const before = tx.message.compiledInstructions
    .map((ix, index) => ({ index, type: getJupiterComputeBudgetInstructionType(tx, ix) }))
    .filter((entry) => entry.type === null)
    .map((entry) => cloneCompiledInstructions(tx)[entry.index]);

  stripJupiterComputeUnitPrice(tx);

  const after = tx.message.compiledInstructions
    .map((ix, index) => ({ index, type: getJupiterComputeBudgetInstructionType(tx, ix) }))
    .filter((entry) => entry.type === null)
    .map((entry) => cloneCompiledInstructions(tx)[entry.index]);
  assert.deepStrictEqual(after, before);
}

function testPreservesLookupMetadataAndOutOfStaticProgramIndex() {
  const tx = buildTx();
  const lookup = {
    accountKey: new PublicKey('ComputeBudget111111111111111111111111111111'),
    writableIndexes: [1, 2],
    readonlyIndexes: [3],
  };
  (tx.message as any).addressTableLookups = [lookup];
  tx.message.compiledInstructions.push({
    programIdIndex: tx.message.staticAccountKeys.length + 1,
    accountKeyIndexes: [0],
    data: new Uint8Array([3, 1, 2, 3]),
  });
  const beforeLookup = JSON.stringify(tx.message.addressTableLookups);
  const beforeLast = cloneCompiledInstructions(tx).at(-1);

  assert.doesNotThrow(() => stripJupiterComputeUnitPrice(tx));

  assert.strictEqual(JSON.stringify(tx.message.addressTableLookups), beforeLookup);
  assert.deepStrictEqual(cloneCompiledInstructions(tx).at(-1), beforeLast);
}

function testSerializationRoundTripAfterStrip() {
  const tx = buildTx();
  const beforeBlockhash = tx.message.recentBlockhash;
  const beforeStaticKeys = tx.message.staticAccountKeys.map((key) => key.toBase58());
  const beforeLookups = JSON.stringify(tx.message.addressTableLookups);

  stripJupiterComputeUnitPrice(tx);
  const roundTripped = VersionedTransaction.deserialize(tx.serialize());

  assert.strictEqual(roundTripped.message.recentBlockhash, beforeBlockhash);
  assert.deepStrictEqual(roundTripped.message.staticAccountKeys.map((key) => key.toBase58()), beforeStaticKeys);
  assert.strictEqual(JSON.stringify(roundTripped.message.addressTableLookups), beforeLookups);
  assert.strictEqual(instructionTypes(roundTripped).filter((type) => type === 3).length, 0);
}

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `${name} should exist`);
  const nextFunction = source.indexOf('\nasync function ', start + 1);
  return source.slice(start, nextFunction >= 0 ? nextFunction : source.length);
}

function assertStripBeforeSign(source: string, functionName: string) {
  const body = functionBody(source, functionName);
  const deserializeIndex = body.indexOf('VersionedTransaction.deserialize');
  const stripIndex = body.indexOf('stripJupiterComputeUnitPrice(tx)');
  const signIndex = body.indexOf('signVersioned(tx)');

  assert.ok(deserializeIndex >= 0, `${functionName} should deserialize Jupiter transaction`);
  assert.ok(stripIndex > deserializeIndex, `${functionName} should strip after deserialization`);
  assert.ok(signIndex > stripIndex, `${functionName} should sign after stripping priority fee`);
}

function testJupiterSourceIntegration() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'executor', 'jupiter-swap.ts'), 'utf-8');

  assert.ok(!source.includes('prioritizationFeeLamports'), 'Metis swap body should not request Jupiter priority fee');
  assertStripBeforeSign(source, 'buildAndSendMetis');
  assertStripBeforeSign(source, 'ultraSwap');
}

testRemovesPriceAndKeepsLimit();
testRemovesMultiplePriceInstructions();
testNoPriceNoop();
testPreservesNonComputeBudgetInstruction();
testPreservesLookupMetadataAndOutOfStaticProgramIndex();
testSerializationRoundTripAfterStrip();
testJupiterSourceIntegration();
console.log('jupiter priority fee strip tests passed');
