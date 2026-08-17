import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import {
  getJupiterComputeBudgetInstructionType,
  stripJupiterComputeUnitPrice,
} from '../src/executor/jupiter-swap';

const SET_COMPUTE_UNIT_LIMIT = 2;
const SET_COMPUTE_UNIT_PRICE = 3;

const payer = new PublicKey('11111111111111111111111111111111');
const blockhash = '11111111111111111111111111111111';

function buildTx(instructions: TransactionInstruction[]): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

/** A Jupiter-shaped transaction: compute unit limit, Jupiter's own priority fee, then the swap. */
function buildJupiterTx(extraInstructions: TransactionInstruction[] = []): VersionedTransaction {
  return buildTx([
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 }),
    SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 }),
    ...extraInstructions,
  ]);
}

function instructionTypes(tx: VersionedTransaction): Array<number | null> {
  return tx.message.compiledInstructions.map((ix) =>
    getJupiterComputeBudgetInstructionType(tx, ix),
  );
}

function snapshotInstructions(tx: VersionedTransaction) {
  return tx.message.compiledInstructions.map((ix) => ({
    programIdIndex: ix.programIdIndex,
    accountKeyIndexes: [...ix.accountKeyIndexes],
    data: Buffer.from(ix.data).toString('hex'),
  }));
}

function nonComputeBudgetInstructions(tx: VersionedTransaction) {
  const snapshot = snapshotInstructions(tx);
  return snapshot.filter(
    (_entry, index) =>
      getJupiterComputeBudgetInstructionType(tx, tx.message.compiledInstructions[index]) === null,
  );
}

describe('stripJupiterComputeUnitPrice', () => {
  it('removes the Jupiter priority fee while keeping the compute unit limit', () => {
    const tx = buildJupiterTx();

    const result = stripJupiterComputeUnitPrice(tx);

    expect(result.removed).toBe(1);
    expect(instructionTypes(tx)).toEqual([SET_COMPUTE_UNIT_LIMIT, null]);
  });

  it('removes every priority fee instruction when Jupiter sends more than one', () => {
    const tx = buildJupiterTx([
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 2 }),
    ]);

    const result = stripJupiterComputeUnitPrice(tx);

    expect(result.removed).toBe(3);
    expect(instructionTypes(tx).filter((type) => type === SET_COMPUTE_UNIT_PRICE)).toEqual([]);
    expect(instructionTypes(tx).filter((type) => type === SET_COMPUTE_UNIT_LIMIT)).toHaveLength(1);
  });

  it('leaves a transaction untouched when it carries no priority fee', () => {
    const tx = buildTx([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 }),
      SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 }),
    ]);
    const before = snapshotInstructions(tx);

    const result = stripJupiterComputeUnitPrice(tx);

    expect(result.removed).toBe(0);
    expect(snapshotInstructions(tx)).toEqual(before);
  });

  it('preserves the swap instructions it is not meant to touch', () => {
    const tx = buildJupiterTx();
    const before = nonComputeBudgetInstructions(tx);

    stripJupiterComputeUnitPrice(tx);

    expect(nonComputeBudgetInstructions(tx)).toEqual(before);
  });

  it('does not misread instructions whose program id lives in an address lookup table', () => {
    const tx = buildJupiterTx();
    (tx.message as unknown as { addressTableLookups: unknown[] }).addressTableLookups = [
      {
        accountKey: new PublicKey('ComputeBudget111111111111111111111111111111'),
        writableIndexes: [1, 2],
        readonlyIndexes: [3],
      },
    ];
    // Program id index past the static keys — only resolvable through the lookup table, so the
    // stripper must not treat its ComputeBudget-looking payload as a priority fee.
    tx.message.compiledInstructions.push({
      programIdIndex: tx.message.staticAccountKeys.length + 1,
      accountKeyIndexes: [0],
      data: new Uint8Array([SET_COMPUTE_UNIT_PRICE, 1, 2, 3]),
    });
    const beforeLookups = JSON.stringify(tx.message.addressTableLookups);
    const beforeLast = snapshotInstructions(tx).at(-1);

    expect(() => stripJupiterComputeUnitPrice(tx)).not.toThrow();

    expect(JSON.stringify(tx.message.addressTableLookups)).toBe(beforeLookups);
    expect(snapshotInstructions(tx).at(-1)).toEqual(beforeLast);
  });

  it('leaves the stripped transaction serializable with its blockhash and account keys intact', () => {
    const tx = buildJupiterTx();
    const beforeBlockhash = tx.message.recentBlockhash;
    const beforeStaticKeys = tx.message.staticAccountKeys.map((key) => key.toBase58());
    const beforeLookups = JSON.stringify(tx.message.addressTableLookups);

    stripJupiterComputeUnitPrice(tx);
    const roundTripped = VersionedTransaction.deserialize(tx.serialize());

    expect(roundTripped.message.recentBlockhash).toBe(beforeBlockhash);
    expect(roundTripped.message.staticAccountKeys.map((key) => key.toBase58())).toEqual(
      beforeStaticKeys,
    );
    expect(JSON.stringify(roundTripped.message.addressTableLookups)).toBe(beforeLookups);
    expect(
      instructionTypes(roundTripped).filter((type) => type === SET_COMPUTE_UNIT_PRICE),
    ).toEqual([]);
  });
});
