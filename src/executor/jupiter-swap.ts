import { ComputeBudgetProgram, Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import BN from 'bn.js';
import { Chain, IPoolLayoutWithId } from 'byreal-clmm-sdk-alpha';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getUserAddress, signerCallback, signVersioned } from '../utils/wallet';
import { scaleNumericAmount } from '../utils/ratio';
import { jupiterFetch } from '../utils/jupiter-api';

const MODULE = 'JupSwap';

/** Last error message from swapForToken / swapViaByrealPool (for notification context) */
export let lastSwapError = '';

// Jupiter Holdings balance cache: mint → { rawAmount, fetchedAt }
let holdingsCache: { data: Record<string, bigint>; fetchedAt: number } | null = null;
const HOLDINGS_CACHE_MS = 30_000; // 30s — fresh enough for swap checks

async function getInputBalance(inputMint: string): Promise<bigint | null> {
  // Return from cache if fresh
  if (holdingsCache && Date.now() - holdingsCache.fetchedAt < HOLDINGS_CACHE_MS) {
    return holdingsCache.data[inputMint] ?? 0n;
  }
  try {
    const address = getUserAddress().toBase58();
    const res = await fetch(`https://api.jup.ag/ultra/v1/holdings/${address}`, {
      headers: config.jupApiKey ? { 'x-api-key': config.jupApiKey } : {},
    });
    if (!res.ok) return null;
    const json = (await res.json()) as any;
    const balances: Record<string, bigint> = {};
    if (json.tokens && typeof json.tokens === 'object') {
      for (const [mint, accounts] of Object.entries(json.tokens)) {
        if (!Array.isArray(accounts)) continue;
        let total = 0n;
        for (const acc of accounts as any[]) {
          if (acc.amount) total += BigInt(acc.amount);
        }
        balances[mint] = total;
      }
    }
    holdingsCache = { data: balances, fetchedAt: Date.now() };
    return balances[inputMint] ?? 0n;
  } catch {
    return null; // fail open — let TX try
  }
}

/** Invalidate holdings cache (call after successful swap) */
export function invalidateHoldingsCache(): void {
  holdingsCache = null;
}

interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  routePlan: unknown[];
  slippageBps: number;
  otherAmountThreshold: string;
}

interface JupiterSwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
}

type JupiterCompiledInstruction = VersionedTransaction['message']['compiledInstructions'][number];

export interface StripJupiterComputeUnitPriceResult {
  removed: number;
}

export function getJupiterComputeBudgetInstructionType(
  tx: VersionedTransaction,
  ix: JupiterCompiledInstruction,
): number | null {
  const programId = tx.message.staticAccountKeys[ix.programIdIndex];
  if (!programId?.equals(ComputeBudgetProgram.programId)) return null;
  return ix.data[0] ?? null;
}

export function stripJupiterComputeUnitPrice(
  tx: VersionedTransaction,
): StripJupiterComputeUnitPriceResult {
  let removed = 0;
  (tx.message as any).compiledInstructions = tx.message.compiledInstructions.filter((ix) => {
    const instructionType = getJupiterComputeBudgetInstructionType(tx, ix);
    if (instructionType === 3) {
      removed++;
      return false;
    }
    return true;
  });
  return { removed };
}

function logJupiterPriorityStrip(context: string, removed: number): void {
  if (removed > 0) {
    logger.info(MODULE, `${context}: removed ${removed} Jupiter compute-unit price instruction(s)`);
  } else {
    logger.info(MODULE, `${context}: no Jupiter compute-unit price instruction found`);
  }
}

/**
 * Execute a Jupiter swap mirroring target's swap.
 */
export async function executeJupiterSwap(
  connection: Connection,
  inputMint: string,
  outputMint: string,
  inputAmountUi: string,
  inputDecimals: number,
): Promise<string | null> {
  // Convert UI amount to raw amount
  const rawAmount = Math.floor(parseFloat(inputAmountUi) * Math.pow(10, inputDecimals));
  const scaledAmount = scaleNumericAmount(rawAmount);

  if (scaledAmount <= 0) {
    logger.warn(MODULE, 'Scaled amount is 0, skipping swap');
    return null;
  }

  logger.info(MODULE, `Swap: ${inputMint.slice(0, 8)}... -> ${outputMint.slice(0, 8)}...`, {
    inputAmount: inputAmountUi,
    rawAmount: scaledAmount.toString(),
  });

  if (config.dryRun) {
    logger.info(MODULE, '[DRY RUN] Would execute Jupiter swap', {
      inputMint,
      outputMint,
      amount: scaledAmount.toString(),
    });
    return 'dry-run-jupiter-swap';
  }

  return jupSwapExactIn(connection, inputMint, outputMint, scaledAmount.toString());
}

/**
 * Swap tokens via Jupiter ExactIn.
 * Probe quote to discover rate → calculate input → swap.
 * Returns txSig on success, null on failure.
 */
export async function swapForToken(
  connection: Connection,
  inputMint: string,
  outputMint: string,
  outputAmountRaw: string,
): Promise<string | null> {
  lastSwapError = '';
  logger.info(MODULE, `Jupiter swap: ${inputMint.slice(0, 8)}... -> ${outputMint.slice(0, 8)}...`, {
    desiredOutput: outputAmountRaw,
  });

  if (config.dryRun) {
    logger.info(MODULE, '[DRY RUN] Would swap for token', {
      inputMint,
      outputMint,
      outputAmountRaw,
    });
    return 'dry-run-swap';
  }

  // Step 1: Probe quote to discover exchange rate (1 USDC reference)
  const probeParams = new URLSearchParams({
    inputMint,
    outputMint,
    amount: '1000000',
    slippageBps: config.slippageBps.toString(),
    maxAccounts: '64',
  });

  let probeQuote: JupiterQuoteResponse;
  try {
    const probeRes = await jupiterFetch(`${config.jupiterApiBase}/quote?${probeParams}`);
    if (!probeRes.ok) {
      throw new Error(`Probe quote ${probeRes.status}: ${await probeRes.text()}`);
    }
    const data = (await probeRes.json()) as any;
    if (data.error || data.errorCode) {
      throw new Error(data.errorCode || data.error);
    }
    probeQuote = data as JupiterQuoteResponse;
  } catch (err: any) {
    logger.error(MODULE, `Jupiter probe failed: ${err.message}`);
    lastSwapError = `Jupiter probe: ${err.message}`;
    return null;
  }

  // Step 2: Calculate input amount
  const probeIn = BigInt(probeQuote.inAmount);
  const probeOut = BigInt(probeQuote.outAmount);
  if (probeOut === 0n) {
    logger.error(MODULE, 'Jupiter probe returned 0 output');
    return null;
  }

  const desiredOutput = BigInt(outputAmountRaw);
  const neededInput = (desiredOutput * probeIn) / probeOut;

  logger.info(
    MODULE,
    `Rate: ${probeIn}in/${probeOut}out, swapping ${neededInput} input for ~${desiredOutput} output`,
  );

  // Step 3: Real quote with calculated input
  const quoteParams = new URLSearchParams({
    inputMint,
    outputMint,
    amount: neededInput.toString(),
    slippageBps: config.slippageBps.toString(),
    maxAccounts: '64',
  });

  let quote: JupiterQuoteResponse;
  try {
    const quoteRes = await jupiterFetch(`${config.jupiterApiBase}/quote?${quoteParams}`);
    if (!quoteRes.ok) {
      throw new Error(`Quote ${quoteRes.status}: ${await quoteRes.text()}`);
    }
    const data = (await quoteRes.json()) as any;
    if (data.error || data.errorCode) {
      throw new Error(data.errorCode || data.error);
    }
    quote = data as JupiterQuoteResponse;
  } catch (err: any) {
    logger.error(MODULE, `Jupiter quote failed: ${err.message}`);
    lastSwapError = `Jupiter quote: ${err.message}`;
    return null;
  }

  logger.info(
    MODULE,
    `Quote: in=${quote.inAmount} -> out=${quote.outAmount} (target ${outputAmountRaw})`,
  );

  // Step 3b: Check input token balance before sending TX
  const inputBalance = await getInputBalance(inputMint);
  if (inputBalance !== null && inputBalance < BigInt(quote.inAmount)) {
    const decimals =
      inputMint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
        ? 6
        : inputMint === 'Es9vMFrzaCERmKfrE1SBVYuL9sSMdCL3DscMVPR1YnG5'
          ? 6
          : inputMint === 'So11111111111111111111111111111111111111112'
            ? 9
            : 6;
    const need = (Number(BigInt(quote.inAmount)) / 10 ** decimals).toFixed(4);
    const have = (Number(inputBalance) / 10 ** decimals).toFixed(4);
    logger.warn(
      MODULE,
      `Insufficient input balance: need ${need}, have ${have} (${inputMint.slice(0, 8)})`,
    );
    lastSwapError = `餘額不足 (需要 ${need}, 只有 ${have})`;
    return null;
  }

  // Step 4: Swap via unified helper (Metis or Ultra based on config)
  return jupSwapExactIn(connection, inputMint, outputMint, neededInput.toString());
}

/**
 * Unified Jupiter swap — supports both Metis and Ultra modes.
 * Metis: quote → swap → sign → send (user sends TX)
 * Ultra: order → sign → execute (Jupiter sends TX, better landing rate)
 */
export async function jupSwapExactIn(
  connection: Connection,
  inputMint: string,
  outputMint: string,
  amount: string,
): Promise<string | null> {
  if (config.jupSwapMode === 'ultra') {
    return ultraSwap(inputMint, outputMint, amount);
  }
  return metisSwap(connection, inputMint, outputMint, amount);
}

async function metisSwap(
  connection: Connection,
  inputMint: string,
  outputMint: string,
  amount: string,
): Promise<string | null> {
  const quoteParams = new URLSearchParams({
    inputMint,
    outputMint,
    amount,
    slippageBps: config.slippageBps.toString(),
    maxAccounts: '64',
  });

  let quote: JupiterQuoteResponse;
  try {
    const quoteRes = await jupiterFetch(`${config.jupiterApiBase}/quote?${quoteParams}`);
    if (!quoteRes.ok) throw new Error(`Quote ${quoteRes.status}: ${await quoteRes.text()}`);
    const data = (await quoteRes.json()) as any;
    if (data.error || data.errorCode) throw new Error(data.errorCode || data.error);
    quote = data as JupiterQuoteResponse;
  } catch (err: any) {
    logger.warn(MODULE, `Metis quote failed: ${err.message}`);
    lastSwapError = `Metis quote: ${err.message}`;
    return null;
  }

  logger.info(MODULE, `Metis quote: ${amount} → ${quote.outAmount}`);
  return buildAndSendMetis(connection, quote);
}

async function buildAndSendMetis(
  connection: Connection,
  quote: JupiterQuoteResponse,
): Promise<string | null> {
  let swapData: JupiterSwapResponse;
  try {
    const swapRes = await jupiterFetch(`${config.jupiterApiBase}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: getUserAddress().toBase58(),
        dynamicComputeUnitLimit: true,
      }),
    });
    if (!swapRes.ok) throw new Error(`Swap API ${swapRes.status}: ${await swapRes.text()}`);
    swapData = (await swapRes.json()) as JupiterSwapResponse;
  } catch (err: any) {
    logger.error(MODULE, `Metis swap build failed: ${err.message}`);
    lastSwapError = `Metis build: ${err.message}`;
    return null;
  }

  try {
    const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    const stripResult = stripJupiterComputeUnitPrice(tx);
    logJupiterPriorityStrip('Metis swap', stripResult.removed);
    const signed = await signVersioned(tx);
    const txSig = await sendWithRetry(connection, signed);
    logger.info(MODULE, `Metis swap done: ${txSig}`);
    invalidateHoldingsCache();
    return txSig;
  } catch (err: any) {
    logger.error(MODULE, `Metis swap send failed: ${err.message}`);
    lastSwapError = `Metis send: ${err.message}`;
    return null;
  }
}

async function ultraSwap(
  inputMint: string,
  outputMint: string,
  amount: string,
): Promise<string | null> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.jupApiKey) headers['x-api-key'] = config.jupApiKey;

  // Step 1: Order
  const orderParams = new URLSearchParams({
    inputMint,
    outputMint,
    amount,
    taker: getUserAddress().toBase58(),
  });

  let order: any;
  try {
    const res = await fetch(`https://api.jup.ag/ultra/v1/order?${orderParams}`, { headers });
    if (!res.ok) throw new Error(`Order ${res.status}: ${await res.text()}`);
    order = await res.json();
    if (!order.transaction || !order.requestId) {
      throw new Error(`Invalid order: ${JSON.stringify(order).slice(0, 200)}`);
    }
  } catch (err: any) {
    logger.warn(MODULE, `Ultra order failed: ${err.message}`);
    lastSwapError = `Ultra order: ${err.message}`;
    return null;
  }

  logger.info(MODULE, `Ultra order: requestId=${order.requestId}`);

  // Step 2: Sign
  try {
    const txBuf = Buffer.from(order.transaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    const stripResult = stripJupiterComputeUnitPrice(tx);
    logJupiterPriorityStrip('Ultra swap', stripResult.removed);
    const signed = await signVersioned(tx);
    const signedTx = Buffer.from(signed.serialize()).toString('base64');

    // Step 3: Execute (Jupiter sends the TX)
    const execRes = await fetch('https://api.jup.ag/ultra/v1/execute', {
      method: 'POST',
      headers,
      body: JSON.stringify({ signedTransaction: signedTx, requestId: order.requestId }),
    });
    if (!execRes.ok) throw new Error(`Execute ${execRes.status}: ${await execRes.text()}`);

    const result = (await execRes.json()) as any;
    if (result.status === 'Success' && result.signature) {
      logger.info(MODULE, `Ultra swap done: ${result.signature}`);
      invalidateHoldingsCache();
      return result.signature;
    }
    throw new Error(`Execute status: ${result.status || result.error || 'unknown'}`);
  } catch (err: any) {
    logger.warn(MODULE, `Ultra swap failed: ${err.message}`);
    lastSwapError = `Ultra exec: ${err.message}`;
    return null;
  }
}

/**
 * Swap via Byreal CLMM pool directly.
 * Fallback when Jupiter has no route (e.g., MNT token only exists on Byreal).
 * Returns txSig on success, null on failure.
 */
export async function swapViaByrealPool(
  chain: Chain,
  poolInfo: IPoolLayoutWithId,
  inputMint: PublicKey,
  outputMint: PublicKey,
  outputAmountRaw: string,
): Promise<string | null> {
  logger.info(
    MODULE,
    `Byreal pool swap: ${inputMint.toBase58().slice(0, 8)}... -> ${outputMint.toBase58().slice(0, 8)}...`,
    {
      desiredOutput: outputAmountRaw,
    },
  );

  if (config.dryRun) {
    logger.info(MODULE, '[DRY RUN] Would swap via Byreal pool', { outputAmountRaw });
    return 'dry-run-byreal-swap';
  }

  try {
    const quoteReturn = await chain.quoteSwapExactOut({
      poolInfo,
      outputTokenMint: outputMint,
      amountOut: new BN(outputAmountRaw),
      slippage: config.slippageBps / 10000,
    });

    if (!quoteReturn.allTrade) {
      logger.warn(MODULE, 'Byreal pool: insufficient liquidity for full swap');
    }

    logger.info(
      MODULE,
      `Byreal quote: need ${quoteReturn.maxAmountIn.toString()} input for ${quoteReturn.amountOut.toString()} output`,
    );

    // Fix SDK bug: executionPrice (post-swap sqrt price) causes 0x177d SqrtPriceLimitOverflow
    // when pool price moves between quote and TX landing. Use safe boundary instead.
    const zeroForOne = !quoteReturn.isOutputMintA;
    quoteReturn.executionPrice = zeroForOne
      ? new BN('4295048017') // MIN_SQRT_PRICE_X64 + 1
      : new BN('79226673521066979257578248090'); // MAX_SQRT_PRICE_X64 - 1

    const txSig = await chain.swapExactOut({
      poolInfo,
      quoteReturn,
      userAddress: getUserAddress(),
      signerCallback,
    });

    logger.info(MODULE, `Byreal pool swap done: ${txSig}`);
    return txSig;
  } catch (err: any) {
    logger.error(MODULE, `Byreal pool swap failed: ${err.message}`);
    lastSwapError = `Byreal pool: ${err.message}`;
    return null;
  }
}

/**
 * Parse a confirmed swap TX to get the actual output amount received.
 * Reads preTokenBalances / postTokenBalances from the TX metadata.
 */
export async function getActualSwapOutput(
  connection: Connection,
  txSig: string,
  outputMint: string,
  walletAddress: string,
): Promise<string | null> {
  // Retry up to 3 times — RPC may not have indexed the TX yet
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 3000 * attempt));
      }
      const txInfo = await connection.getParsedTransaction(txSig, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (!txInfo?.meta) {
        if (attempt < 2) {
          logger.debug(
            MODULE,
            `getActualSwapOutput: TX not indexed yet ${txSig.slice(0, 8)}, retry ${attempt + 1}/3`,
          );
          continue;
        }
        return null;
      }

      const pre = txInfo.meta.preTokenBalances || [];
      const post = txInfo.meta.postTokenBalances || [];

      const preBal = pre.find((b) => b.mint === outputMint && b.owner === walletAddress);
      const postBal = post.find((b) => b.mint === outputMint && b.owner === walletAddress);

      const preAmount = BigInt(preBal?.uiTokenAmount?.amount || '0');
      const postAmount = BigInt(postBal?.uiTokenAmount?.amount || '0');

      if (postAmount <= preAmount) return null;
      return (postAmount - preAmount).toString();
    } catch (err: any) {
      if (attempt < 2) {
        logger.debug(MODULE, `getActualSwapOutput error attempt ${attempt + 1}: ${err.message}`);
        continue;
      }
      logger.warn(MODULE, `Failed to parse TX ${txSig.slice(0, 8)}: ${err.message}`);
      return null;
    }
  }
  return null;
}

async function sendWithRetry(connection: Connection, tx: VersionedTransaction): Promise<string> {
  for (let i = 0; i < config.maxRetry; i++) {
    try {
      const sig = await connection.sendTransaction(tx, {
        skipPreflight: config.skipPreflight,
        maxRetries: 2,
      });
      // Wait for confirmation
      const latestBlockhash = await connection.getLatestBlockhash();
      await connection.confirmTransaction(
        {
          signature: sig,
          ...latestBlockhash,
        },
        'confirmed',
      );
      // Verify the transaction actually succeeded (confirmTransaction doesn't check meta.err)
      const txResult = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
      if (txResult?.meta?.err) {
        throw new Error(`TX confirmed but failed on-chain: ${JSON.stringify(txResult.meta.err)}`);
      }
      return sig;
    } catch (err: any) {
      if (i === config.maxRetry - 1) throw err;
      logger.warn(MODULE, `Send attempt ${i + 1} failed: ${err.message}, retrying...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw new Error('All retries exhausted');
}
