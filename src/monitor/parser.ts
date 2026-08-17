import {
  Connection,
  ParsedTransactionWithMeta,
  PartiallyDecodedInstruction,
  PublicKey,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from '../config';
import { logger } from '../utils/logger';

const MODULE = 'Parser';

// Orca Whirlpool instruction discriminators (Anchor sha256("global:<name>")[:8])
// Pinocchio migration removed Anchor-style "Instruction:" logs for most ops.
const ORCA_IX_DISC: Record<string, string> = {
  '2e9cf3760dcdfbb2': 'increase_liquidity',
  '851d59df45eeb00a': 'increase_liquidity_v2',
  a026d06f685b2c01: 'decrease_liquidity',
  '3a7fbc3e4f52c460': 'decrease_liquidity_v2',
  a498cf631eba13b6: 'collect_fees',
  cf755fbfe5b4e20f: 'collect_fees_v2',
  '87802f4d0f98f031': 'open_position',
  f21d86303a6e0e3c: 'open_position_with_metadata',
  d42f5f5c726683fa: 'open_position_with_token_extensions',
  '7b86510031446262': 'close_position',
};

// Meteora DAMM v2 program ID
const DAMMV2_PROGRAM_ID = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';

// Meteora DAMM v2 instruction discriminators (Anchor sha256("global:<name>")[:8])
const DAMMV2_IX_DISC: Record<string, string> = {
  '30d7c59960cbb485': 'create_position',
  b59d59438fb63448: 'add_liquidity',
  '5055d14818ceb16c': 'remove_liquidity',
  '0a333d2370691855': 'remove_all_liquidity',
  '7b86510031446262': 'close_position',
  b4269a118521a2d3: 'claim_position_fee',
  '955fb5f25e5a9ea2': 'claim_reward',
};

// Meteora DLMM instruction discriminators (Anchor sha256("global:<name>")[:8])
const METEORA_IX_DISC: Record<string, string> = {
  // Open Position (4)
  dbc0ea47bebf6650: 'initialize_position',
  '8f13f291d50f6873': 'initialize_position2',
  '2e527d92558de499': 'initialize_position_pda',
  fbbdbef475fe2394: 'initialize_position_by_operator',

  // Close Position (3)
  '7b86510031446262': 'close_position', // Same discriminator as Orca — differentiated by program ID
  ae5a2373ba2893e2: 'close_position2',
  '3b7cd4765b986e9d': 'close_position_if_empty',

  // Add Liquidity (9)
  b59d59438fb63448: 'add_liquidity',
  e4a24e1c46db7473: 'add_liquidity2',
  '0703967f94283dc8': 'add_liquidity_by_strategy',
  '03dd95da6f8d76d5': 'add_liquidity_by_strategy2',
  '2905eeaf64e106cd': 'add_liquidity_by_strategy_one_side',
  '1c8cee63e7a21595': 'add_liquidity_by_weight',
  '5e9b6797465fdca5': 'add_liquidity_one_side',
  a1c26754ab47fa9a: 'add_liquidity_one_side_precise',
  '2133a3c975627de7': 'add_liquidity_one_side_precise2',

  // Remove Liquidity (5)
  '5055d14818ceb16c': 'remove_liquidity',
  e6d7527ff165e392: 'remove_liquidity2',
  '1a526698f04a691a': 'remove_liquidity_by_range',
  cc02c391359191cd: 'remove_liquidity_by_range2',
  '0a333d2370691855': 'remove_all_liquidity',

  // Claim Fees (2)
  a9204f8988e84689: 'claim_fee',
  '70bf65ab1c907fbb': 'claim_fee2',

  // Rebalance (Phase 2 — log only, not handled)
  '5c04b0c177b95309': 'rebalance_liquidity',
};

/** Extract discriminator hex (first 8 bytes) from bs58-encoded instruction data. */
function getIxDiscriminator(data: string): string {
  try {
    const bytes = bs58.decode(data);
    if (bytes.length < 8) return '';
    return Buffer.from(bytes.slice(0, 8)).toString('hex');
  } catch {
    return '';
  }
}

export type ParsedEvent =
  | {
      type: 'JUPITER_SWAP';
      inputMint: string;
      outputMint: string;
      inputAmount: string;
      outputAmount: string;
      inputDecimals: number;
      outputDecimals: number;
      inputAmountRaw: string;
      inputPreBalanceRaw: string;
    }
  | {
      type: 'BYREAL_OPEN_POSITION';
      poolId: string;
      tickLower: number;
      tickUpper: number;
      liquidity: string;
      refererPosition: string | null;
      tokenAmountA: string;
      tokenAmountB: string;
      positionNftMint: string;
      poolMints?: string;
    }
  | { type: 'BYREAL_INCREASE_LIQUIDITY'; positionNftMint: string }
  | { type: 'BYREAL_DECREASE_LIQUIDITY'; positionNftMint: string; liquidity: string }
  | {
      type: 'BYREAL_CLOSE_POSITION';
      positionNftMint: string;
      receivedTokens: { mint: string; amount: string }[];
    }
  | { type: 'BYREAL_COLLECT_FEES'; positionNftMint: string }
  | {
      type: 'ORCA_OPEN_POSITION';
      poolAddress: string;
      tickLower: number;
      tickUpper: number;
      positionNftMint: string;
      poolMints?: string;
    }
  | {
      type: 'ORCA_CLOSE_POSITION';
      positionNftMint: string;
      receivedTokens: { mint: string; amount: string }[];
    }
  | { type: 'ORCA_INCREASE_LIQUIDITY'; positionNftMint: string }
  | { type: 'ORCA_DECREASE_LIQUIDITY'; positionNftMint: string }
  | {
      type: 'METEORA_OPEN_POSITION';
      poolAddress: string;
      lowerBinId: number;
      width: number;
      positionAddress: string;
    }
  | {
      type: 'METEORA_CLOSE_POSITION';
      positionAddress: string;
      receivedTokens: { mint: string; amount: string }[];
    }
  | { type: 'METEORA_ADD_LIQUIDITY'; positionAddress: string }
  | { type: 'METEORA_REMOVE_LIQUIDITY'; positionAddress: string }
  | {
      type: 'PCS_OPEN_POSITION';
      poolId: string;
      tickLower: number;
      tickUpper: number;
      liquidity: string;
      refererPosition: string | null;
      tokenAmountA: string;
      tokenAmountB: string;
      positionNftMint: string;
      poolMints?: string;
    }
  | { type: 'PCS_INCREASE_LIQUIDITY'; positionNftMint: string }
  | { type: 'PCS_DECREASE_LIQUIDITY'; positionNftMint: string; liquidity: string }
  | {
      type: 'PCS_CLOSE_POSITION';
      positionNftMint: string;
      receivedTokens: { mint: string; amount: string }[];
    }
  | { type: 'PCS_COLLECT_FEES'; positionNftMint: string }
  | { type: 'DAMMV2_OPEN_POSITION'; poolAddress: string; positionNftMint: string }
  | {
      type: 'DAMMV2_CLOSE_POSITION';
      positionNftMint: string;
      receivedTokens: { mint: string; amount: string }[];
    }
  | { type: 'DAMMV2_ADD_LIQUIDITY'; positionNftMint: string }
  | { type: 'DAMMV2_REMOVE_LIQUIDITY'; positionNftMint: string }
  | { type: 'DAMMV2_CLAIM_FEE'; positionNftMint: string }
  | { type: 'UNKNOWN' };

/**
 * Fetch full transaction and parse it into a structured event.
 */
export async function parseTransaction(
  connection: Connection,
  signature: string,
  logs: string[],
  targetWallet: PublicKey,
): Promise<ParsedEvent[]> {
  const events: ParsedEvent[] = [];

  // Quick check from logs: does this TX involve Byreal, Orca, or Meteora?
  const involvesByreal = logs.some((l) => l.includes(config.byrealProgramId.toBase58()));
  const involvesOrca = logs.some((l) => l.includes(config.orcaProgramId.toBase58()));
  const involvesMeteora = logs.some((l) => l.includes(config.meteoraProgramId.toBase58()));
  const involvesPcs =
    config.pcsEnabled && logs.some((l) => l.includes(config.pcsProgramId.toBase58()));
  const involvesDammv2 = logs.some((l) => l.includes(DAMMV2_PROGRAM_ID));
  const involvesMemo = logs.some((l) => l.includes(config.memoProgramId.toBase58()));

  // Spam filter: mass SOL-transfer TXs show many "Program 11111111111111111111111111111111 success" lines.
  // Skip early — no need to fetch the full TX.
  if (!involvesByreal && !involvesOrca && !involvesMeteora && !involvesPcs && !involvesDammv2) {
    const SYSTEM_PROGRAM_SUCCESS = 'Program 11111111111111111111111111111111 success';
    const systemSuccessCount = logs.filter((l) => l === SYSTEM_PROGRAM_SUCCESS).length;
    const hasComputeBudget = logs.some((l) =>
      l.includes('Program ComputeBudget111111111111111111111111111111 invoke'),
    );
    if (systemSuccessCount >= 5 && !hasComputeBudget) {
      logger.debug(
        MODULE,
        `Spam TX skipped (${systemSuccessCount}x system-program, no compute budget): ${signature.slice(0, 8)}`,
      );
      return [{ type: 'UNKNOWN' }];
    }
  }

  // Fetch full parsed TX with retries
  let tx: ParsedTransactionWithMeta | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      if (tx) break;
      // TX not propagated yet, wait before retry
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    } catch {
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }

  if (!tx) {
    logger.warn(MODULE, `Could not fetch TX: ${signature}`);
    return [{ type: 'UNKNOWN' }];
  }

  // Skip failed/reverted TXs
  if (tx.meta?.err) {
    return [{ type: 'UNKNOWN' }];
  }

  // Parse Byreal operations from logs
  if (involvesByreal) {
    const byrealEvents = parseByrealOperations(tx, logs, involvesMemo, targetWallet);
    events.push(...byrealEvents);
  }

  // Parse Orca Whirlpool operations from logs
  if (involvesOrca && !involvesByreal) {
    const orcaEvents = parseOrcaOperations(tx, logs, targetWallet);
    events.push(...orcaEvents);
  }

  // Parse Meteora DLMM operations from instruction discriminators
  if (involvesMeteora && !involvesByreal && !involvesOrca) {
    const meteoraEvents = parseMeteoraOperations(tx, logs, targetWallet);
    events.push(...meteoraEvents);
  }

  // Parse PancakeSwap CLMM operations (Raydium fork — same Anchor log detection as Byreal)
  if (involvesPcs && !involvesByreal && !involvesOrca && !involvesMeteora) {
    const pcsEvents = parsePcsOperations(tx, logs, involvesMemo, targetWallet);
    events.push(...pcsEvents);
  }

  // Parse Meteora DAMM v2 operations from instruction discriminators
  // Check program ID to differentiate from Meteora DLMM (overlapping discriminators)
  if (involvesDammv2 && !involvesByreal && !involvesOrca) {
    const dammv2Events = parseDammv2Operations(tx, logs, targetWallet);
    events.push(...dammv2Events);
  }

  // Parse swap from token balance changes (supports Jupiter Ultra all routers: Iris, JupiterZ, DFlow, OKX)
  // Detect by balance pattern (one token down + one token up) instead of program ID
  // Run AFTER DEX parsers: only emit JUPITER_SWAP if no LP events were found
  // (swap TX may route through Orca/Meteora AMM without being an LP operation)
  if (!involvesByreal && events.length === 0) {
    const jupEvent = parseJupiterSwap(tx, logs, targetWallet);
    if (jupEvent) events.push(jupEvent);
  }

  return events.length > 0 ? events : [{ type: 'UNKNOWN' }];
}

/**
 * Parse Jupiter swap by analyzing pre/post token balances.
 */
function parseJupiterSwap(
  tx: ParsedTransactionWithMeta,
  logs: string[],
  targetWallet: PublicKey,
): ParsedEvent | null {
  const preBalances = tx.meta?.preTokenBalances || [];
  const postBalances = tx.meta?.postTokenBalances || [];
  const targetStr = targetWallet.toBase58();

  // Find token balances that changed for target
  const changes: Map<
    string,
    { pre: number; post: number; decimals: number; preRaw: string; postRaw: string }
  > = new Map();

  for (const bal of preBalances) {
    if (bal.owner === targetStr && bal.mint) {
      changes.set(bal.mint, {
        pre: parseFloat(bal.uiTokenAmount.uiAmountString || '0'),
        post: 0,
        decimals: bal.uiTokenAmount.decimals,
        preRaw: bal.uiTokenAmount.amount,
        postRaw: '0',
      });
    }
  }

  for (const bal of postBalances) {
    if (bal.owner === targetStr && bal.mint) {
      const existing = changes.get(bal.mint) || {
        pre: 0,
        post: 0,
        decimals: bal.uiTokenAmount.decimals,
        preRaw: '0',
        postRaw: '0',
      };
      existing.post = parseFloat(bal.uiTokenAmount.uiAmountString || '0');
      existing.postRaw = bal.uiTokenAmount.amount;
      changes.set(bal.mint, existing);
    }
  }

  // Find which token decreased (input) and which increased (output)
  let inputMint = '';
  let outputMint = '';
  let inputAmount = '0';
  let outputAmount = '0';
  let inputDecimals = 9;
  let outputDecimals = 9;
  let inputAmountRaw = '0';
  let inputPreBalanceRaw = '0';

  for (const [mint, { pre, post, decimals, preRaw, postRaw }] of changes) {
    const diff = post - pre;
    if (diff < -0.000001) {
      inputMint = mint;
      inputAmount = Math.abs(diff).toFixed(decimals);
      inputDecimals = decimals;
      inputPreBalanceRaw = preRaw;
      // Raw diff = pre - post (absolute decrease)
      const rawDiff = BigInt(preRaw) - BigInt(postRaw);
      inputAmountRaw = (rawDiff > 0n ? rawDiff : -rawDiff).toString();
    } else if (diff > 0.000001) {
      outputMint = mint;
      outputAmount = diff.toFixed(decimals);
      outputDecimals = decimals;
    }
  }

  // Also check SOL balance change (native) — use target wallet's index, not hardcoded [0]
  const solPre = tx.meta?.preBalances;
  const solPost = tx.meta?.postBalances;
  const txFee = (tx.meta?.fee || 5000) / 1e9;
  const targetIdx = tx.transaction.message.accountKeys.findIndex(
    (k) => k.pubkey.toBase58() === targetStr,
  );
  if (solPre && solPost && targetIdx >= 0) {
    const solDiff = (solPost[targetIdx] - solPre[targetIdx]) / 1e9;
    // Compensate for TX fee: if target is fee payer (index 0), subtract fee from decrease
    const feeAdj = targetIdx === 0 ? txFee : 0;
    if (solDiff < -0.01 && !inputMint) {
      inputMint = 'So11111111111111111111111111111111111111112';
      inputAmount = Math.abs(solDiff + feeAdj).toFixed(9);
      inputDecimals = 9;
    } else if (solDiff > 0.01 && !outputMint) {
      outputMint = 'So11111111111111111111111111111111111111112';
      outputAmount = solDiff.toFixed(9);
      outputDecimals = 9;
    }
  }

  if (inputMint && outputMint) {
    // Safety: filter out WSOL wrap/unwrap (SOL <-> WSOL is not a real swap)
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    if (inputMint === SOL_MINT && outputMint === SOL_MINT) return null;

    // Safety: filter out NFT transfers (decimals=0 + amount ≤ 1 = NFT, not fungible token)
    const inputAmt = parseFloat(inputAmount);
    const outputAmt = parseFloat(outputAmount);
    if ((inputDecimals === 0 && inputAmt <= 1) || (outputDecimals === 0 && outputAmt <= 1))
      return null;

    return {
      type: 'JUPITER_SWAP',
      inputMint,
      outputMint,
      inputAmount,
      outputAmount,
      inputDecimals,
      outputDecimals,
      inputAmountRaw,
      inputPreBalanceRaw,
    };
  }

  return null;
}

/**
 * Parse Byreal CLMM operations from transaction logs.
 */
function parseByrealOperations(
  tx: ParsedTransactionWithMeta,
  logs: string[],
  hasMemo: boolean,
  targetWallet: PublicKey,
): ParsedEvent[] {
  const events: ParsedEvent[] = [];

  // Detect operation type from logs
  // Anchor programs emit: "Program log: Instruction: <PascalCaseName>"
  // IDL has: OpenPosition (legacy), OpenPositionV2 (deprecated), OpenPositionWithToken22Nft (current)
  // Note: "OpenPosition" substring also matches V2 and Token22Nft variants
  const hasOpenPosition = logs.some(
    (l) =>
      l.includes('Instruction: OpenPosition') ||
      l.includes('Instruction: OpenPositionV2') ||
      l.includes('Instruction: OpenPositionWithToken22Nft'),
  );
  // Detect Token22 variant specifically (different account layout)
  const isToken22Position = logs.some((l) => l.includes('Instruction: OpenPositionWithToken22Nft'));
  const hasDecreaseLiquidity = logs.some(
    (l) =>
      l.includes('Instruction: DecreaseLiquidity') ||
      l.includes('Instruction: DecreaseLiquidityV2'),
  );
  const hasIncreaseLiquidity = logs.some(
    (l) =>
      l.includes('Instruction: IncreaseLiquidity') ||
      l.includes('Instruction: IncreaseLiquidityV2'),
  );
  const hasClosePosition = logs.some((l) => l.includes('Instruction: ClosePosition'));
  // Note: collectFees in SDK = DecreaseLiquidity with 0 amount.
  // We don't need to mirror it — our own fee collector handles this on schedule.

  // Extract referer_position from Memo
  let refererPosition: string | null = null;
  if (hasMemo) {
    for (const log of logs) {
      // Memo logs appear as: "Program log: Memo (len N): \"referer_position=<address>\""
      const memoMatch = log.match(/referer_position=([A-Za-z0-9]+)/);
      if (memoMatch) {
        refererPosition = memoMatch[1];
        break;
      }
    }
  }

  if (hasOpenPosition) {
    const openEvents = parseOpenPositions(tx, refererPosition, isToken22Position, targetWallet);
    events.push(...openEvents);
  }

  // IncreaseLiquidity = adding more to an existing position (not opening new)
  if (hasIncreaseLiquidity && !hasOpenPosition) {
    const increaseEvents = parseIncreaseLiquidity(tx, targetWallet);
    events.push(...increaseEvents);
  }

  if ((hasDecreaseLiquidity && !hasOpenPosition) || hasClosePosition) {
    const decreaseCloseEvents = parseDecreaseOrClose(tx, hasClosePosition, targetWallet);
    events.push(...decreaseCloseEvents);
  }

  return events;
}

/**
 * Collect all Byreal instructions from a TX (top-level + inner).
 * Handles multi-instruction TXs (BUG #6 fix).
 */
function findAllByrealInstructions(tx: ParsedTransactionWithMeta): PartiallyDecodedInstruction[] {
  const byrealStr = config.byrealProgramId.toBase58();
  const results: PartiallyDecodedInstruction[] = [];

  for (const ix of tx.transaction.message.instructions) {
    if ('programId' in ix && ix.programId.toBase58() === byrealStr) {
      results.push(ix as PartiallyDecodedInstruction);
    }
  }

  // Also check inner instructions
  for (const inner of tx.meta?.innerInstructions || []) {
    for (const ix of inner.instructions) {
      if ('programId' in ix && ix.programId.toBase58() === byrealStr) {
        results.push(ix as PartiallyDecodedInstruction);
      }
    }
  }

  return results;
}

/**
 * Find NFT mint from TX by looking at token balance changes.
 * New NFT mints appear as a new token with amount=1 and decimals=0 in postTokenBalances.
 * This is more reliable than guessing account layout indices.
 */
function findNewNftMintsFromTx(tx: ParsedTransactionWithMeta, targetWallet: PublicKey): string[] {
  const postBalances = tx.meta?.postTokenBalances || [];
  const preBalances = tx.meta?.preTokenBalances || [];
  const targetStr = targetWallet.toBase58();

  const nftMints: string[] = [];

  for (const post of postBalances) {
    if (post.owner !== targetStr) continue;
    // NFT = decimals 0, amount 1
    if (post.uiTokenAmount.decimals === 0 && post.uiTokenAmount.uiAmount === 1) {
      // Check it didn't exist in pre-balances (newly minted)
      const existed = preBalances.some(
        (pre) => pre.accountIndex === post.accountIndex && pre.mint === post.mint,
      );
      if (!existed) {
        nftMints.push(post.mint);
      }
    }
  }

  return nftMints;
}

/**
 * Find NFT mints that were burned/closed in this TX.
 * These appear in preTokenBalances but not in postTokenBalances (or amount goes to 0).
 */
function findClosedNftMintsFromTx(
  tx: ParsedTransactionWithMeta,
  targetWallet: PublicKey,
): string[] {
  const preBalances = tx.meta?.preTokenBalances || [];
  const postBalances = tx.meta?.postTokenBalances || [];
  const targetStr = targetWallet.toBase58();

  const closedMints: string[] = [];

  for (const pre of preBalances) {
    if (pre.owner !== targetStr) continue;
    // NFT = decimals 0, amount 1
    if (pre.uiTokenAmount.decimals === 0 && pre.uiTokenAmount.uiAmount === 1) {
      // Check if it's gone or zeroed in post
      const post = postBalances.find(
        (p) => p.accountIndex === pre.accountIndex && p.mint === pre.mint,
      );
      if (!post || post.uiTokenAmount.uiAmount === 0) {
        closedMints.push(pre.mint);
      }
    }
  }

  return closedMints;
}

/**
 * Parse OpenPosition events. Returns all open events (supports multi-instruction TX).
 */
function parseOpenPositions(
  tx: ParsedTransactionWithMeta,
  refererPosition: string | null,
  isToken22: boolean,
  targetWallet: PublicKey,
): ParsedEvent[] {
  const byrealIxs = findAllByrealInstructions(tx);
  const nftMints = findNewNftMintsFromTx(tx, targetWallet);

  // Each new NFT mint = one new position
  const events: ParsedEvent[] = [];

  // Account layout differs by instruction variant:
  // Token22 (openPositionWithToken22Nft): [0]payer [1]nftOwner [2]nftMint [3]nftAccount [4]poolState ... [18]vault0Mint [19]vault1Mint
  // V2 (openPositionV2):                 [0]payer [1]nftOwner [2]nftMint [3]nftAccount [4]metadataAccount [5]poolState ... [20]vault0Mint [21]vault1Mint
  // Legacy (openPosition):               [0]payer [1]nftOwner [2]nftMint [3]nftAccount [4]metadataAccount [5]poolState ... (no vault mints)
  const poolStateIdx = isToken22 ? 4 : 5;
  const mintAIdx = isToken22 ? 18 : 20;
  const mintBIdx = isToken22 ? 19 : 21;
  const minAccounts = poolStateIdx + 1;
  const minAccountsForMints = mintBIdx + 1;

  for (let i = 0; i < nftMints.length; i++) {
    let poolId = '';
    let poolMints: string | undefined;
    for (const ix of byrealIxs) {
      const accounts = ix.accounts || [];
      // Match: instruction's nftMint (index 2) == this nft
      if (accounts.length >= minAccounts && accounts[2].toBase58() === nftMints[i]) {
        poolId = accounts[poolStateIdx].toBase58();
        // Extract vault0Mint (mintA) and vault1Mint (mintB) if available (V2 / Token22 only)
        if (accounts.length >= minAccountsForMints) {
          const mintA = accounts[mintAIdx].toBase58();
          const mintB = accounts[mintBIdx].toBase58();
          poolMints = `${mintA}/${mintB}`;
        }
        break;
      }
    }
    // If can't match by nftMint, use first instruction's pool
    if (!poolId && byrealIxs.length > 0) {
      const accounts = byrealIxs[0].accounts || [];
      poolId = accounts.length >= minAccounts ? accounts[poolStateIdx].toBase58() : '';
      if (!poolMints && accounts.length >= minAccountsForMints) {
        const mintA = accounts[mintAIdx].toBase58();
        const mintB = accounts[mintBIdx].toBase58();
        poolMints = `${mintA}/${mintB}`;
      }
    }

    events.push({
      type: 'BYREAL_OPEN_POSITION',
      poolId,
      tickLower: 0, // Will be fetched on-chain via getPositionInfoByNftMint
      tickUpper: 0,
      liquidity: '0',
      refererPosition,
      tokenAmountA: '0',
      tokenAmountB: '0',
      positionNftMint: nftMints[i],
      poolMints,
    });
  }

  return events;
}

/**
 * Parse IncreaseLiquidity events.
 * Detect which existing position NFT was targeted by checking target's held NFTs.
 */
function parseIncreaseLiquidity(
  tx: ParsedTransactionWithMeta,
  targetWallet: PublicKey,
): ParsedEvent[] {
  const preBalances = tx.meta?.preTokenBalances || [];
  const targetStr = targetWallet.toBase58();
  const events: ParsedEvent[] = [];

  // Find NFT mints target holds (existing positions)
  for (const pre of preBalances) {
    if (pre.owner !== targetStr) continue;
    if (pre.uiTokenAmount.decimals === 0 && pre.uiTokenAmount.uiAmount === 1) {
      events.push({
        type: 'BYREAL_INCREASE_LIQUIDITY',
        positionNftMint: pre.mint,
      });
      break; // Typically one increase per TX
    }
  }

  return events;
}

/**
 * Parse Decrease/Close events using NFT balance changes (BUG #1 fix).
 * Instead of guessing account layout indices, we detect which NFT positions
 * were burned (closed) or are still present but had liquidity removed.
 */
function parseDecreaseOrClose(
  tx: ParsedTransactionWithMeta,
  hasClosePosition: boolean,
  targetWallet: PublicKey,
): ParsedEvent[] {
  const events: ParsedEvent[] = [];

  // NFTs that disappeared = close position
  const closedNfts = findClosedNftMintsFromTx(tx, targetWallet);
  // Parse bot's received token amounts from balance changes
  const receivedTokens = parseBotReceivedTokens(tx, targetWallet);
  for (const nft of closedNfts) {
    events.push({
      type: 'BYREAL_CLOSE_POSITION',
      positionNftMint: nft,
      receivedTokens,
    });
  }

  // If DecreaseLiquidity but NFT still exists = partial decrease
  // We detect by: Byreal instruction present, but no NFT was burned
  if (closedNfts.length === 0 && !hasClosePosition) {
    // Find NFT mints target currently holds (from preTokenBalances, decimals=0, amount=1)
    const preBalances = tx.meta?.preTokenBalances || [];
    const targetStr = targetWallet.toBase58();

    for (const pre of preBalances) {
      if (pre.owner !== targetStr) continue;
      if (pre.uiTokenAmount.decimals === 0 && pre.uiTokenAmount.uiAmount === 1) {
        events.push({
          type: 'BYREAL_DECREASE_LIQUIDITY',
          positionNftMint: pre.mint,
          liquidity: '0',
        });
        break; // Only one decrease per TX typically
      }
    }
  }

  return events;
}

/**
 * Parse bot's received token amounts from close TX balance changes.
 * Returns non-NFT tokens where balance increased (= tokens received from closing position).
 */
function parseBotReceivedTokens(
  tx: ParsedTransactionWithMeta,
  targetWallet: PublicKey,
): { mint: string; amount: string }[] {
  const preBalances = tx.meta?.preTokenBalances || [];
  const postBalances = tx.meta?.postTokenBalances || [];
  const botStr = targetWallet.toBase58();
  const received: { mint: string; amount: string }[] = [];

  // Build pre-balance map: mint → raw amount string
  const preMap = new Map<string, string>();
  for (const pre of preBalances) {
    if (pre.owner === botStr && pre.uiTokenAmount.decimals > 0) {
      preMap.set(pre.mint, pre.uiTokenAmount.amount);
    }
  }

  // Compare post - pre for each token
  for (const post of postBalances) {
    if (post.owner !== botStr) continue;
    if (post.uiTokenAmount.decimals === 0) continue; // Skip NFTs

    const postAmt = BigInt(post.uiTokenAmount.amount);
    const preAmt = BigInt(preMap.get(post.mint) || '0');
    const diff = postAmt - preAmt;

    if (diff > 0n) {
      received.push({
        mint: post.mint,
        amount: diff.toString(),
      });
    }
  }

  return received;
}

/**
 * Collect all Orca Whirlpool instructions from a TX (top-level + inner).
 */
function findAllOrcaInstructions(tx: ParsedTransactionWithMeta): PartiallyDecodedInstruction[] {
  const orcaStr = config.orcaProgramId.toBase58();
  const results: PartiallyDecodedInstruction[] = [];

  for (const ix of tx.transaction.message.instructions) {
    if ('programId' in ix && ix.programId.toBase58() === orcaStr) {
      results.push(ix as PartiallyDecodedInstruction);
    }
  }

  for (const inner of tx.meta?.innerInstructions || []) {
    for (const ix of inner.instructions) {
      if ('programId' in ix && ix.programId.toBase58() === orcaStr) {
        results.push(ix as PartiallyDecodedInstruction);
      }
    }
  }

  return results;
}

/**
 * Parse Orca Whirlpool operations using instruction data discriminators.
 * Orca migrated to Pinocchio — most instructions no longer emit "Instruction:" logs.
 * We identify operations by the first 8 bytes of instruction data instead.
 */
function parseOrcaOperations(
  tx: ParsedTransactionWithMeta,
  _logs: string[],
  targetWallet: PublicKey,
): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  const orcaIxs = findAllOrcaInstructions(tx);

  // Classify Orca instructions by discriminator
  let hasOpenPosition = false;
  let hasClosePosition = false;
  let hasIncreaseLiquidity = false;
  let hasDecreaseLiquidity = false;
  let hasCollectFees = false;

  for (const ix of orcaIxs) {
    const disc = getIxDiscriminator(ix.data);
    const name = ORCA_IX_DISC[disc];
    if (!name) continue;

    if (name.startsWith('open_position')) hasOpenPosition = true;
    else if (name === 'close_position') hasClosePosition = true;
    else if (name.startsWith('increase_liquidity')) hasIncreaseLiquidity = true;
    else if (name.startsWith('decrease_liquidity')) hasDecreaseLiquidity = true;
    else if (name.startsWith('collect_fees')) hasCollectFees = true;
  }

  if (hasOpenPosition) {
    const openEvents = parseOrcaOpenPositions(tx, targetWallet);
    events.push(...openEvents);
  }

  if (hasIncreaseLiquidity && !hasOpenPosition) {
    const increaseEvents = parseOrcaIncreaseLiquidity(tx, targetWallet);
    events.push(...increaseEvents);
  }

  if ((hasDecreaseLiquidity && !hasOpenPosition) || hasClosePosition) {
    const decreaseCloseEvents = parseOrcaDecreaseOrClose(tx, hasClosePosition, targetWallet);
    events.push(...decreaseCloseEvents);
  }

  // collectFees alone (no decrease/close) — treat as decrease for fee collection
  if (
    hasCollectFees &&
    !hasDecreaseLiquidity &&
    !hasClosePosition &&
    !hasOpenPosition &&
    !hasIncreaseLiquidity
  ) {
    const feeEvents = parseOrcaDecreaseOrClose(tx, false, targetWallet);
    events.push(...feeEvents);
  }

  return events;
}

/**
 * Parse Orca OpenPosition events.
 * Orca Whirlpool account layouts:
 *   OpenPosition:                    [0]funder [1]owner [2]position [3]positionMint [4]positionTokenAccount [5]whirlpool ...
 *   OpenPositionWithTokenExtensions: [0]funder [1]owner [2]position [3]positionMint [4]positionTokenAccount [5]whirlpool ...
 * whirlpool (pool) is at index 5 in both variants.
 */
function parseOrcaOpenPositions(
  tx: ParsedTransactionWithMeta,
  targetWallet: PublicKey,
): ParsedEvent[] {
  const orcaIxs = findAllOrcaInstructions(tx);
  const nftMints = findNewNftMintsFromTx(tx, targetWallet);
  const events: ParsedEvent[] = [];

  const POOL_IDX = 5;
  const NFT_MINT_IDX = 3;

  for (const nft of nftMints) {
    let poolAddress = '';

    // Match instruction by NFT mint at index 3
    for (const ix of orcaIxs) {
      const accounts = ix.accounts || [];
      if (accounts.length > POOL_IDX && accounts[NFT_MINT_IDX].toBase58() === nft) {
        poolAddress = accounts[POOL_IDX].toBase58();
        break;
      }
    }

    // Fallback: use first Orca instruction's pool
    if (!poolAddress && orcaIxs.length > 0) {
      const accounts = orcaIxs[0].accounts || [];
      if (accounts.length > POOL_IDX) {
        poolAddress = accounts[POOL_IDX].toBase58();
      }
    }

    events.push({
      type: 'ORCA_OPEN_POSITION',
      poolAddress,
      tickLower: 0, // Will be fetched on-chain via Orca SDK
      tickUpper: 0,
      positionNftMint: nft,
    });
  }

  return events;
}

/**
 * Parse Orca IncreaseLiquidity events.
 */
function parseOrcaIncreaseLiquidity(
  tx: ParsedTransactionWithMeta,
  targetWallet: PublicKey,
): ParsedEvent[] {
  const preBalances = tx.meta?.preTokenBalances || [];
  const targetStr = targetWallet.toBase58();
  const events: ParsedEvent[] = [];

  for (const pre of preBalances) {
    if (pre.owner !== targetStr) continue;
    if (pre.uiTokenAmount.decimals === 0 && pre.uiTokenAmount.uiAmount === 1) {
      events.push({
        type: 'ORCA_INCREASE_LIQUIDITY',
        positionNftMint: pre.mint,
      });
      break;
    }
  }

  return events;
}

/**
 * Parse Orca Decrease/Close events.
 */
function parseOrcaDecreaseOrClose(
  tx: ParsedTransactionWithMeta,
  hasClosePosition: boolean,
  targetWallet: PublicKey,
): ParsedEvent[] {
  const events: ParsedEvent[] = [];

  const closedNfts = findClosedNftMintsFromTx(tx, targetWallet);
  const receivedTokens = parseBotReceivedTokens(tx, targetWallet);

  for (const nft of closedNfts) {
    events.push({
      type: 'ORCA_CLOSE_POSITION',
      positionNftMint: nft,
      receivedTokens,
    });
  }

  // Partial decrease: NFT still exists
  if (closedNfts.length === 0 && !hasClosePosition) {
    const preBalances = tx.meta?.preTokenBalances || [];
    const targetStr = targetWallet.toBase58();

    for (const pre of preBalances) {
      if (pre.owner !== targetStr) continue;
      if (pre.uiTokenAmount.decimals === 0 && pre.uiTokenAmount.uiAmount === 1) {
        events.push({
          type: 'ORCA_DECREASE_LIQUIDITY',
          positionNftMint: pre.mint,
        });
        break;
      }
    }
  }

  return events;
}

/**
 * Collect all Meteora DLMM instructions from a TX (top-level + inner).
 */
function findAllMeteoraInstructions(tx: ParsedTransactionWithMeta): PartiallyDecodedInstruction[] {
  const meteoraStr = config.meteoraProgramId.toBase58();
  const results: PartiallyDecodedInstruction[] = [];

  for (const ix of tx.transaction.message.instructions) {
    if ('programId' in ix && ix.programId.toBase58() === meteoraStr) {
      results.push(ix as PartiallyDecodedInstruction);
    }
  }

  for (const inner of tx.meta?.innerInstructions || []) {
    for (const ix of inner.instructions) {
      if ('programId' in ix && ix.programId.toBase58() === meteoraStr) {
        results.push(ix as PartiallyDecodedInstruction);
      }
    }
  }

  return results;
}

/**
 * Parse Meteora DLMM operations using instruction data discriminators.
 */
function parseMeteoraOperations(
  tx: ParsedTransactionWithMeta,
  _logs: string[],
  targetWallet: PublicKey,
): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  const meteoraIxs = findAllMeteoraInstructions(tx);

  // Step 1: Classify all Meteora instructions by discriminator
  let hasInitPosition = false;
  let hasClosePosition = false;
  let hasAddLiquidity = false;
  let hasRemoveLiquidity = false;
  let hasClaimFee = false;
  let hasRebalance = false;

  for (const ix of meteoraIxs) {
    const disc = getIxDiscriminator(ix.data);
    const name = METEORA_IX_DISC[disc];
    if (!name) continue;

    if (name.startsWith('initialize_position')) hasInitPosition = true;
    else if (name.startsWith('close_position')) hasClosePosition = true;
    else if (name.startsWith('add_liquidity')) hasAddLiquidity = true;
    else if (name.startsWith('remove_liquidity') || name === 'remove_all_liquidity')
      hasRemoveLiquidity = true;
    else if (name.startsWith('claim_fee')) hasClaimFee = true;
    else if (name === 'rebalance_liquidity') hasRebalance = true;
  }

  // Step 2: Parse events (priority order matches Orca pattern)

  if (hasInitPosition) {
    events.push(...parseMeteoraOpenPositions(tx, meteoraIxs, targetWallet));
  }

  if (hasAddLiquidity && !hasInitPosition) {
    events.push(...parseMeteoraAddLiquidity(meteoraIxs, targetWallet));
  }

  if ((hasRemoveLiquidity && !hasInitPosition) || hasClosePosition) {
    events.push(...parseMeteoraRemoveOrClose(tx, meteoraIxs, hasClosePosition, targetWallet));
  }

  // claimFee alone (no remove/close) -> treat as remove event (same as Orca collect_fees logic)
  if (
    hasClaimFee &&
    !hasRemoveLiquidity &&
    !hasClosePosition &&
    !hasInitPosition &&
    !hasAddLiquidity
  ) {
    events.push(...parseMeteoraRemoveOrClose(tx, meteoraIxs, false, targetWallet));
  }

  // rebalance = remove + add in one instruction -> Phase 2 feature
  if (hasRebalance) {
    logger.debug(MODULE, 'Meteora rebalance detected — Phase 2 feature, ignoring');
  }

  return events;
}

/**
 * Parse Meteora OpenPosition events.
 * Reads position PDA + pool address + bin range from instruction accounts and data.
 */
function parseMeteoraOpenPositions(
  tx: ParsedTransactionWithMeta,
  meteoraIxs: PartiallyDecodedInstruction[],
  targetWallet: PublicKey,
): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  const targetStr = targetWallet.toBase58();

  for (const ix of meteoraIxs) {
    const disc = getIxDiscriminator(ix.data);
    const name = METEORA_IX_DISC[disc];
    if (!name || !name.startsWith('initialize_position')) continue;

    const accounts = ix.accounts || [];

    // Account index varies by instruction variant
    let payerIdx: number;
    let positionIdx: number;
    let poolIdx: number;

    if (name === 'initialize_position_pda') {
      // [0]payer [1]base [2]position [3]lb_pair ...
      payerIdx = 0;
      positionIdx = 2;
      poolIdx = 3;
    } else {
      // initialize_position / initialize_position2 / initialize_position_by_operator:
      // [0]payer [1]position [2]lb_pair ...
      payerIdx = 0;
      positionIdx = 1;
      poolIdx = 2;
    }

    if (accounts.length <= Math.max(positionIdx, poolIdx)) continue;

    // Verify payer is target wallet
    if (accounts[payerIdx].toBase58() !== targetStr) continue;

    const positionAddress = accounts[positionIdx].toBase58();
    const poolAddress = accounts[poolIdx].toBase58();

    // Parse instruction data for lower_bin_id and width
    // discriminator(8 bytes) + lower_bin_id(i32, 4 bytes) + width(i32, 4 bytes)
    let lowerBinId = 0;
    let width = 0;
    try {
      const dataBytes = bs58.decode(ix.data);
      if (dataBytes.length >= 16) {
        const buf = Buffer.from(dataBytes);
        lowerBinId = buf.readInt32LE(8);
        width = buf.readInt32LE(12);
      }
    } catch {
      /* use defaults */
    }

    events.push({
      type: 'METEORA_OPEN_POSITION',
      poolAddress,
      lowerBinId,
      width,
      positionAddress,
    });
  }

  return events;
}

/**
 * Parse Meteora AddLiquidity events. Deduplicates by position address.
 */
function parseMeteoraAddLiquidity(
  meteoraIxs: PartiallyDecodedInstruction[],
  targetWallet: PublicKey,
): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  const targetStr = targetWallet.toBase58();
  const seen = new Set<string>();

  for (const ix of meteoraIxs) {
    const disc = getIxDiscriminator(ix.data);
    const name = METEORA_IX_DISC[disc];
    if (!name || !name.startsWith('add_liquidity')) continue;

    const accounts = ix.accounts || [];
    if (accounts.length < 3) continue;

    // add_liquidity variants: [0]position [1]lb_pair [2]sender ...
    const positionAddress = accounts[0].toBase58();
    const sender = accounts[2].toBase58();

    if (sender !== targetStr) continue;
    if (seen.has(positionAddress)) continue;
    seen.add(positionAddress);

    events.push({
      type: 'METEORA_ADD_LIQUIDITY',
      positionAddress,
    });
  }

  return events;
}

/**
 * Parse Meteora Remove/Close events.
 * Close takes priority over remove. claim_fee2 has reversed account order.
 */
function parseMeteoraRemoveOrClose(
  tx: ParsedTransactionWithMeta,
  meteoraIxs: PartiallyDecodedInstruction[],
  hasClosePosition: boolean,
  targetWallet: PublicKey,
): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  const targetStr = targetWallet.toBase58();
  const closedPositions = new Set<string>();
  const removedPositions = new Set<string>();

  // First pass: find all close_position instructions
  for (const ix of meteoraIxs) {
    const disc = getIxDiscriminator(ix.data);
    const name = METEORA_IX_DISC[disc];
    if (!name || !name.startsWith('close_position')) continue;

    const accounts = ix.accounts || [];
    if (accounts.length < 3) continue;

    // close_position variants: [0]position [1]sender [2]lb_pair ...
    const positionAddress = accounts[0].toBase58();
    const sender = accounts[1].toBase58();

    if (sender !== targetStr) continue;
    closedPositions.add(positionAddress);
  }

  // close_position detected -> emit METEORA_CLOSE_POSITION
  if (closedPositions.size > 0) {
    const receivedTokens = parseBotReceivedTokens(tx, targetWallet);
    for (const posAddr of closedPositions) {
      events.push({
        type: 'METEORA_CLOSE_POSITION',
        positionAddress: posAddr,
        receivedTokens,
      });
    }
    return events; // Close takes priority, skip remove parsing
  }

  // No close -> find remove_liquidity as partial decrease
  for (const ix of meteoraIxs) {
    const disc = getIxDiscriminator(ix.data);
    const name = METEORA_IX_DISC[disc];
    if (!name) continue;
    if (!name.startsWith('remove_liquidity') && name !== 'remove_all_liquidity') continue;

    const accounts = ix.accounts || [];
    if (accounts.length < 3) continue;

    // remove_liquidity variants: [0]position [1]lb_pair [2]sender ...
    const positionAddress = accounts[0].toBase58();
    const sender = accounts[2].toBase58();

    if (sender !== targetStr) continue;
    if (removedPositions.has(positionAddress)) continue;
    removedPositions.add(positionAddress);

    events.push({
      type: 'METEORA_REMOVE_LIQUIDITY',
      positionAddress,
    });
  }

  // claimFee alone -> find sender's position from claim_fee instructions
  if (events.length === 0) {
    for (const ix of meteoraIxs) {
      const disc = getIxDiscriminator(ix.data);
      const name = METEORA_IX_DISC[disc];
      if (!name || !name.startsWith('claim_fee')) continue;

      const accounts = ix.accounts || [];
      let positionAddress: string;
      let sender: string;

      if (name === 'claim_fee2') {
        // claim_fee2: [0]lb_pair [1]position [2]sender ... (reversed order!)
        if (accounts.length < 3) continue;
        positionAddress = accounts[1].toBase58();
        sender = accounts[2].toBase58();
      } else {
        // claim_fee: [0]position [1]lb_pair [2]sender ...
        if (accounts.length < 3) continue;
        positionAddress = accounts[0].toBase58();
        sender = accounts[2].toBase58();
      }

      if (sender !== targetStr) continue;

      events.push({
        type: 'METEORA_REMOVE_LIQUIDITY', // Treat fee collection as decrease (same as Orca pattern)
        positionAddress,
      });
      break; // Only take the first
    }
  }

  return events;
}

// ===== PancakeSwap CLMM Parser (Raydium fork — identical Anchor log patterns as Byreal) =====

/**
 * Collect all PancakeSwap instructions from a TX (top-level + inner).
 */
function findAllPcsInstructions(tx: ParsedTransactionWithMeta): PartiallyDecodedInstruction[] {
  const pcsStr = config.pcsProgramId.toBase58();
  const results: PartiallyDecodedInstruction[] = [];

  for (const ix of tx.transaction.message.instructions) {
    if ('programId' in ix && ix.programId.toBase58() === pcsStr) {
      results.push(ix as PartiallyDecodedInstruction);
    }
  }

  for (const inner of tx.meta?.innerInstructions || []) {
    for (const ix of inner.instructions) {
      if ('programId' in ix && ix.programId.toBase58() === pcsStr) {
        results.push(ix as PartiallyDecodedInstruction);
      }
    }
  }

  return results;
}

/**
 * Parse PancakeSwap CLMM operations from transaction logs.
 * PCS is a Raydium CLMM fork — identical Anchor-style "Instruction:" log patterns.
 */
function parsePcsOperations(
  tx: ParsedTransactionWithMeta,
  logs: string[],
  hasMemo: boolean,
  targetWallet: PublicKey,
): ParsedEvent[] {
  const events: ParsedEvent[] = [];

  const hasOpenPosition = logs.some(
    (l) =>
      l.includes('Instruction: OpenPosition') ||
      l.includes('Instruction: OpenPositionV2') ||
      l.includes('Instruction: OpenPositionWithToken22Nft'),
  );
  const isToken22Position = logs.some((l) => l.includes('Instruction: OpenPositionWithToken22Nft'));
  const hasDecreaseLiquidity = logs.some(
    (l) =>
      l.includes('Instruction: DecreaseLiquidity') ||
      l.includes('Instruction: DecreaseLiquidityV2'),
  );
  const hasIncreaseLiquidity = logs.some(
    (l) =>
      l.includes('Instruction: IncreaseLiquidity') ||
      l.includes('Instruction: IncreaseLiquidityV2'),
  );
  const hasClosePosition = logs.some((l) => l.includes('Instruction: ClosePosition'));

  let refererPosition: string | null = null;
  if (hasMemo) {
    for (const log of logs) {
      const memoMatch = log.match(/referer_position=([A-Za-z0-9]+)/);
      if (memoMatch) {
        refererPosition = memoMatch[1];
        break;
      }
    }
  }

  if (hasOpenPosition) {
    events.push(...parsePcsOpenPositions(tx, refererPosition, isToken22Position, targetWallet));
  }

  if (hasIncreaseLiquidity && !hasOpenPosition) {
    events.push(...parsePcsIncreaseLiquidity(tx, targetWallet));
  }

  if ((hasDecreaseLiquidity && !hasOpenPosition) || hasClosePosition) {
    events.push(...parsePcsDecreaseOrClose(tx, hasClosePosition, targetWallet));
  }

  return events;
}

/**
 * Parse PCS OpenPosition events. Account layout identical to Byreal (Raydium fork).
 */
function parsePcsOpenPositions(
  tx: ParsedTransactionWithMeta,
  refererPosition: string | null,
  isToken22: boolean,
  targetWallet: PublicKey,
): ParsedEvent[] {
  const pcsIxs = findAllPcsInstructions(tx);
  const nftMints = findNewNftMintsFromTx(tx, targetWallet);
  const events: ParsedEvent[] = [];

  const poolStateIdx = isToken22 ? 4 : 5;
  const mintAIdx = isToken22 ? 18 : 20;
  const mintBIdx = isToken22 ? 19 : 21;
  const minAccounts = poolStateIdx + 1;
  const minAccountsForMints = mintBIdx + 1;

  for (let i = 0; i < nftMints.length; i++) {
    let poolId = '';
    let poolMints: string | undefined;
    for (const ix of pcsIxs) {
      const accounts = ix.accounts || [];
      if (accounts.length >= minAccounts && accounts[2].toBase58() === nftMints[i]) {
        poolId = accounts[poolStateIdx].toBase58();
        if (accounts.length >= minAccountsForMints) {
          poolMints = `${accounts[mintAIdx].toBase58()}/${accounts[mintBIdx].toBase58()}`;
        }
        break;
      }
    }
    if (!poolId && pcsIxs.length > 0) {
      const accounts = pcsIxs[0].accounts || [];
      poolId = accounts.length >= minAccounts ? accounts[poolStateIdx].toBase58() : '';
      if (!poolMints && accounts.length >= minAccountsForMints) {
        poolMints = `${accounts[mintAIdx].toBase58()}/${accounts[mintBIdx].toBase58()}`;
      }
    }

    events.push({
      type: 'PCS_OPEN_POSITION',
      poolId,
      tickLower: 0,
      tickUpper: 0,
      liquidity: '0',
      refererPosition,
      tokenAmountA: '0',
      tokenAmountB: '0',
      positionNftMint: nftMints[i],
      poolMints,
    });
  }

  return events;
}

function parsePcsIncreaseLiquidity(
  tx: ParsedTransactionWithMeta,
  targetWallet: PublicKey,
): ParsedEvent[] {
  const preBalances = tx.meta?.preTokenBalances || [];
  const targetStr = targetWallet.toBase58();
  const events: ParsedEvent[] = [];

  for (const pre of preBalances) {
    if (pre.owner !== targetStr) continue;
    if (pre.uiTokenAmount.decimals === 0 && pre.uiTokenAmount.uiAmount === 1) {
      events.push({ type: 'PCS_INCREASE_LIQUIDITY', positionNftMint: pre.mint });
      break;
    }
  }

  return events;
}

function parsePcsDecreaseOrClose(
  tx: ParsedTransactionWithMeta,
  hasClosePosition: boolean,
  targetWallet: PublicKey,
): ParsedEvent[] {
  const events: ParsedEvent[] = [];

  const closedNfts = findClosedNftMintsFromTx(tx, targetWallet);
  const receivedTokens = parseBotReceivedTokens(tx, targetWallet);
  for (const nft of closedNfts) {
    events.push({ type: 'PCS_CLOSE_POSITION', positionNftMint: nft, receivedTokens });
  }

  if (closedNfts.length === 0 && !hasClosePosition) {
    const preBalances = tx.meta?.preTokenBalances || [];
    const targetStr = targetWallet.toBase58();

    for (const pre of preBalances) {
      if (pre.owner !== targetStr) continue;
      if (pre.uiTokenAmount.decimals === 0 && pre.uiTokenAmount.uiAmount === 1) {
        events.push({ type: 'PCS_DECREASE_LIQUIDITY', positionNftMint: pre.mint, liquidity: '0' });
        break;
      }
    }
  }

  return events;
}

// ===== Meteora DAMM v2 Parser (NFT-based positions, like Orca) =====

/**
 * Collect all DAMM v2 instructions from a TX (top-level + inner).
 */
function findAllDammv2Instructions(tx: ParsedTransactionWithMeta): PartiallyDecodedInstruction[] {
  const results: PartiallyDecodedInstruction[] = [];

  for (const ix of tx.transaction.message.instructions) {
    if ('programId' in ix && ix.programId.toBase58() === DAMMV2_PROGRAM_ID) {
      results.push(ix as PartiallyDecodedInstruction);
    }
  }

  for (const inner of tx.meta?.innerInstructions || []) {
    for (const ix of inner.instructions) {
      if ('programId' in ix && ix.programId.toBase58() === DAMMV2_PROGRAM_ID) {
        results.push(ix as PartiallyDecodedInstruction);
      }
    }
  }

  return results;
}

/**
 * Parse Meteora DAMM v2 operations using instruction data discriminators.
 * DAMM v2 uses position NFT mints (Token-2022) like Orca, not position PDAs like Meteora DLMM.
 * Several discriminators overlap with Meteora DLMM — differentiated by program ID.
 */
function parseDammv2Operations(
  tx: ParsedTransactionWithMeta,
  _logs: string[],
  targetWallet: PublicKey,
): ParsedEvent[] {
  const events: ParsedEvent[] = [];
  const dammv2Ixs = findAllDammv2Instructions(tx);

  // Classify instructions by discriminator
  let hasCreatePosition = false;
  let hasClosePosition = false;
  let hasAddLiquidity = false;
  let hasRemoveLiquidity = false;
  let hasClaimFee = false;

  for (const ix of dammv2Ixs) {
    const disc = getIxDiscriminator(ix.data);
    const name = DAMMV2_IX_DISC[disc];
    if (!name) continue;

    if (name === 'create_position') hasCreatePosition = true;
    else if (name === 'close_position') hasClosePosition = true;
    else if (name === 'add_liquidity') hasAddLiquidity = true;
    else if (name === 'remove_liquidity' || name === 'remove_all_liquidity')
      hasRemoveLiquidity = true;
    else if (name === 'claim_position_fee') hasClaimFee = true;
  }

  if (hasCreatePosition) {
    events.push(...parseDammv2OpenPositions(tx, dammv2Ixs, targetWallet));
  }

  if (hasAddLiquidity && !hasCreatePosition) {
    events.push(...parseDammv2AddLiquidity(tx, targetWallet));
  }

  if ((hasRemoveLiquidity && !hasCreatePosition) || hasClosePosition) {
    events.push(...parseDammv2RemoveOrClose(tx, dammv2Ixs, hasClosePosition, targetWallet));
  }

  // claimFee alone (no remove/close) -> treat as remove event for fee collection (same as Orca pattern)
  if (
    hasClaimFee &&
    !hasRemoveLiquidity &&
    !hasClosePosition &&
    !hasCreatePosition &&
    !hasAddLiquidity
  ) {
    // Find NFT mint from pre-token-balances (position NFT held by target)
    const preBalances = tx.meta?.preTokenBalances || [];
    const targetStr = targetWallet.toBase58();

    for (const pre of preBalances) {
      if (pre.owner !== targetStr) continue;
      if (pre.uiTokenAmount.decimals === 0 && pre.uiTokenAmount.uiAmount === 1) {
        events.push({
          type: 'DAMMV2_CLAIM_FEE',
          positionNftMint: pre.mint,
        });
        break;
      }
    }
  }

  return events;
}

/**
 * Parse DAMM v2 create_position events.
 * Uses NFT mints (Token-2022) — find newly minted NFTs from token balance changes.
 * Pool address is at accounts[0] in the create_position instruction.
 */
function parseDammv2OpenPositions(
  tx: ParsedTransactionWithMeta,
  dammv2Ixs: PartiallyDecodedInstruction[],
  targetWallet: PublicKey,
): ParsedEvent[] {
  const nftMints = findNewNftMintsFromTx(tx, targetWallet);
  const events: ParsedEvent[] = [];

  for (const nft of nftMints) {
    let poolAddress = '';

    // Find the create_position instruction for this NFT
    for (const ix of dammv2Ixs) {
      const disc = getIxDiscriminator(ix.data);
      const name = DAMMV2_IX_DISC[disc];
      if (name !== 'create_position') continue;

      const accounts = ix.accounts || [];
      // create_position IDL: [0]=owner, [1]=positionNftMint, [2]=positionNftAccount, [3]=pool
      if (accounts.length > 3) {
        poolAddress = accounts[3].toBase58();
        break;
      }
    }

    events.push({
      type: 'DAMMV2_OPEN_POSITION',
      poolAddress,
      positionNftMint: nft,
    });
  }

  return events;
}

/**
 * Parse DAMM v2 add_liquidity events.
 * Find the position NFT from pre-token-balances (existing NFT held by target).
 */
function parseDammv2AddLiquidity(
  tx: ParsedTransactionWithMeta,
  targetWallet: PublicKey,
): ParsedEvent[] {
  const preBalances = tx.meta?.preTokenBalances || [];
  const targetStr = targetWallet.toBase58();
  const events: ParsedEvent[] = [];

  for (const pre of preBalances) {
    if (pre.owner !== targetStr) continue;
    if (pre.uiTokenAmount.decimals === 0 && pre.uiTokenAmount.uiAmount === 1) {
      events.push({
        type: 'DAMMV2_ADD_LIQUIDITY',
        positionNftMint: pre.mint,
      });
      break; // Typically one add per TX
    }
  }

  return events;
}

/**
 * Parse DAMM v2 remove/close events.
 * Close: NFT burned (disappeared from balance). Remove: NFT still exists.
 */
function parseDammv2RemoveOrClose(
  tx: ParsedTransactionWithMeta,
  _dammv2Ixs: PartiallyDecodedInstruction[],
  hasClosePosition: boolean,
  targetWallet: PublicKey,
): ParsedEvent[] {
  const events: ParsedEvent[] = [];

  const closedNfts = findClosedNftMintsFromTx(tx, targetWallet);
  const receivedTokens = parseBotReceivedTokens(tx, targetWallet);

  for (const nft of closedNfts) {
    events.push({
      type: 'DAMMV2_CLOSE_POSITION',
      positionNftMint: nft,
      receivedTokens,
    });
  }

  // Partial remove: NFT still exists
  if (closedNfts.length === 0 && !hasClosePosition) {
    const preBalances = tx.meta?.preTokenBalances || [];
    const targetStr = targetWallet.toBase58();

    for (const pre of preBalances) {
      if (pre.owner !== targetStr) continue;
      if (pre.uiTokenAmount.decimals === 0 && pre.uiTokenAmount.uiAmount === 1) {
        events.push({
          type: 'DAMMV2_REMOVE_LIQUIDITY',
          positionNftMint: pre.mint,
        });
        break;
      }
    }
  }

  return events;
}
