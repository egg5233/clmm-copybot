import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
} from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import {
  makeByrealZeroPriorityTransaction,
  stripByrealComputeUnitPriceInstructions,
} from '../src/executor/byreal-position';

const SET_COMPUTE_UNIT_LIMIT = 2;
const SET_COMPUTE_UNIT_PRICE = 3;

const payer = new PublicKey('11111111111111111111111111111111');
const transfer = SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 });

/** The Byreal SDK charges 50000 microLamports by default; the bot rebuilds without it. */
const SDK_DEFAULT_PRICE = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 });

const SIMULATED_UNITS_CONSUMED = 123456;

function mockConnection(): Connection {
  return {
    getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111' }),
    simulateTransaction: async () => ({
      value: { logs: ['ok'], unitsConsumed: SIMULATED_UNITS_CONSUMED },
    }),
  } as unknown as Connection;
}

function computeBudgetInstructions(
  tx: VersionedTransaction,
): Array<{ type: number; limit?: number; price?: bigint }> {
  const decoded: Array<{ type: number; limit?: number; price?: bigint }> = [];
  for (const ix of tx.message.compiledInstructions) {
    const programId = tx.message.staticAccountKeys[ix.programIdIndex];
    if (!programId?.equals(ComputeBudgetProgram.programId)) continue;
    const data = Buffer.from(ix.data);
    const entry: { type: number; limit?: number; price?: bigint } = { type: data[0] };
    if (data[0] === SET_COMPUTE_UNIT_LIMIT && data.length >= 5) entry.limit = data.readUInt32LE(1);
    if (data[0] === SET_COMPUTE_UNIT_PRICE && data.length >= 9)
      entry.price = data.readBigUInt64LE(1);
    decoded.push(entry);
  }
  return decoded;
}

describe('stripByrealComputeUnitPriceInstructions', () => {
  it('drops the SDK priority fee and keeps every other instruction in order', () => {
    const limit = ComputeBudgetProgram.setComputeUnitLimit({ units: 266515 });

    const stripped = stripByrealComputeUnitPriceInstructions([limit, SDK_DEFAULT_PRICE, transfer]);

    expect(stripped).toEqual([limit, transfer]);
  });

  it('leaves instructions untouched when the SDK sent no priority fee', () => {
    const instructions = [ComputeBudgetProgram.setComputeUnitLimit({ units: 266515 }), transfer];

    expect(stripByrealComputeUnitPriceInstructions(instructions)).toEqual(instructions);
  });
});

describe('makeByrealZeroPriorityTransaction', () => {
  it('strips the SDK priority fee and preserves the existing limit without duplicating it', async () => {
    const tx = await makeByrealZeroPriorityTransaction({
      connection: mockConnection(),
      payerPublicKey: payer,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 266515 }),
        SDK_DEFAULT_PRICE,
        transfer,
      ],
    });

    const budget = computeBudgetInstructions(tx);
    expect(budget.filter((ix) => ix.type === SET_COMPUTE_UNIT_PRICE)).toEqual([]);
    expect(budget.filter((ix) => ix.type === SET_COMPUTE_UNIT_LIMIT).map((ix) => ix.limit)).toEqual(
      [266515],
    );
  });

  it('prepends exactly one estimated limit when the SDK supplied none, and still adds no price', async () => {
    const tx = await makeByrealZeroPriorityTransaction({
      connection: mockConnection(),
      payerPublicKey: payer,
      instructions: [transfer],
    });

    const budget = computeBudgetInstructions(tx);
    expect(budget.filter((ix) => ix.type === SET_COMPUTE_UNIT_PRICE)).toEqual([]);
    expect(budget.filter((ix) => ix.type === SET_COMPUTE_UNIT_LIMIT).map((ix) => ix.limit)).toEqual(
      [SIMULATED_UNITS_CONSUMED + 100_000],
    );
  });

  it('honours an explicit compute unit limit instead of simulating for one', async () => {
    const tx = await makeByrealZeroPriorityTransaction({
      connection: mockConnection(),
      payerPublicKey: payer,
      instructions: [transfer],
      computeUnitLimit: 200_000,
    });

    const budget = computeBudgetInstructions(tx);
    expect(budget.filter((ix) => ix.type === SET_COMPUTE_UNIT_PRICE)).toEqual([]);
    expect(budget.filter((ix) => ix.type === SET_COMPUTE_UNIT_LIMIT).map((ix) => ix.limit)).toEqual(
      [200_000],
    );
  });
});
