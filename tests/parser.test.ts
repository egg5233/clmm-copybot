import { Connection, ParsedTransactionWithMeta, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { config } from '../src/config';
import { parseTransaction } from '../src/monitor/parser';

// Program ids the parser matches on. Byreal/Orca/Memo come from config; DAMM v2 is
// hardcoded in parser.ts (DAMMV2_PROGRAM_ID) so it is repeated verbatim here.
const BYREAL = config.byrealProgramId.toBase58();
const ORCA = config.orcaProgramId.toBase58();
const MEMO = config.memoProgramId.toBase58();
const DAMMV2 = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
const SYSTEM_SUCCESS = 'Program 11111111111111111111111111111111 success';

/** Deterministic 32-byte pubkeys — never used as real accounts, only as identity tokens. */
function addr(seed: number): PublicKey {
  const bytes = new Uint8Array(32);
  bytes[0] = seed & 0xff;
  bytes[1] = (seed >> 8) & 0xff;
  bytes[31] = 7;
  return new PublicKey(bytes);
}

const TARGET = addr(1);
const OTHER_WALLET = addr(2);
const NFT_MINT = addr(3);
const OLD_NFT_MINT = addr(4);
const POOL = addr(5);
const MINT_A = addr(6);
const MINT_B = addr(7);
const REFERER_POSITION = addr(8);
const FOREIGN_PROGRAM = addr(9);
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');

interface TokenBalanceFixture {
  accountIndex: number;
  mint: string;
  owner: string;
  uiTokenAmount: { amount: string; decimals: number; uiAmount: number | null; uiAmountString: string };
}

/** Position NFT: decimals 0, amount 1 (held) or 0 (burned/emptied). */
function nftBalance(accountIndex: number, mint: PublicKey, owner: PublicKey, held = true): TokenBalanceFixture {
  return {
    accountIndex,
    mint: mint.toBase58(),
    owner: owner.toBase58(),
    uiTokenAmount: {
      amount: held ? '1' : '0',
      decimals: 0,
      uiAmount: held ? 1 : 0,
      uiAmountString: held ? '1' : '0',
    },
  };
}

function tokenBalance(
  accountIndex: number,
  mint: PublicKey,
  owner: PublicKey,
  raw: string,
  decimals: number,
): TokenBalanceFixture {
  const ui = Number(raw) / 10 ** decimals;
  return {
    accountIndex,
    mint: mint.toBase58(),
    owner: owner.toBase58(),
    uiTokenAmount: { amount: raw, decimals, uiAmount: ui, uiAmountString: String(ui) },
  };
}

/** Anchor discriminator (first 8 bytes of instruction data) as the parser sees it: bs58. */
function discData(hex: string): string {
  return bs58.encode(Buffer.from(hex, 'hex'));
}

function ix(programId: string, accounts: PublicKey[], data = ''): unknown {
  return { programId: new PublicKey(programId), accounts, data };
}

/** "Program <id> invoke [1]" + Anchor "Program log: Instruction: <Name>" lines + success. */
function programLogs(programId: string, instructionNames: string[] = []): string[] {
  return [
    `Program ${programId} invoke [1]`,
    ...instructionNames.map(name => `Program log: Instruction: ${name}`),
    `Program ${programId} success`,
  ];
}

function memoLogs(referer: PublicKey): string[] {
  const memo = `referer_position=${referer.toBase58()}`;
  return [
    `Program ${MEMO} invoke [1]`,
    `Program log: Memo (len ${memo.length}): "${memo}"`,
    `Program ${MEMO} success`,
  ];
}

/**
 * Raydium-fork OpenPosition account layout the parser indexes into.
 *   Token22: [2]nftMint [4]poolState [18]mintA [19]mintB
 *   V2:      [2]nftMint [5]poolState [20]mintA [21]mintB
 */
function byrealOpenAccounts(opts: { token22: boolean; nftMint?: PublicKey; withMints?: boolean }): PublicKey[] {
  const poolIdx = opts.token22 ? 4 : 5;
  const mintAIdx = opts.token22 ? 18 : 20;
  const mintBIdx = opts.token22 ? 19 : 21;
  const withMints = opts.withMints !== false;
  const size = withMints ? mintBIdx + 1 : poolIdx + 1;

  const accounts: PublicKey[] = [];
  for (let i = 0; i < size; i++) accounts.push(addr(200 + i));
  accounts[2] = opts.nftMint ?? NFT_MINT;
  accounts[poolIdx] = POOL;
  if (withMints) {
    accounts[mintAIdx] = MINT_A;
    accounts[mintBIdx] = MINT_B;
  }
  return accounts;
}

function makeTx(opts: {
  instructions?: unknown[];
  innerInstructions?: unknown[];
  pre?: TokenBalanceFixture[];
  post?: TokenBalanceFixture[];
  accountKeys?: PublicKey[];
  preBalances?: number[];
  postBalances?: number[];
  err?: unknown;
}): ParsedTransactionWithMeta {
  const accountKeys = opts.accountKeys ?? [TARGET];
  return {
    slot: 1,
    blockTime: 0,
    transaction: {
      signatures: ['test-signature'],
      message: {
        accountKeys: accountKeys.map(pubkey => ({ pubkey, signer: true, writable: true })),
        instructions: opts.instructions ?? [],
        recentBlockhash: '11111111111111111111111111111111',
      },
    },
    meta: {
      err: opts.err ?? null,
      fee: 5000,
      preBalances: opts.preBalances ?? accountKeys.map(() => 1_000_000_000),
      postBalances: opts.postBalances ?? accountKeys.map(() => 1_000_000_000),
      innerInstructions: opts.innerInstructions ? [{ index: 0, instructions: opts.innerInstructions }] : [],
      preTokenBalances: opts.pre ?? [],
      postTokenBalances: opts.post ?? [],
      logMessages: [],
    },
  } as unknown as ParsedTransactionWithMeta;
}

function fakeConnection(tx: ParsedTransactionWithMeta | null) {
  const fetched: string[] = [];
  const connection = {
    getParsedTransaction: async (signature: string) => {
      fetched.push(signature);
      return tx;
    },
  } as unknown as Connection;
  return { connection, fetched };
}

describe('parseTransaction — Byreal CLMM', () => {
  it('classifies OpenPositionWithToken22Nft as an open with pool id and pool mints', async () => {
    const { connection } = fakeConnection(
      makeTx({
        instructions: [ix(BYREAL, byrealOpenAccounts({ token22: true }))],
        post: [nftBalance(1, NFT_MINT, TARGET)],
      }),
    );

    const events = await parseTransaction(
      connection,
      'sig',
      programLogs(BYREAL, ['OpenPositionWithToken22Nft']),
      TARGET,
    );

    expect(events).toEqual([
      {
        type: 'BYREAL_OPEN_POSITION',
        poolId: POOL.toBase58(),
        tickLower: 0,
        tickUpper: 0,
        liquidity: '0',
        refererPosition: null,
        tokenAmountA: '0',
        tokenAmountB: '0',
        positionNftMint: NFT_MINT.toBase58(),
        poolMints: `${MINT_A.toBase58()}/${MINT_B.toBase58()}`,
      },
    ]);
  });

  it('switches to the V2 account layout when the Token22 log is absent', async () => {
    const { connection } = fakeConnection(
      makeTx({
        instructions: [ix(BYREAL, byrealOpenAccounts({ token22: false }))],
        post: [nftBalance(1, NFT_MINT, TARGET)],
      }),
    );

    const events = await parseTransaction(connection, 'sig', programLogs(BYREAL, ['OpenPositionV2']), TARGET);

    // Pool moves from index 4 to 5 and the vault mints from 18/19 to 20/21.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'BYREAL_OPEN_POSITION',
      poolId: POOL.toBase58(),
      poolMints: `${MINT_A.toBase58()}/${MINT_B.toBase58()}`,
    });
  });

  it('extracts referer_position from the memo log', async () => {
    const { connection } = fakeConnection(
      makeTx({
        instructions: [ix(BYREAL, byrealOpenAccounts({ token22: true }))],
        post: [nftBalance(1, NFT_MINT, TARGET)],
      }),
    );

    const events = await parseTransaction(
      connection,
      'sig',
      [...programLogs(BYREAL, ['OpenPositionWithToken22Nft']), ...memoLogs(REFERER_POSITION)],
      TARGET,
    );

    expect(events[0]).toMatchObject({
      type: 'BYREAL_OPEN_POSITION',
      refererPosition: REFERER_POSITION.toBase58(),
    });
  });

  it('ignores a newly minted position NFT owned by another wallet', async () => {
    const { connection } = fakeConnection(
      makeTx({
        instructions: [ix(BYREAL, byrealOpenAccounts({ token22: true }))],
        post: [nftBalance(1, NFT_MINT, OTHER_WALLET)],
      }),
    );

    const events = await parseTransaction(
      connection,
      'sig',
      programLogs(BYREAL, ['OpenPositionWithToken22Nft']),
      TARGET,
    );

    expect(events).toEqual([{ type: 'UNKNOWN' }]);
  });

  it('emits an open with an empty pool id when no Byreal instruction is available to read', async () => {
    const { connection } = fakeConnection(
      makeTx({
        instructions: [ix(FOREIGN_PROGRAM.toBase58(), byrealOpenAccounts({ token22: true }))],
        post: [nftBalance(1, NFT_MINT, TARGET)],
      }),
    );

    const events = await parseTransaction(
      connection,
      'sig',
      programLogs(BYREAL, ['OpenPositionWithToken22Nft']),
      TARGET,
    );

    // Accounts are only read from instructions whose programId is Byreal.
    expect(events[0]).toMatchObject({
      type: 'BYREAL_OPEN_POSITION',
      poolId: '',
      positionNftMint: NFT_MINT.toBase58(),
    });
    expect((events[0] as { poolMints?: string }).poolMints).toBeUndefined();
  });

  it('reads Byreal instructions nested in inner instructions', async () => {
    const { connection } = fakeConnection(
      makeTx({
        instructions: [ix(FOREIGN_PROGRAM.toBase58(), [])],
        innerInstructions: [ix(BYREAL, byrealOpenAccounts({ token22: true }))],
        post: [nftBalance(1, NFT_MINT, TARGET)],
      }),
    );

    const events = await parseTransaction(
      connection,
      'sig',
      programLogs(BYREAL, ['OpenPositionWithToken22Nft']),
      TARGET,
    );

    expect(events[0]).toMatchObject({ type: 'BYREAL_OPEN_POSITION', poolId: POOL.toBase58() });
  });

  it('classifies IncreaseLiquidityV2 on a held position NFT as an increase', async () => {
    const held = [nftBalance(1, NFT_MINT, TARGET)];
    const { connection } = fakeConnection(
      makeTx({
        instructions: [ix(BYREAL, byrealOpenAccounts({ token22: true }))],
        pre: held,
        post: held,
      }),
    );

    const events = await parseTransaction(connection, 'sig', programLogs(BYREAL, ['IncreaseLiquidityV2']), TARGET);

    expect(events).toEqual([{ type: 'BYREAL_INCREASE_LIQUIDITY', positionNftMint: NFT_MINT.toBase58() }]);
  });

  it('suppresses the increase event when the same TX also opens a position', async () => {
    const { connection } = fakeConnection(
      makeTx({
        instructions: [ix(BYREAL, byrealOpenAccounts({ token22: true }))],
        pre: [nftBalance(9, OLD_NFT_MINT, TARGET)],
        post: [nftBalance(9, OLD_NFT_MINT, TARGET), nftBalance(1, NFT_MINT, TARGET)],
      }),
    );

    const events = await parseTransaction(
      connection,
      'sig',
      programLogs(BYREAL, ['OpenPositionWithToken22Nft', 'IncreaseLiquidityV2']),
      TARGET,
    );

    // The pre-held NFT would have produced an increase had open not taken priority.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'BYREAL_OPEN_POSITION', positionNftMint: NFT_MINT.toBase58() });
  });

  it('classifies DecreaseLiquidityV2 with the NFT still held as a partial decrease', async () => {
    const held = [nftBalance(1, NFT_MINT, TARGET)];
    const { connection } = fakeConnection(
      makeTx({
        instructions: [ix(BYREAL, byrealOpenAccounts({ token22: true }))],
        pre: held,
        post: held,
      }),
    );

    const events = await parseTransaction(connection, 'sig', programLogs(BYREAL, ['DecreaseLiquidityV2']), TARGET);

    expect(events).toEqual([
      { type: 'BYREAL_DECREASE_LIQUIDITY', positionNftMint: NFT_MINT.toBase58(), liquidity: '0' },
    ]);
  });

  it('reports a fee-collection TX as a decrease, never as BYREAL_COLLECT_FEES', async () => {
    // Byreal collectFees is a DecreaseLiquidity with zero liquidity that still pays out
    // fee tokens; the parser has no separate collect-fee branch for Byreal.
    const { connection } = fakeConnection(
      makeTx({
        instructions: [ix(BYREAL, byrealOpenAccounts({ token22: true }))],
        pre: [nftBalance(1, NFT_MINT, TARGET), tokenBalance(2, MINT_A, TARGET, '100', 6)],
        post: [nftBalance(1, NFT_MINT, TARGET), tokenBalance(2, MINT_A, TARGET, '5100', 6)],
      }),
    );

    const events = await parseTransaction(connection, 'sig', programLogs(BYREAL, ['DecreaseLiquidityV2']), TARGET);

    expect(events).toEqual([
      { type: 'BYREAL_DECREASE_LIQUIDITY', positionNftMint: NFT_MINT.toBase58(), liquidity: '0' },
    ]);
  });

  it('classifies ClosePosition as a close carrying the tokens received', async () => {
    const { connection } = fakeConnection(
      makeTx({
        instructions: [ix(BYREAL, byrealOpenAccounts({ token22: true }))],
        pre: [nftBalance(1, NFT_MINT, TARGET), tokenBalance(2, MINT_A, TARGET, '100', 6)],
        post: [tokenBalance(2, MINT_A, TARGET, '1100', 6), tokenBalance(3, MINT_B, TARGET, '500', 9)],
      }),
    );

    const events = await parseTransaction(connection, 'sig', programLogs(BYREAL, ['ClosePosition']), TARGET);

    expect(events).toEqual([
      {
        type: 'BYREAL_CLOSE_POSITION',
        positionNftMint: NFT_MINT.toBase58(),
        receivedTokens: [
          { mint: MINT_A.toBase58(), amount: '1000' },
          { mint: MINT_B.toBase58(), amount: '500' },
        ],
      },
    ]);
  });

  it('treats a position NFT zeroed in post-balances as closed', async () => {
    const { connection } = fakeConnection(
      makeTx({
        instructions: [ix(BYREAL, byrealOpenAccounts({ token22: true }))],
        pre: [nftBalance(1, NFT_MINT, TARGET)],
        post: [nftBalance(1, NFT_MINT, TARGET, false)],
      }),
    );

    const events = await parseTransaction(connection, 'sig', programLogs(BYREAL, ['ClosePosition']), TARGET);

    expect(events).toEqual([
      { type: 'BYREAL_CLOSE_POSITION', positionNftMint: NFT_MINT.toBase58(), receivedTokens: [] },
    ]);
  });

  it('emits only the close when decrease and close appear in the same TX', async () => {
    const { connection } = fakeConnection(
      makeTx({
        instructions: [ix(BYREAL, byrealOpenAccounts({ token22: true }))],
        pre: [nftBalance(1, NFT_MINT, TARGET)],
        post: [],
      }),
    );

    const events = await parseTransaction(
      connection,
      'sig',
      programLogs(BYREAL, ['DecreaseLiquidityV2', 'ClosePosition']),
      TARGET,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'BYREAL_CLOSE_POSITION' });
  });

  it('does not also emit a swap when a Byreal LP event was parsed', async () => {
    const { connection } = fakeConnection(
      makeTx({
        instructions: [ix(BYREAL, byrealOpenAccounts({ token22: true }))],
        pre: [nftBalance(1, NFT_MINT, TARGET), tokenBalance(2, MINT_A, TARGET, '1000000000', 6)],
        post: [
          nftBalance(1, NFT_MINT, TARGET),
          tokenBalance(2, MINT_A, TARGET, '400000000', 6),
          tokenBalance(3, MINT_B, TARGET, '250000000', 9),
        ],
      }),
    );

    const events = await parseTransaction(connection, 'sig', programLogs(BYREAL, ['DecreaseLiquidityV2']), TARGET);

    // Balances alone look exactly like a swap; the Byreal branch must win.
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('BYREAL_DECREASE_LIQUIDITY');
  });

  it('ignores Raydium-style instruction logs emitted by a non-Byreal program', async () => {
    const { connection, fetched } = fakeConnection(
      makeTx({
        instructions: [ix(FOREIGN_PROGRAM.toBase58(), byrealOpenAccounts({ token22: true }))],
        post: [nftBalance(1, NFT_MINT, TARGET)],
      }),
    );

    const events = await parseTransaction(
      connection,
      'sig',
      programLogs(FOREIGN_PROGRAM.toBase58(), ['OpenPositionWithToken22Nft']),
      TARGET,
    );

    expect(events).toEqual([{ type: 'UNKNOWN' }]);
    expect(fetched).toHaveLength(1);
  });
});

describe('parseTransaction — routing and early exits', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips mass system-program transfers without fetching the TX', async () => {
    const { connection, fetched } = fakeConnection(makeTx({}));

    const events = await parseTransaction(
      connection,
      'spam-signature',
      Array.from({ length: 5 }, () => SYSTEM_SUCCESS),
      TARGET,
    );

    expect(events).toEqual([{ type: 'UNKNOWN' }]);
    expect(fetched).toEqual([]);
  });

  it('still fetches when a compute-budget log accompanies the system-program successes', async () => {
    const { connection, fetched } = fakeConnection(makeTx({}));

    const events = await parseTransaction(
      connection,
      'sig',
      [
        'Program ComputeBudget111111111111111111111111111111 invoke [1]',
        ...Array.from({ length: 5 }, () => SYSTEM_SUCCESS),
      ],
      TARGET,
    );

    expect(events).toEqual([{ type: 'UNKNOWN' }]);
    expect(fetched).toEqual(['sig']);
  });

  it('returns UNKNOWN for a reverted TX', async () => {
    const { connection } = fakeConnection(
      makeTx({
        instructions: [ix(BYREAL, byrealOpenAccounts({ token22: true }))],
        post: [nftBalance(1, NFT_MINT, TARGET)],
        err: { InstructionError: [0, { Custom: 6001 }] },
      }),
    );

    const events = await parseTransaction(
      connection,
      'sig',
      programLogs(BYREAL, ['OpenPositionWithToken22Nft']),
      TARGET,
    );

    expect(events).toEqual([{ type: 'UNKNOWN' }]);
  });

  it('retries three times then returns UNKNOWN when the TX never propagates', async () => {
    vi.useFakeTimers();
    const { connection, fetched } = fakeConnection(null);

    const pending = parseTransaction(connection, 'sig', programLogs(BYREAL, ['ClosePosition']), TARGET);
    await vi.runAllTimersAsync();

    expect(await pending).toEqual([{ type: 'UNKNOWN' }]);
    expect(fetched).toHaveLength(3);
  });

  it('routes a TX touching both Byreal and Orca through the Byreal parser only', async () => {
    const held = [nftBalance(1, NFT_MINT, TARGET)];
    const { connection } = fakeConnection(
      makeTx({
        instructions: [
          // open_position discriminator — would classify as ORCA_OPEN_POSITION on its own.
          ix(ORCA, byrealOpenAccounts({ token22: true }), discData('87802f4d0f98f031')),
          ix(BYREAL, byrealOpenAccounts({ token22: true })),
        ],
        pre: held,
        post: held,
      }),
    );

    const events = await parseTransaction(
      connection,
      'sig',
      [...programLogs(ORCA), ...programLogs(BYREAL, ['IncreaseLiquidityV2'])],
      TARGET,
    );

    expect(events).toEqual([{ type: 'BYREAL_INCREASE_LIQUIDITY', positionNftMint: NFT_MINT.toBase58() }]);
  });

  it('attributes the shared close_position discriminator to DAMM v2 by program id', async () => {
    // 7b86510031446262 appears in ORCA_IX_DISC, METEORA_IX_DISC and DAMMV2_IX_DISC;
    // only the instruction's program id distinguishes them.
    const { connection } = fakeConnection(
      makeTx({
        instructions: [ix(DAMMV2, [addr(300), NFT_MINT, addr(301), POOL], discData('7b86510031446262'))],
        pre: [nftBalance(1, NFT_MINT, TARGET), tokenBalance(2, MINT_A, TARGET, '100', 6)],
        post: [tokenBalance(2, MINT_A, TARGET, '1100', 6)],
      }),
    );

    const events = await parseTransaction(connection, 'sig', programLogs(DAMMV2), TARGET);

    expect(events).toEqual([
      {
        type: 'DAMMV2_CLOSE_POSITION',
        positionNftMint: NFT_MINT.toBase58(),
        receivedTokens: [{ mint: MINT_A.toBase58(), amount: '1000' }],
      },
    ]);
  });
});

describe('parseTransaction — swap detection from balance deltas', () => {
  it('classifies one token down and another up as a swap', async () => {
    const { connection } = fakeConnection(
      makeTx({
        pre: [tokenBalance(1, MINT_A, TARGET, '1000000000', 6)],
        post: [
          tokenBalance(1, MINT_A, TARGET, '400000000', 6),
          tokenBalance(2, MINT_B, TARGET, '250000000', 9),
        ],
      }),
    );

    const events = await parseTransaction(connection, 'sig', programLogs(FOREIGN_PROGRAM.toBase58()), TARGET);

    expect(events).toEqual([
      {
        type: 'JUPITER_SWAP',
        inputMint: MINT_A.toBase58(),
        outputMint: MINT_B.toBase58(),
        inputAmount: '600.000000',
        outputAmount: '0.250000000',
        inputDecimals: 6,
        outputDecimals: 9,
        inputAmountRaw: '600000000',
        inputPreBalanceRaw: '1000000000',
      },
    ]);
  });

  it('ignores balance changes belonging to another wallet', async () => {
    const { connection } = fakeConnection(
      makeTx({
        pre: [tokenBalance(1, MINT_A, OTHER_WALLET, '1000000000', 6)],
        post: [
          tokenBalance(1, MINT_A, OTHER_WALLET, '400000000', 6),
          tokenBalance(2, MINT_B, OTHER_WALLET, '250000000', 9),
        ],
      }),
    );

    const events = await parseTransaction(connection, 'sig', programLogs(FOREIGN_PROGRAM.toBase58()), TARGET);

    expect(events).toEqual([{ type: 'UNKNOWN' }]);
  });

  it('rejects an NFT moving out as if it were the swap input', async () => {
    const { connection } = fakeConnection(
      makeTx({
        pre: [nftBalance(1, NFT_MINT, TARGET), tokenBalance(2, MINT_B, TARGET, '0', 9)],
        post: [nftBalance(1, NFT_MINT, TARGET, false), tokenBalance(2, MINT_B, TARGET, '250000000', 9)],
      }),
    );

    const events = await parseTransaction(connection, 'sig', programLogs(FOREIGN_PROGRAM.toBase58()), TARGET);

    expect(events).toEqual([{ type: 'UNKNOWN' }]);
  });

  it('rejects a SOL to WSOL wrap', async () => {
    const { connection } = fakeConnection(
      makeTx({
        accountKeys: [TARGET],
        preBalances: [2_000_000_000],
        postBalances: [900_000_000],
        post: [tokenBalance(1, WSOL, TARGET, '1000000000', 9)],
      }),
    );

    const events = await parseTransaction(connection, 'sig', programLogs(FOREIGN_PROGRAM.toBase58()), TARGET);

    expect(events).toEqual([{ type: 'UNKNOWN' }]);
  });
});
