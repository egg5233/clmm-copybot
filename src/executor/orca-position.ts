import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import BN from 'bn.js';
import {
  WhirlpoolContext,
  buildWhirlpoolClient,
  PDAUtil,
  ORCA_WHIRLPOOL_PROGRAM_ID,
  decreaseLiquidityQuoteByLiquidity,
  TokenExtensionUtil,
} from '@orca-so/whirlpools-sdk';
import { collectFeesQuote } from '@orca-so/whirlpools-sdk/dist/quotes/public/collect-fees-quote';
import type { WhirlpoolClient, Whirlpool, Position } from '@orca-so/whirlpools-sdk';
import { Percentage } from '@orca-so/common-sdk';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getUserAddress, getWalletAdapter } from '../utils/wallet';
import { scaleAmount, getAmountRatio } from '../utils/ratio';
import { jupiterFetch } from '../utils/jupiter-api';
import { PositionMap } from '../state/position-map';
import { notifyOpenFailed, notifyCloseFailed, notifySolInsufficient, notifyPumpApproval, notifySwapFailed } from '../discord/notify';
import { isPumpPending, isPumpApproved, isPumpRejected, addPumpPending } from '../state/pump-pending';
import { swapForToken, getActualSwapOutput, lastSwapError, jupSwapExactIn } from './jupiter-swap';
import { checkTokenLiquidity } from '../monitor/pool-tvl';
import * as fs from 'fs';
import * as path from 'path';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmKfrE1SBVYuL9sSMdCL3DscMVPR1YnG5';
const USDT_T22 = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

const MODULE = 'OrcaPos';
const PENDING_FILE = './data/pending-swaps.json';

// Orca pool TVL cache: poolAddress → { tvlUsdc, fetchedAt }
const orcaTvlCache = new Map<string, { tvlUsdc: number; fetchedAt: number }>();
const ORCA_TVL_CACHE_MS = 10 * 60 * 1000; // 10 min

async function getOrcaPoolTvl(poolAddress: string): Promise<number | null> {
  const cached = orcaTvlCache.get(poolAddress);
  if (cached && Date.now() - cached.fetchedAt < ORCA_TVL_CACHE_MS) return cached.tvlUsdc;
  try {
    const res = await fetch(`https://api.orca.so/v2/solana/pools/${poolAddress}`);
    if (!res.ok) return cached?.tvlUsdc ?? null;
    const data = (await res.json()) as any;
    const tvl = parseFloat(data?.data?.tvlUsdc ?? data?.tvlUsdc ?? '0');
    orcaTvlCache.set(poolAddress, { tvlUsdc: tvl, fetchedAt: Date.now() });
    return tvl;
  } catch {
    return cached?.tvlUsdc ?? null;
  }
}

export class OrcaPositionExecutor {
  private ctx: WhirlpoolContext;
  private client: WhirlpoolClient;
  private readCtx: WhirlpoolContext;
  private readClient: WhirlpoolClient;
  private connection: Connection;
  private readConnection: Connection;
  private positionMap: PositionMap;
  private busy = false;
  private freeRpcIdx = 0;

  public solPaused = false;
  public solPausedAt: number | null = null;
  public drawdownPaused = false;
  public drawdownPausedAt: number | null = null;
  public lastSkipReason: string | null = null;
  public cachedSolBalance: number | null = null;

  /** Cached rent per position in SOL — queried from RPC at startup, fallback to 0.0074542 */
  public rentPerPosition: number = 0.0074542;

  constructor(connection: Connection, positionMap: PositionMap) {
    this.connection = connection;
    this.readConnection = config.readRpcUrl
      ? new Connection(config.readRpcUrl, { commitment: 'confirmed' })
      : connection;
    this.positionMap = positionMap;

    const wallet = getWalletAdapter();
    // Helius context for TX execution (buildAndExecute sends through this)
    this.ctx = WhirlpoolContext.from(this.connection, wallet);
    this.client = buildWhirlpoolClient(this.ctx);
    // Alchemy context for read-only queries (LP value calc, avoids Helius rate limits)
    this.readCtx = WhirlpoolContext.from(this.readConnection, wallet);
    this.readClient = buildWhirlpoolClient(this.readCtx);

    this.getSolBalance().then(b => { this.cachedSolBalance = b; }).catch(() => {});
    logger.info(MODULE, 'OrcaPositionExecutor initialized');
  }

  get isBusy(): boolean { return this.busy; }

  /** Get a WhirlpoolClient backed by a free RPC (round-robin). Used for dashboard reads only. */
  private getFreeClient(): { ctx: WhirlpoolContext; client: WhirlpoolClient } {
    const urls = config.rpcUrlsFree;
    if (urls.length === 0) return { ctx: this.readCtx, client: this.readClient };
    const url = urls[this.freeRpcIdx % urls.length];
    this.freeRpcIdx++;
    const conn = new Connection(url, { commitment: 'confirmed' });
    const wallet = getWalletAdapter();
    const ctx = WhirlpoolContext.from(conn, wallet);
    const client = buildWhirlpoolClient(ctx);
    return { ctx, client };
  }

  updateConnection(newConn: Connection): void {
    this.connection = newConn;
    // Recreate WhirlpoolContext with new connection (used for both reads and sends)
    const wallet = getWalletAdapter();
    this.ctx = WhirlpoolContext.from(newConn, wallet);
    this.client = buildWhirlpoolClient(this.ctx);
    logger.info(MODULE, 'Connection + WhirlpoolContext updated after reconnect');
  }

  // ===== Lock =====

  private acquire(caller: string): boolean {
    if (this.busy) {
      logger.warn(MODULE, `${caller}: executor busy, skipping`);
      return false;
    }
    this.busy = true;
    return true;
  }

  private release(): void {
    this.busy = false;
  }

  // ===== Helpers =====

  private async getSolBalance(): Promise<number> {
    const lamports = await this.readConnection.getBalance(getUserAddress());
    return lamports / 1e9;
  }

  private async getTokenBalance(owner: PublicKey, mint: PublicKey): Promise<BN> {
    const isWsol = mint.equals(NATIVE_MINT);
    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      try {
        const ata = getAssociatedTokenAddressSync(mint, owner, false, programId);
        const balance = await this.readConnection.getTokenAccountBalance(ata);
        const amount = new BN(balance.value.amount);
        if (isWsol) {
          const nativeLamports = await this.readConnection.getBalance(owner);
          const availableLamports = Math.max(0, nativeLamports - 50_000_000);
          return amount.add(new BN(availableLamports));
        }
        return amount;
      } catch {
        continue;
      }
    }
    if (isWsol) {
      const nativeLamports = await this.readConnection.getBalance(owner);
      return new BN(Math.max(0, nativeLamports - 50_000_000));
    }
    return new BN(0);
  }

  private getSlippage(): Percentage {
    return Percentage.fromFraction(config.slippageBps, 10_000);
  }

  private isTokenBlacklisted(mintA: string, mintB: string): boolean {
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    if (config.orcaSkipSol && (mintA === SOL_MINT || mintB === SOL_MINT)) return true;
    return config.tokenBlacklist.has(mintA) || config.tokenBlacklist.has(mintB);
  }

  private isTransientError(err: any): boolean {
    const msg = err?.message || '';
    return /502|503|504|429|ECONNRESET|ETIMEDOUT|ENOTFOUND|timeout|Too Many Requests|Internal server error|Blockhash not found|block height exceeded|has expired|PriceSlippageCheck|0x1785/i.test(msg);
  }

  private isRetryableSimError(err: any): boolean {
    const msg = err?.message || '';
    return /simulation failed|insufficient funds/i.test(msg) && !/insufficient lamports/i.test(msg);
  }

  private getTokenSymbol(mint: string): string {
    try {
      const raw = fs.readFileSync('./data/token-names.json', 'utf-8');
      const cache = JSON.parse(raw);
      return cache[mint]?.symbol || mint;
    } catch { return mint; }
  }

  private async getPositionByNft(nftMint: PublicKey): Promise<Position | null> {
    try {
      const positionPda = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, nftMint);
      return await this.client.getPosition(positionPda.publicKey);
    } catch {
      return null;
    }
  }

  /**
   * Verify a TX succeeded on-chain (meta.err === null).
   * Returns true if successful, false if failed or not found.
   */
  private async verifyTxSuccess(txSig: string): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) {
          await new Promise(r => setTimeout(r, 3000 * attempt));
        }
        const tx = await this.readConnection.getParsedTransaction(txSig, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });
        if (!tx?.meta) {
          if (attempt < 2) {
            logger.debug(MODULE, `verifyTxSuccess: TX not found yet ${txSig.slice(0, 8)}, retry ${attempt + 1}/3`);
            continue;
          }
          logger.warn(MODULE, `verifyTxSuccess: TX not found after retries ${txSig.slice(0, 8)}`);
          return false;
        }
        if (tx.meta.err) {
          logger.error(MODULE, `TX failed on-chain: ${txSig.slice(0, 8)} err=${JSON.stringify(tx.meta.err)}`);
          return false;
        }
        return true;
      } catch (err: any) {
        if (attempt < 2) {
          logger.debug(MODULE, `verifyTxSuccess error attempt ${attempt + 1}: ${err.message}`);
          continue;
        }
        logger.warn(MODULE, `verifyTxSuccess error: ${err.message}`);
        return false;
      }
    }
    return false;
  }

  /**
   * Parse a confirmed TX to extract token balance changes for our wallet.
   * Returns positive changes only (tokens we received).
   */
  private async parseTxTokenChanges(txSig: string, owner: PublicKey): Promise<{ mint: PublicKey; amount: BN }[]> {
    try {
      const tx = await this.readConnection.getParsedTransaction(txSig, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      if (!tx?.meta) return [];

      const ownerStr = owner.toBase58();
      const pre: Record<string, bigint> = {};
      const post: Record<string, bigint> = {};

      for (const b of tx.meta.preTokenBalances || []) {
        if (b.owner === ownerStr && b.mint) {
          pre[b.mint] = BigInt(b.uiTokenAmount.amount);
        }
      }
      for (const b of tx.meta.postTokenBalances || []) {
        if (b.owner === ownerStr && b.mint) {
          post[b.mint] = BigInt(b.uiTokenAmount.amount);
        }
      }

      const results: { mint: PublicKey; amount: BN }[] = [];
      const allMints = new Set([...Object.keys(pre), ...Object.keys(post)]);
      for (const mint of allMints) {
        const diff = (post[mint] ?? 0n) - (pre[mint] ?? 0n);
        if (diff > 0n) {
          results.push({ mint: new PublicKey(mint), amount: new BN(diff.toString()) });
        }
      }
      return results;
    } catch (err: any) {
      logger.warn(MODULE, `parseTxTokenChanges failed: ${err.message}`);
      return [];
    }
  }

  /** Add to shared pending-swaps.json (same file as Byreal executor). */
  private addPendingSwap(mint: PublicKey, amount: BN): void {
    const mintStr = mint.toBase58();
    if (mintStr === USDC || mintStr === USDT_MINT || mintStr === USDT_T22 || mint.equals(NATIVE_MINT)) return;
    if (amount.lte(new BN(0))) return;

    const data = this.readPendingFile();
    const entry = data[mintStr] || { pending: '0', botReceived: '0', createdAt: Date.now() };
    const existing = new BN(entry.pending);
    const total = existing.add(amount);
    data[mintStr] = { ...entry, pending: total.toString() };
    this.writePendingFile(data);
    logger.info(MODULE, `Pending swap queued: ${mintStr.slice(0, 8)}... amount=${amount.toString()} (total=${total.toString()})`);
  }

  /**
   * Swap back tokens acquired during a failed open position.
   * Only swaps non-stable, non-SOL tokens back to USDC.
   * Failures are logged but never throw.
   */
  private async swapBackOnFailure(swappedTokens: { mint: string; amount: BN }[]): Promise<void> {
    const SKIP = new Set([USDC, USDT_MINT, USDT_T22, NATIVE_MINT.toBase58()]);
    for (const { mint, amount } of swappedTokens) {
      if (SKIP.has(mint) || amount.lte(new BN(0))) continue;
      logger.info(MODULE, `[SWAP-BACK] Swapping ${amount.toString()} of ${mint} → USDC`);
      try {
        const sig = await jupSwapExactIn(this.connection, mint, USDC, amount.toString());
        if (sig) {
          logger.info(MODULE, `[SWAP-BACK] Success: ${mint} → USDC, tx=${sig}`);
        } else {
          logger.warn(MODULE, `[SWAP-BACK] Jupiter returned null for ${mint}, tokens remain in wallet`);
        }
      } catch (swapErr: any) {
        logger.warn(MODULE, `[SWAP-BACK] Failed for ${mint}: ${swapErr.message}`);
      }
    }
  }

  /**
   * Estimate how much inputMint (typically USDC) is needed to get outputAmount of outputMint.
   * Uses Jupiter probe quote. Returns null on failure (caller should skip pre-check, not block).
   */
  private async estimateSwapCost(inputMint: string, outputMint: string, outputAmount: BN): Promise<BN | null> {
    try {
      const probeParams = new URLSearchParams({
        inputMint,
        outputMint,
        amount: '1000000', // 1 USDC probe
        slippageBps: config.slippageBps.toString(),
      });
      const res = await jupiterFetch(`${config.jupiterApiBase}/quote?${probeParams}`);
      if (!res.ok) return null;
      const data = await res.json() as any;
      if (data.error || data.errorCode) return null;
      const probeIn = BigInt(data.inAmount);
      const probeOut = BigInt(data.outAmount);
      if (probeOut === 0n) return null;
      const needed = (BigInt(outputAmount.toString()) * probeIn) / probeOut;
      // Add 5% buffer for slippage
      const withBuffer = needed * 105n / 100n;
      return new BN(withBuffer.toString());
    } catch {
      return null;
    }
  }

  private readPendingFile(): Record<string, any> {
    try {
      if (!fs.existsSync(PENDING_FILE)) return {};
      return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf-8'));
    } catch {
      return {};
    }
  }

  private writePendingFile(data: Record<string, any>): void {
    try {
      const dir = path.dirname(PENDING_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(PENDING_FILE, JSON.stringify(data, null, 2));
    } catch (err: any) {
      logger.warn(MODULE, `writePendingFile failed: ${err.message}`);
    }
  }

  /**
   * Query rent exemption from RPC for the 3 accounts created per Orca Whirlpool position.
   * Mint (82 bytes) + Position PDA (216 bytes) + ATA (165 bytes).
   * TickArray init rent is variable and excluded (shared accounts).
   */
  async initRentPerPosition(): Promise<void> {
    try {
      const conn = this.readConnection;
      // Orca position accounts: NFT Mint (SPL Token, 82 bytes), Position (Whirlpool, 216 bytes), NFT ATA (SPL Token, 165 bytes)
      const [rentMint, rentPosition, rentATA] = await Promise.all([
        conn.getMinimumBalanceForRentExemption(82),
        conn.getMinimumBalanceForRentExemption(216),
        conn.getMinimumBalanceForRentExemption(165),
      ]);
      const totalLamports = rentMint + rentPosition + rentATA;
      this.rentPerPosition = totalLamports / 1e9;
      logger.info(MODULE, `Rent per position: ${this.rentPerPosition} SOL (${totalLamports} lamports = Mint:${rentMint} + Pos:${rentPosition} + ATA:${rentATA})`);
    } catch (err: any) {
      logger.warn(MODULE, `Failed to query rent exemption, using fallback ${this.rentPerPosition}: ${err.message}`);
    }
  }

  /** Backfill lockedSol for Orca positions opened before this feature. */
  backfillLockedSol(): void {
    const missing: string[] = [];
    for (const [targetNft, ourNft] of this.positionMap.entries()) {
      const dex = this.positionMap.getDex(targetNft);
      if (dex === 'orca' && this.positionMap.getLockedSol(targetNft, -1) === -1) {
        missing.push(targetNft);
      }
    }
    if (missing.length === 0) return;
    logger.info(MODULE, `Backfilling lockedSol for ${missing.length} Orca positions (${this.rentPerPosition} SOL each)`);
    for (const targetNft of missing) {
      this.positionMap.setLockedSol(targetNft, this.rentPerPosition);
    }
    logger.info(MODULE, `Backfill lockedSol complete: ${missing.length} Orca positions updated`);
  }

  // ===== Core Operations =====

  async copyOpenPosition(
    targetNftMint: string,
    poolAddress: string,
    targetWallet: string,
  ): Promise<string | null> {
    const userAddress = getUserAddress();

    if (this.positionMap.get(targetNftMint)) {
      logger.warn(MODULE, `Already have mapping for target NFT ${targetNftMint.slice(0, 8)}, skipping`);
      return null;
    }

    if (this.solPaused) {
      this.lastSkipReason = 'SOL 不足暫停';
      return null;
    }
    if (this.drawdownPaused) {
      this.lastSkipReason = '回撤保護暫停';
      return null;
    }

    // Check close-only
    if (config.orcaCloseOnlyWallets.has(targetWallet)) {
      logger.info(MODULE, `[OPEN] Skipped — wallet ${targetWallet.slice(0, 8)} is close-only`);
      this.lastSkipReason = 'Close-only 錢包';
      return null;
    }

    logger.info(MODULE, `Copying position: pool=${poolAddress.slice(0, 8)}...`, {
      targetNft: targetNftMint.slice(0, 8),
    });

    if (config.dryRun) {
      logger.info(MODULE, '[DRY RUN] Would copy open position', { poolAddress, targetNftMint });
      return 'dry-run-orca-open';
    }

    if (!this.acquire('copyOpenPosition')) return null;

    // Track tokens acquired via pre-swap — declared outside try so catch can access for swap-back
    const swappedTokens: { mint: string; amount: BN }[] = [];

    try {
      // 1. Read target position (retry — freshly opened positions may not be on-chain yet)
      let targetPosition = await this.getPositionByNft(new PublicKey(targetNftMint));
      if (!targetPosition) {
        for (let wait = 1; wait <= 3; wait++) {
          logger.info(MODULE, `Target position not found yet, waiting ${wait * 2}s (attempt ${wait}/3)...`);
          await new Promise(r => setTimeout(r, wait * 2000));
          targetPosition = await this.getPositionByNft(new PublicKey(targetNftMint));
          if (targetPosition) break;
        }
      }
      if (!targetPosition) {
        logger.error(MODULE, `Cannot read target position after retries: ${targetNftMint.slice(0, 8)}`);
        return null;
      }

      const posData = targetPosition.getData();
      const tickLower = posData.tickLowerIndex;
      const tickUpper = posData.tickUpperIndex;

      // 2. Get pool
      const pool = await this.client.getPool(posData.whirlpool);
      const poolData = pool.getData();
      const mintA = poolData.tokenMintA;
      const mintB = poolData.tokenMintB;
      const mintAStr = mintA.toBase58();
      const mintBStr = mintB.toBase58();
      const poolLabel = `${mintAStr}/${mintBStr}`;

      // 3. Token blacklist check
      if (this.isTokenBlacklisted(mintAStr, mintBStr)) {
        logger.info(MODULE, `[OPEN] Skipped — token blacklisted (${poolLabel})`);
        this.lastSkipReason = '代幣黑名單';
        return null;
      }

      // 4. Pump token filter (same tri-state as Byreal: off / full / discord)
      if (config.pumpFilterMode !== 'off') {
        const pumpMint = mintAStr.toLowerCase().includes('pump') ? mintAStr
          : mintBStr.toLowerCase().includes('pump') ? mintBStr : null;
        if (pumpMint) {
          if (!isPumpApproved(pumpMint)) {
            if (config.pumpFilterMode === 'full') {
              logger.info(MODULE, `[OPEN] Skipped — pump token detected (${poolLabel})`);
              this.lastSkipReason = 'Pump 代幣過濾';
              return null;
            }
            // discord mode
            if (isPumpRejected(pumpMint)) {
              logger.info(MODULE, `[OPEN] Skipped — pump token rejected (${pumpMint})`);
              this.lastSkipReason = 'Pump 代幣已拒絕';
              return null;
            }
            if (!isPumpPending(pumpMint)) {
              const symbol = this.getTokenSymbol(pumpMint);
              addPumpPending({ mint: pumpMint, symbol, pool: poolLabel, targetWallet: targetWallet || '', detectedAt: Date.now() });
              notifyPumpApproval(pumpMint, symbol, poolLabel).catch((e: any) => logger.warn(MODULE, `Pump notify failed: ${e.message}`));
            }
            logger.info(MODULE, `[OPEN] Skipped — pump token pending approval (${pumpMint})`);
            this.lastSkipReason = 'Pump 代幣等待確認';
            return null;
          }
        }
      }

      // 5. Pool TVL filter
      if (config.minPoolTvl > 0) {
        const STABLES = new Set([USDC, USDT_MINT, USDT_T22]);
        for (const [mint, label] of [[mintAStr, 'mintA'], [mintBStr, 'mintB']] as [string, string][]) {
          if (config.poolTvlWhitelist.has(mint)) continue;
          if (STABLES.has(mint) || mint === NATIVE_MINT.toBase58()) continue;
          const tvl = await checkTokenLiquidity(mint, () => getOrcaPoolTvl(poolAddress));
          if (tvl === null || tvl < config.minPoolTvl) {
            logger.info(MODULE, `[OPEN] Skipped — ${label} ${mint.slice(0, 8)} TVL $${tvl !== null ? tvl.toFixed(0) : '?'} < $${config.minPoolTvl} (${config.tvlSource})`);
            this.lastSkipReason = `TVL 不足 ($${tvl !== null ? tvl.toFixed(0) : '?'} < $${config.minPoolTvl})`;
            return null;
          }
          break; // only need to check one non-stable mint
        }
      }

      // 6. Calculate deposit amount — scale TARGET's position size by ratio
      const tokenExtensionCtx = await TokenExtensionUtil.buildTokenExtensionContextForPool(
        this.ctx.fetcher, mintA, mintB,
      );

      const targetLiquidity = posData.liquidity;
      if (targetLiquidity.isZero()) {
        logger.warn(MODULE, 'Target position has zero liquidity, skipping');
        this.lastSkipReason = '目標流動性為零';
        return null;
      }

      const targetQuote = decreaseLiquidityQuoteByLiquidity(
        targetLiquidity,
        this.getSlippage(),
        targetPosition,
        pool,
        tokenExtensionCtx,
      );

      const ratio = getAmountRatio(targetWallet);
      const ourTokenA = scaleAmount(targetQuote.tokenEstA, targetWallet);
      const ourTokenB = scaleAmount(targetQuote.tokenEstB, targetWallet);

      if (ourTokenA.isZero() && ourTokenB.isZero()) {
        logger.warn(MODULE, 'Scaled deposit amounts are both zero, skipping');
        this.lastSkipReason = '存款金額為零';
        return null;
      }

      logger.info(MODULE, `Target liquidity: ${targetLiquidity.toString()}, ratio: ${ratio}`);
      logger.info(MODULE, `Our deposit target: tokenA=${ourTokenA.toString()}, tokenB=${ourTokenB.toString()}`);

      // 5a. Pre-swap: acquire tokens if insufficient
      let ourBalanceA = await this.getTokenBalance(userAddress, mintA);
      let ourBalanceB = await this.getTokenBalance(userAddress, mintB);
      logger.info(MODULE, `Our balances before swap: A=${ourBalanceA.toString()}, B=${ourBalanceB.toString()}`);

      // Pre-check: estimate total USDC cost before swapping to avoid wasting gas
      {
        let estimatedCost = 0n;
        const deficitA = ourTokenA.gt(ourBalanceA) && !ourTokenA.isZero() ? ourTokenA.sub(ourBalanceA) : new BN(0);
        const deficitB = ourTokenB.gt(ourBalanceB) && !ourTokenB.isZero() ? ourTokenB.sub(ourBalanceB) : new BN(0);

        if (!deficitA.isZero()) {
          if (mintAStr === USDC) {
            estimatedCost += BigInt(deficitA.toString());
          } else {
            const cost = await this.estimateSwapCost(USDC, mintAStr, deficitA);
            if (cost) estimatedCost += BigInt(cost.toString());
          }
        }
        if (!deficitB.isZero()) {
          if (mintBStr === USDC) {
            estimatedCost += BigInt(deficitB.toString());
          } else {
            const cost = await this.estimateSwapCost(USDC, mintBStr, deficitB);
            if (cost) estimatedCost += BigInt(cost.toString());
          }
        }

        if (estimatedCost > 0n) {
          // Reuse existing balance if one side is USDC, avoid extra RPC call
          const usdcBalance = mintAStr === USDC ? ourBalanceA : mintBStr === USDC ? ourBalanceB : await this.getTokenBalance(userAddress, new PublicKey(USDC));
          const usdcBal = BigInt(usdcBalance.toString());
          logger.info(MODULE, `Pre-check: estimated USDC cost=${estimatedCost}, USDC balance=${usdcBal}`);
          if (estimatedCost > usdcBal) {
            logger.warn(MODULE, `Insufficient USDC for position: need ~${estimatedCost} but have ${usdcBal}, skipping`);
            this.lastSkipReason = `USDC 不足 (需 ~${(Number(estimatedCost) / 1e6).toFixed(2)}, 有 ${(Number(usdcBal) / 1e6).toFixed(2)})`;
            return null;
          }
        }
      }

      // Swap for tokenA if we don't have enough
      if (ourBalanceA.lt(ourTokenA) && !ourTokenA.isZero() && mintAStr !== USDC) {
        const deficit = ourTokenA.sub(ourBalanceA);
        logger.info(MODULE, `Need ${deficit.toString()} more of tokenA (${mintAStr})`);
        let txSig: string | null = null;

        if (mintA.equals(NATIVE_MINT)) {
          // SOL deficit: only try USDC→SOL (don't spend other tokens)
          txSig = await swapForToken(this.connection, USDC, mintAStr, deficit.toString());
        } else {
          // Try 1: swap tokenB → tokenA (if we have tokenB)
          if (!ourBalanceB.isZero()) {
            txSig = await swapForToken(this.connection, mintBStr, mintAStr, deficit.toString());
          }
          // Try 2: swap USDC → tokenA
          if (!txSig) {
            logger.info(MODULE, 'Trying USDC → tokenA');
            txSig = await swapForToken(this.connection, USDC, mintAStr, deficit.toString());
          }
        }
        if (!txSig) {
          logger.error(MODULE, 'All swap methods failed for tokenA, aborting open');
          notifySwapFailed(mintAStr, lastSwapError || 'all methods failed');
          return null;
        }
        const addedA = await getActualSwapOutput(this.readConnection, txSig, mintAStr, userAddress.toBase58());
        if (addedA) {
          swappedTokens.push({ mint: mintAStr, amount: new BN(addedA) });
          ourBalanceA = ourBalanceA.add(new BN(addedA));
        } else {
          await new Promise(r => setTimeout(r, 5000));
          const newBalA = await this.getTokenBalance(userAddress, mintA);
          const gained = newBalA.sub(ourBalanceA);
          if (gained.gt(new BN(0))) swappedTokens.push({ mint: mintAStr, amount: gained });
          ourBalanceA = newBalA;
        }
        logger.info(MODULE, `tokenA after swap: ${ourBalanceA.toString()}`);
        // Re-read tokenB balance (swap may have consumed tokenB)
        ourBalanceB = await this.getTokenBalance(userAddress, mintB);
      }

      // Swap for tokenB if we don't have enough
      if (ourBalanceB.lt(ourTokenB) && !ourTokenB.isZero() && mintBStr !== USDC) {
        const deficit = ourTokenB.sub(ourBalanceB);
        logger.info(MODULE, `Need ${deficit.toString()} more of tokenB (${mintBStr})`);
        let txSig: string | null = null;

        if (mintB.equals(NATIVE_MINT)) {
          // SOL deficit: only try USDC→SOL
          txSig = await swapForToken(this.connection, USDC, mintBStr, deficit.toString());
        } else {
          // Try 1: swap USDC → tokenB
          txSig = await swapForToken(this.connection, USDC, mintBStr, deficit.toString());
          // Try 2: swap tokenA → tokenB (last resort, only if surplus)
          if (!txSig && ourBalanceA.gt(ourTokenA)) {
            logger.info(MODULE, 'Trying tokenA → tokenB (last resort)');
            txSig = await swapForToken(this.connection, mintAStr, mintBStr, deficit.toString());
          }
        }
        if (!txSig) {
          logger.error(MODULE, 'All swap methods failed for tokenB, aborting open');
          notifySwapFailed(mintBStr, lastSwapError || 'all methods failed');
          return null;
        }
        const addedB = await getActualSwapOutput(this.readConnection, txSig, mintBStr, userAddress.toBase58());
        if (addedB) {
          swappedTokens.push({ mint: mintBStr, amount: new BN(addedB) });
          ourBalanceB = ourBalanceB.add(new BN(addedB));
        } else {
          await new Promise(r => setTimeout(r, 5000));
          const newBalB = await this.getTokenBalance(userAddress, mintB);
          const gained = newBalB.sub(ourBalanceB);
          if (gained.gt(new BN(0))) swappedTokens.push({ mint: mintBStr, amount: gained });
          ourBalanceB = newBalB;
        }
        logger.info(MODULE, `tokenB after swap: ${ourBalanceB.toString()}`);
      }

      logger.info(MODULE, `Balances after swap: A=${ourBalanceA.toString()}, B=${ourBalanceB.toString()}`);

      if (ourBalanceA.isZero() && ourBalanceB.isZero()) {
        logger.error(MODULE, 'No token balance for either side after swaps, cannot open position');
        return null;
      }

      // 5b. Open with retry (same pattern as Byreal)
      const MAX_OPEN_ATTEMPTS = 2;
      for (let openAttempt = 0; openAttempt < MAX_OPEN_ATTEMPTS; openAttempt++) {
        if (openAttempt > 0) {
          logger.info(MODULE, `Retrying open position (attempt ${openAttempt + 1}/${MAX_OPEN_ATTEMPTS}), re-reading balances...`);
          await new Promise(r => setTimeout(r, 2000));
          ourBalanceA = await this.getTokenBalance(userAddress, mintA);
          ourBalanceB = await this.getTokenBalance(userAddress, mintB);
          logger.info(MODULE, `Retry balances: A=${ourBalanceA.toString()}, B=${ourBalanceB.toString()}`);
        }

        // Cap tokenMax to min(target, balance). For out-of-range positions where one side is 0,
        // pass wallet balance as max — the on-chain program only deposits 0 for the zero-side
        // regardless of tokenMax (verified via TX 2xgngkPM...). Passing 0 causes LiquidityZero.
        const tokenMaxA = ourTokenA.isZero() && !ourTokenB.isZero() ? ourBalanceA : BN.min(ourTokenA, ourBalanceA);
        const tokenMaxB = ourTokenB.isZero() && !ourTokenA.isZero() ? ourBalanceB : BN.min(ourTokenB, ourBalanceB);

        logger.info(MODULE, `Position params: ticks=[${tickLower}, ${tickUpper}]`, {
          tokenMaxA: tokenMaxA.toString(),
          tokenMaxB: tokenMaxB.toString(),
        });

        let positionMint: PublicKey | null = null;
        try {
          // Init tick arrays if needed
          const initTickTx = await pool.initTickArrayForTicks([tickLower, tickUpper]);
          if (initTickTx) {
            const initSig = await initTickTx.buildAndExecute();
            logger.info(MODULE, `Tick arrays initialized: ${initSig}`);
          }

          // Open position + increase liquidity
          const MAX_SQRT_PRICE = new BN('79226673515401279992447579055');
          const result = await pool.openPosition(
            tickLower,
            tickUpper,
            { tokenMaxA, tokenMaxB, minSqrtPrice: new BN(0), maxSqrtPrice: MAX_SQRT_PRICE },
          );
          positionMint = result.positionMint;

          const txSig = await result.tx.buildAndExecute();
          logger.info(MODULE, `Position opened: ${txSig}`);

          // Save mapping
          this.positionMap.set(
            targetNftMint,
            positionMint.toBase58(),
            poolLabel,
            targetWallet,
            tickLower,
            tickUpper,
            'orca',
          );
          this.positionMap.setLockedSol(targetNftMint, this.rentPerPosition);
          this.positionMap.setTargetLiquidity(targetNftMint, targetLiquidity.toString());
          logger.info(MODULE, `Mapping saved: ${targetNftMint.slice(0, 8)} -> ${positionMint.toBase58().slice(0, 8)}`);

          return txSig;
        } catch (openErr: any) {
          // Check if position was actually created on-chain despite the error
          // (buildAndExecute can throw during confirmation even if TX succeeded)
          if (positionMint) {
            try {
              const checkPos = await this.getPositionByNft(positionMint);
              if (checkPos) {
                logger.warn(MODULE, `buildAndExecute threw but position EXISTS on-chain: ${positionMint.toBase58().slice(0, 8)}, saving mapping`);
                this.positionMap.set(
                  targetNftMint,
                  positionMint.toBase58(),
                  poolLabel,
                  targetWallet,
                  tickLower,
                  tickUpper,
                  'orca',
                );
                this.positionMap.setLockedSol(targetNftMint, this.rentPerPosition);
                this.positionMap.setTargetLiquidity(targetNftMint, targetLiquidity.toString());
                return `recovered-${positionMint.toBase58().slice(0, 8)}`;
              }
            } catch {
              // Position check failed — continue with normal error handling
            }
          }

          if (openAttempt < MAX_OPEN_ATTEMPTS - 1 && (this.isRetryableSimError(openErr) || this.isTransientError(openErr))) {
            logger.warn(MODULE, `Open attempt ${openAttempt + 1} failed (${(openErr.message || '').slice(0, 100)}), will retry...`);
            continue;
          }
          throw openErr;
        }
      }

      return null; // should not reach here
    } catch (err: any) {
      logger.error(MODULE, `Open position failed: ${err.message}`);
      notifyOpenFailed(err, targetNftMint);

      // Swap back tokens acquired during pre-swap to recover USDC
      if (swappedTokens.length > 0) {
        await this.swapBackOnFailure(swappedTokens);
      }

      if (/insufficient lamports/i.test(err.message)) {
        this.solPaused = true;
        this.solPausedAt = Date.now();
        logger.error(MODULE, 'SOL 不足，已暫停開倉/加倉');
        notifySolInsufficient(this.cachedSolBalance ?? 0);
      }
      return null;
    } finally {
      this.release();
      this.getSolBalance().then(b => { this.cachedSolBalance = b; }).catch(() => {});
    }
  }

  async copyClosePosition(targetNftMint: string): Promise<string | null> {
    const myNftMint = this.positionMap.get(targetNftMint);
    if (!myNftMint) {
      logger.warn(MODULE, `No mapped position for target NFT: ${targetNftMint.slice(0, 8)}`);
      return null;
    }

    logger.info(MODULE, `Closing position for our NFT: ${myNftMint.slice(0, 8)}...`);

    if (config.dryRun) {
      logger.info(MODULE, '[DRY RUN] Would close position', { myNftMint });
      return 'dry-run-orca-close';
    }

    if (!this.acquire('copyClosePosition')) return null;

    try {
      const userAddress = getUserAddress();
      let txSig: string | null = null;

      const MAX_CLOSE_ATTEMPTS = 3;
      for (let attempt = 0; attempt < MAX_CLOSE_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          logger.info(MODULE, `Retrying close (attempt ${attempt + 1}/${MAX_CLOSE_ATTEMPTS})...`);
          await new Promise(r => setTimeout(r, 2000));
        }

        try {
          // Get our position
          const myPosition = await this.getPositionByNft(new PublicKey(myNftMint));
          if (!myPosition) {
            logger.error(MODULE, `Cannot read our position: ${myNftMint.slice(0, 8)}`);
            this.positionMap.delete(targetNftMint);
            return null;
          }

          const posData = myPosition.getData();
          const pool = await this.client.getPool(posData.whirlpool);

          // Close position (decrease all liquidity + collect fees + close)
          const positionPda = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, new PublicKey(myNftMint));
          const txBuilders = await pool.closePosition(
            positionPda.publicKey,
            this.getSlippage(),
          );

          // Execute all transactions
          let lastSig = '';
          for (const txBuilder of txBuilders) {
            lastSig = await txBuilder.buildAndExecute();
            logger.info(MODULE, `Close TX executed: ${lastSig}`);
          }
          txSig = lastSig;
        } catch (closeErr: any) {
          if (attempt < MAX_CLOSE_ATTEMPTS - 1 && (this.isRetryableSimError(closeErr) || this.isTransientError(closeErr))) {
            logger.warn(MODULE, `Close attempt ${attempt + 1} failed (${(closeErr.message || '').slice(0, 100)}), will retry...`);
            continue;
          }
          throw closeErr;
        }

        if (!txSig) return null;

        // Verify TX actually succeeded on-chain
        const success = await this.verifyTxSuccess(txSig);
        if (success) break;

        // On-chain failure — retry if attempts remain
        if (attempt < MAX_CLOSE_ATTEMPTS - 1) {
          logger.warn(MODULE, `Close TX failed on-chain: ${txSig.slice(0, 8)}, retrying (${attempt + 1}/${MAX_CLOSE_ATTEMPTS})...`);
          txSig = null;
          continue;
        }
        logger.error(MODULE, `Close TX failed on-chain after ${MAX_CLOSE_ATTEMPTS} attempts: ${txSig.slice(0, 8)}, keeping mapping`);
        notifyCloseFailed(myNftMint, 'on-chain failure after max attempts', MAX_CLOSE_ATTEMPTS);
        return null;
      }

      if (!txSig) return null;

      logger.info(MODULE, `Position closed: ${myNftMint.slice(0, 8)} TX: ${txSig}`);
      this.positionMap.delete(targetNftMint);

      // Parse TX to get actual received amounts, queue as pending swaps
      const received = await this.parseTxTokenChanges(txSig, userAddress);
      for (const { mint, amount } of received) {
        logger.info(MODULE, `Received from close: ${mint.toBase58().slice(0, 8)}... = ${amount.toString()}`);
        this.addPendingSwap(mint, amount);
      }

      return txSig;
    } catch (err: any) {
      logger.error(MODULE, `Close position failed: ${typeof err?.message === 'string' ? err.message : JSON.stringify(err)}`);
      notifyCloseFailed(myNftMint, err, 0);
      return null;
    } finally {
      this.release();
    }
  }

  async copyIncreaseLiquidity(targetNftMint: string, targetWallet: string): Promise<string | null> {
    const myNftMint = this.positionMap.get(targetNftMint);
    if (!myNftMint) {
      logger.warn(MODULE, `No mapped position for target NFT: ${targetNftMint.slice(0, 8)}`);
      return null;
    }

    if (this.solPaused || this.drawdownPaused) {
      logger.info(MODULE, `[INCREASE] Skipped — paused (sol=${this.solPaused}, drawdown=${this.drawdownPaused})`);
      return null;
    }

    if (config.orcaCloseOnlyWallets.has(targetWallet)) {
      logger.info(MODULE, `[INCREASE] Skipped — wallet ${targetWallet.slice(0, 8)} is close-only`);
      return null;
    }

    logger.info(MODULE, `Increasing liquidity for our NFT: ${myNftMint.slice(0, 8)}...`);

    if (config.dryRun) {
      logger.info(MODULE, '[DRY RUN] Would increase liquidity', { myNftMint });
      return 'dry-run-orca-increase';
    }

    if (!this.acquire('copyIncreaseLiquidity')) return null;

    try {
      // 1. Get our position
      const myPosition = await this.getPositionByNft(new PublicKey(myNftMint));
      if (!myPosition) {
        logger.error(MODULE, `Cannot read our position: ${myNftMint.slice(0, 8)}`);
        return null;
      }

      const posData = myPosition.getData();
      const pool = await this.client.getPool(posData.whirlpool);
      const poolData = pool.getData();
      const mintA = poolData.tokenMintA;
      const mintB = poolData.tokenMintB;
      const mintAStr = mintA.toBase58();
      const mintBStr = mintB.toBase58();

      // 2. Pump token filter (same as copyOpenPosition)
      if (config.pumpFilterMode !== 'off') {
        const pumpMint = mintAStr.toLowerCase().includes('pump') ? mintAStr
          : mintBStr.toLowerCase().includes('pump') ? mintBStr : null;
        if (pumpMint && !isPumpApproved(pumpMint)) {
          logger.info(MODULE, `[INCREASE] Skipped — pump token ${config.pumpFilterMode === 'full' ? 'filtered' : 'not approved'} (${pumpMint})`);
          return null;
        }
      }

      // 2b. Pool TVL filter
      if (config.minPoolTvl > 0) {
        const poolAddr = posData.whirlpool.toBase58();
        const poolInfo = pool.getData();
        const mAStr = poolInfo.tokenMintA.toBase58();
        const mBStr = poolInfo.tokenMintB.toBase58();
        const STABLES = new Set([USDC, USDT_MINT, USDT_T22]);
        const checkMint = (!STABLES.has(mAStr) && mAStr !== NATIVE_MINT.toBase58()) ? mAStr : mBStr;
        const tvl = await checkTokenLiquidity(checkMint, () => getOrcaPoolTvl(poolAddr));
        if (tvl === null || tvl < config.minPoolTvl) {
          logger.info(MODULE, `[INCREASE] Skipped — ${checkMint.slice(0, 8)} TVL $${tvl !== null ? tvl.toFixed(0) : '?'} < $${config.minPoolTvl} (${config.tvlSource})`);
          return null;
        }
      }

      // 3. Read target position to know how much they added
      // Wait briefly — RPC may not reflect the increase TX we just detected via WebSocket
      await new Promise(r => setTimeout(r, 2000));

      const tokenExtensionCtx = await TokenExtensionUtil.buildTokenExtensionContextForPool(
        this.ctx.fetcher, mintA, mintB,
      );

      let deltaA = new BN(0);
      let deltaB = new BN(0);
      for (let readAttempt = 0; readAttempt < 2; readAttempt++) {
        if (readAttempt > 0) {
          logger.info(MODULE, 'Delta ≤ 0 after detecting increase TX, waiting for RPC to catch up...');
          await new Promise(r => setTimeout(r, 3000));
        }

        const targetPosition = await this.getPositionByNft(new PublicKey(targetNftMint));
        if (!targetPosition) {
          logger.warn(MODULE, 'Cannot read target position for increase');
          return null;
        }

        const targetQuote = decreaseLiquidityQuoteByLiquidity(
          targetPosition.getData().liquidity,
          this.getSlippage(),
          targetPosition,
          pool,
          tokenExtensionCtx,
        );

        const ourTokenA = scaleAmount(targetQuote.tokenEstA, targetWallet);
        const ourTokenB = scaleAmount(targetQuote.tokenEstB, targetWallet);
        // Re-read our position too (may have changed from previous increase)
        const freshMyPosition = readAttempt > 0 ? await this.getPositionByNft(new PublicKey(myNftMint)) : myPosition;
        const freshPosData = freshMyPosition ? freshMyPosition.getData() : posData;
        const myQuote = decreaseLiquidityQuoteByLiquidity(
          freshPosData.liquidity,
          this.getSlippage(),
          freshMyPosition || myPosition,
          pool,
          tokenExtensionCtx,
        );
        deltaA = ourTokenA.sub(myQuote.tokenEstA);
        deltaB = ourTokenB.sub(myQuote.tokenEstB);

        if (deltaA.gt(new BN(0)) || deltaB.gt(new BN(0))) break;
      }

      if (deltaA.lte(new BN(0)) && deltaB.lte(new BN(0))) {
        logger.info(MODULE, 'Our position already matches or exceeds target after retry, no increase needed');
        return null;
      }

      logger.info(MODULE, `Increase: deltaA=${deltaA.toString()}, deltaB=${deltaB.toString()}`);

      // 3b. Pre-swap: acquire tokens if insufficient
      const increaseA = deltaA.gt(new BN(0)) ? deltaA : new BN(0);
      const increaseB = deltaB.gt(new BN(0)) ? deltaB : new BN(0);
      const userAddr = getUserAddress();
      let balA = await this.getTokenBalance(userAddr, mintA);
      let balB = await this.getTokenBalance(userAddr, mintB);
      logger.info(MODULE, `Balances before swap: A=${balA.toString()}, B=${balB.toString()}`);

      if (balA.lt(increaseA) && !increaseA.isZero() && mintAStr !== USDC) {
        const deficit = increaseA.sub(balA);
        logger.info(MODULE, `Need ${deficit.toString()} more of tokenA (${mintAStr})`);
        let swapSig: string | null = null;
        if (mintA.equals(NATIVE_MINT)) {
          swapSig = await swapForToken(this.connection, USDC, mintAStr, deficit.toString());
        } else {
          // Try 1: tokenB → tokenA
          if (!balB.isZero()) {
            swapSig = await swapForToken(this.connection, mintBStr, mintAStr, deficit.toString());
          }
          // Try 2: USDC → tokenA
          if (!swapSig) {
            swapSig = await swapForToken(this.connection, USDC, mintAStr, deficit.toString());
          }
        }
        if (!swapSig) {
          logger.error(MODULE, 'All swap methods failed for tokenA, aborting increase');
          notifySwapFailed(mintAStr, lastSwapError || 'all methods failed');
          return null;
        }
        const added = await getActualSwapOutput(this.readConnection, swapSig, mintAStr, userAddr.toBase58());
        if (added) { balA = balA.add(new BN(added)); } else {
          await new Promise(r => setTimeout(r, 5000));
          balA = await this.getTokenBalance(userAddr, mintA);
        }
        logger.info(MODULE, `tokenA after swap: ${balA.toString()}`);
        // Re-read tokenB balance (swap may have consumed tokenB)
        balB = await this.getTokenBalance(userAddr, mintB);
      }

      if (balB.lt(increaseB) && !increaseB.isZero() && mintBStr !== USDC) {
        const deficit = increaseB.sub(balB);
        logger.info(MODULE, `Need ${deficit.toString()} more of tokenB (${mintBStr})`);
        let swapSig: string | null = null;
        if (mintB.equals(NATIVE_MINT)) {
          swapSig = await swapForToken(this.connection, USDC, mintBStr, deficit.toString());
        } else {
          // Try 1: USDC → tokenB
          swapSig = await swapForToken(this.connection, USDC, mintBStr, deficit.toString());
          // Try 2: tokenA → tokenB (last resort, only if surplus)
          if (!swapSig && balA.gt(increaseA)) {
            logger.info(MODULE, 'Trying tokenA → tokenB (last resort)');
            swapSig = await swapForToken(this.connection, mintAStr, mintBStr, deficit.toString());
          }
        }
        if (!swapSig) {
          logger.error(MODULE, 'All swap methods failed for tokenB, aborting increase');
          notifySwapFailed(mintBStr, lastSwapError || 'all methods failed');
          return null;
        }
        const added = await getActualSwapOutput(this.readConnection, swapSig, mintBStr, userAddr.toBase58());
        if (added) { balB = balB.add(new BN(added)); } else {
          await new Promise(r => setTimeout(r, 5000));
          balB = await this.getTokenBalance(userAddr, mintB);
        }
        logger.info(MODULE, `tokenB after swap: ${balB.toString()}`);
      }

      // 4. Increase with retry (same pattern as Byreal)
      const MAX_INCREASE_ATTEMPTS = 2;
      for (let attempt = 0; attempt < MAX_INCREASE_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          logger.info(MODULE, `Retrying increase (attempt ${attempt + 1}/${MAX_INCREASE_ATTEMPTS}), re-reading balances...`);
          await new Promise(r => setTimeout(r, 2000));
          balA = await this.getTokenBalance(userAddr, mintA);
          balB = await this.getTokenBalance(userAddr, mintB);
          logger.info(MODULE, `Retry balances: A=${balA.toString()}, B=${balB.toString()}`);
        }

        // Cap tokenMax to min(delta, balance). For out-of-range positions where one delta is 0,
        // pass wallet balance as max — on-chain only deposits 0 for zero-side regardless of tokenMax.
        // Passing 0 causes LiquidityZero (0x177c).
        const tokenMaxA = increaseA.isZero() && !increaseB.isZero() ? balA : BN.min(increaseA, balA);
        const tokenMaxB = increaseB.isZero() && !increaseA.isZero() ? balB : BN.min(increaseB, balB);

        logger.info(MODULE, `IncreaseLiquidity: tokenMaxA=${tokenMaxA.toString()}, tokenMaxB=${tokenMaxB.toString()}`);

        try {
          const MAX_SQRT_PRICE_INC = new BN('79226673515401279992447579055');
          const tx = await myPosition.increaseLiquidity({ tokenMaxA, tokenMaxB, minSqrtPrice: new BN(0), maxSqrtPrice: MAX_SQRT_PRICE_INC });
          const txSig = await tx.buildAndExecute();
          logger.info(MODULE, `Liquidity increased: ${txSig}`);

          // Update stored targetLiquidity so partial decrease calculations remain correct
          try {
            const updatedTarget = await this.getPositionByNft(new PublicKey(targetNftMint));
            if (updatedTarget) {
              const newTargetLiq = updatedTarget.getData().liquidity;
              this.positionMap.setTargetLiquidity(targetNftMint, newTargetLiq.toString());
              logger.debug(MODULE, `Updated targetLiquidity after increase: ${newTargetLiq.toString()}`);
            }
          } catch { /* non-critical */ }

          return txSig;
        } catch (incErr: any) {
          if (attempt < MAX_INCREASE_ATTEMPTS - 1 && (this.isRetryableSimError(incErr) || this.isTransientError(incErr))) {
            logger.warn(MODULE, `Increase attempt ${attempt + 1} failed (${(incErr.message || '').slice(0, 100)}), will retry...`);
            continue;
          }
          throw incErr;
        }
      }

      return null; // should not reach here
    } catch (err: any) {
      logger.error(MODULE, `Increase liquidity failed: ${err.message}`);
      return null;
    } finally {
      this.release();
    }
  }

  async copyDecreaseLiquidity(targetNftMint: string): Promise<{ txSig: string; type: 'DECREASE' | 'COLLECT_FEE' } | null> {
    const myNftMint = this.positionMap.get(targetNftMint);
    if (!myNftMint) {
      logger.warn(MODULE, `No mapped position for target NFT: ${targetNftMint.slice(0, 8)}`);
      return null;
    }

    // Read target's current liquidity to determine: full decrease, partial decrease, or fee collection
    let targetCurrentLiq: BN | null = null;
    try {
      const targetPosition = await this.getPositionByNft(new PublicKey(targetNftMint));
      if (targetPosition) {
        targetCurrentLiq = targetPosition.getData().liquidity;
      }
    } catch {
      logger.warn(MODULE, 'Cannot read target position, proceeding with full decrease');
    }

    // Determine decrease amount by comparing target's current vs stored liquidity
    let decreaseAmount: BN | null = null; // null = full decrease
    if (targetCurrentLiq && !targetCurrentLiq.isZero()) {
      const storedLiqStr = this.positionMap.getTargetLiquidity(targetNftMint);
      if (storedLiqStr) {
        const storedLiq = new BN(storedLiqStr);
        if (targetCurrentLiq.lt(storedLiq)) {
          // Partial decrease — calculate proportional amount for our position
          // decreasePct = (storedLiq - currentLiq) / storedLiq
          // ourDecrease = ourLiquidity * decreasePct
          const removedLiq = storedLiq.sub(targetCurrentLiq);
          const pctNumerator = removedLiq.mul(new BN(10000));
          const pctBps = pctNumerator.div(storedLiq).toNumber(); // basis points removed
          logger.info(MODULE, `Partial decrease detected: target ${storedLiq.toString()} -> ${targetCurrentLiq.toString()} (removed ${pctBps / 100}%)`);

          try {
            const myPosition = await this.getPositionByNft(new PublicKey(myNftMint));
            if (myPosition) {
              const myLiq = myPosition.getData().liquidity;
              // ourDecrease = myLiq * removedLiq / storedLiq
              decreaseAmount = myLiq.mul(removedLiq).div(storedLiq);
              if (decreaseAmount.isZero()) {
                logger.info(MODULE, `Proportional decrease rounds to zero, collecting fees instead`);
              } else {
                logger.info(MODULE, `Our decrease: ${decreaseAmount.toString()} of ${myLiq.toString()}`);
              }
            }
          } catch (err: any) {
            logger.warn(MODULE, `Cannot read our position for proportional calc: ${err.message}`);
          }

          // Update stored target liquidity for next decrease
          this.positionMap.setTargetLiquidity(targetNftMint, targetCurrentLiq.toString());
        } else {
          // Target liquidity >= stored — likely fee collection only (increase happened?)
          logger.info(MODULE, `Target liquidity ${targetCurrentLiq.toString()} >= stored ${storedLiq.toString()}, collecting fees`);
          decreaseAmount = new BN(0);
        }
      } else {
        // No stored liquidity (old position) — can't calculate proportion, collect fees
        logger.info(MODULE, `No stored targetLiquidity for ${targetNftMint.slice(0, 8)}, collecting fees (legacy position)`);
        decreaseAmount = new BN(0);
      }
    }
    // targetCurrentLiq is null or zero → full decrease (decreaseAmount stays null)

    // Fee collection only (decreaseAmount is zero)
    if (decreaseAmount && decreaseAmount.isZero()) {
      if (config.dryRun) {
        return { txSig: 'dry-run-orca-collect-fee', type: 'COLLECT_FEE' };
      }

      if (!this.acquire('collectFees')) return null;
      try {
        const MAX_FEE_ATTEMPTS = 2;
        for (let attempt = 0; attempt < MAX_FEE_ATTEMPTS; attempt++) {
          if (attempt > 0) {
            logger.info(MODULE, `Retrying collect fees (attempt ${attempt + 1}/${MAX_FEE_ATTEMPTS})...`);
            await new Promise(r => setTimeout(r, 2000));
          }

          try {
            const myPosition = await this.getPositionByNft(new PublicKey(myNftMint));
            if (!myPosition) {
              logger.error(MODULE, `Cannot read our position for fee collection: ${myNftMint.slice(0, 8)}`);
              return null;
            }
            const tx = await myPosition.collectFees();
            const txSig = await tx.buildAndExecute();
            logger.info(MODULE, `Fees collected: ${txSig}`);
            return { txSig, type: 'COLLECT_FEE' };
          } catch (feeErr: any) {
            if (attempt < MAX_FEE_ATTEMPTS - 1 && (this.isRetryableSimError(feeErr) || this.isTransientError(feeErr))) {
              logger.warn(MODULE, `Collect fees attempt ${attempt + 1} failed (${(feeErr.message || '').slice(0, 100)}), will retry...`);
              continue;
            }
            throw feeErr;
          }
        }

        return null; // should not reach here
      } catch (err: any) {
        logger.error(MODULE, `Collect fees failed: ${err.message}`);
        return null;
      } finally {
        this.release();
      }
    }

    // Decrease liquidity (full or proportional)
    const isPartial = decreaseAmount !== null;
    logger.info(MODULE, `${isPartial ? 'Partial' : 'Full'} decrease for our NFT: ${myNftMint.slice(0, 8)}...`);

    if (config.dryRun) {
      return { txSig: 'dry-run-orca-decrease', type: 'DECREASE' };
    }

    if (!this.acquire('copyDecreaseLiquidity')) return null;

    try {
      const MAX_DECREASE_ATTEMPTS = 2;
      for (let attempt = 0; attempt < MAX_DECREASE_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          logger.info(MODULE, `Retrying decrease (attempt ${attempt + 1}/${MAX_DECREASE_ATTEMPTS})...`);
          await new Promise(r => setTimeout(r, 2000));
        }

        try {
          const myPosition = await this.getPositionByNft(new PublicKey(myNftMint));
          if (!myPosition) {
            logger.error(MODULE, `Cannot read our position: ${myNftMint.slice(0, 8)}`);
            return null;
          }

          const posData = myPosition.getData();
          const liquidityAmount = isPartial ? BN.min(decreaseAmount!, posData.liquidity) : posData.liquidity;

          if (liquidityAmount.isZero()) {
            logger.info(MODULE, `Our position already has zero liquidity, collecting fees`);
            try {
              const tx = await myPosition.collectFees();
              const txSig = await tx.buildAndExecute();
              logger.info(MODULE, `Fees collected: ${txSig}`);
              return { txSig, type: 'COLLECT_FEE' };
            } catch (feeErr: any) {
              logger.error(MODULE, `Collect fees failed: ${feeErr.message}`);
              return null;
            }
          }

          const tx = await myPosition.decreaseLiquidity({
            liquidityAmount,
            tokenMinA: new BN(0),
            tokenMinB: new BN(0),
          });
          const txSig = await tx.buildAndExecute();
          logger.info(MODULE, `Liquidity decreased${isPartial ? ' (partial)' : ''} (position kept open): ${txSig}`);

          // Queue received tokens as pending swaps (same as close flow)
          try {
            const received = await this.parseTxTokenChanges(txSig, getUserAddress());
            for (const { mint, amount } of received) {
              logger.info(MODULE, `Received from decrease: ${mint.toBase58().slice(0, 8)}... = ${amount.toString()}`);
              this.addPendingSwap(mint, amount);
            }
          } catch (parseErr: any) {
            logger.warn(MODULE, `Could not parse decrease TX for pending swaps: ${parseErr.message}`);
          }

          return { txSig, type: 'DECREASE' };
        } catch (decErr: any) {
          if (attempt < MAX_DECREASE_ATTEMPTS - 1 && (this.isRetryableSimError(decErr) || this.isTransientError(decErr))) {
            logger.warn(MODULE, `Decrease attempt ${attempt + 1} failed (${(decErr.message || '').slice(0, 100)}), will retry...`);
            continue;
          }
          throw decErr;
        }
      }

      return null; // should not reach here
    } catch (err: any) {
      logger.error(MODULE, `Decrease liquidity failed: ${err.message}`);
      return null;
    } finally {
      this.release();
    }
  }

  hasMapping(targetNftMint: string): boolean {
    return !!this.positionMap.get(targetNftMint);
  }

  /** Check if an NFT mint is an Orca Whirlpool position (for reconcile backfill). */
  async isOrcaPosition(nftMint: string): Promise<boolean> {
    try {
      const positionPda = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, new PublicKey(nftMint));
      const pos = await this.readClient.getPosition(positionPda.publicKey);
      return !!pos;
    } catch {
      return false;
    }
  }

  /**
   * Calculate total USD value of all Orca LP positions (liquidity + unclaimed fees).
   * Uses readClient (Alchemy-backed WhirlpoolContext) to avoid Helius rate limits.
   */
  async getOrcaLpValueUsd(): Promise<{ lpUsd: number; feeUsd: number; count: number }> {
    const orcaEntries: { tgtNft: string; ourNft: string }[] = [];
    for (const [tgtNft, ourNft] of this.positionMap.entries()) {
      if (this.positionMap.getDex(tgtNft) === 'orca') {
        orcaEntries.push({ tgtNft, ourNft });
      }
    }
    if (orcaEntries.length === 0) return { lpUsd: 0, feeUsd: 0, count: 0 };

    // Use free RPC for dashboard reads (not Alchemy)
    const { ctx: freeCtx, client: freeClient } = this.getFreeClient();

    const lpTotals = new Map<string, number>();  // mint → ui amount (liquidity)
    const feeTotals = new Map<string, number>(); // mint → ui amount (fees)
    const mintsNeeded = new Set<string>();
    let count = 0;

    for (const { ourNft } of orcaEntries) {
      try {
        const nftMint = new PublicKey(ourNft);
        const positionPda = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, nftMint);

        const pos = await freeClient.getPosition(positionPda.publicKey);
        if (!pos) continue;

        const posData = pos.getData();
        if (posData.liquidity.isZero()) continue;

        const pool = await freeClient.getPool(posData.whirlpool);
        const poolData = pool.getData();
        const mintA = poolData.tokenMintA;
        const mintB = poolData.tokenMintB;
        const mintAStr = mintA.toBase58();
        const mintBStr = mintB.toBase58();

        const tokenExtensionCtx = await TokenExtensionUtil.buildTokenExtensionContextForPool(
          freeCtx.fetcher, mintA, mintB,
        );

        // Liquidity value
        const liqQuote = decreaseLiquidityQuoteByLiquidity(
          posData.liquidity,
          Percentage.fromFraction(0, 100),
          pos, pool, tokenExtensionCtx,
        );

        // Unclaimed fees
        const feeQuote = collectFeesQuote({
          whirlpool: poolData,
          position: posData,
          tickLower: pos.getLowerTickData(),
          tickUpper: pos.getUpperTickData(),
          tokenExtensionCtx,
        });

        const decA = poolData.tokenMintA ? await this.getMintDecimals(mintA, freeCtx.fetcher) : 9;
        const decB = poolData.tokenMintB ? await this.getMintDecimals(mintB, freeCtx.fetcher) : 6;

        const lpA = parseFloat(liqQuote.tokenEstA.toString()) / Math.pow(10, decA);
        const lpB = parseFloat(liqQuote.tokenEstB.toString()) / Math.pow(10, decB);
        // Guard: collectFeesQuote can produce overflow BN via subUnderflowU128 for freshly-opened positions
        const MAX_SANE_FEE = new BN('1000000000000000'); // 1e15 — no real fee exceeds this
        const feeA = feeQuote.feeOwedA.gt(MAX_SANE_FEE) ? 0 : parseFloat(feeQuote.feeOwedA.toString()) / Math.pow(10, decA);
        const feeB = feeQuote.feeOwedB.gt(MAX_SANE_FEE) ? 0 : parseFloat(feeQuote.feeOwedB.toString()) / Math.pow(10, decB);

        lpTotals.set(mintAStr, (lpTotals.get(mintAStr) || 0) + lpA);
        lpTotals.set(mintBStr, (lpTotals.get(mintBStr) || 0) + lpB);
        feeTotals.set(mintAStr, (feeTotals.get(mintAStr) || 0) + feeA);
        feeTotals.set(mintBStr, (feeTotals.get(mintBStr) || 0) + feeB);
        mintsNeeded.add(mintAStr);
        mintsNeeded.add(mintBStr);
        count++;
      } catch (err: any) {
        logger.debug(MODULE, `getOrcaLpValueUsd: error reading ${ourNft.slice(0, 8)}: ${(err.message || '').slice(0, 80)}`);
      }
      await new Promise(r => setTimeout(r, 300));
    }

    if (mintsNeeded.size === 0) return { lpUsd: 0, feeUsd: 0, count: 0 };

    // Fetch prices from Jupiter v3
    const mintList = Array.from(mintsNeeded).join(',');
    let prices: Record<string, number> = {};
    try {
      const res = await fetch(`https://api.jup.ag/price/v3?ids=${mintList}`, {
        headers: { 'x-api-key': config.jupApiKey },
      });
      if (res.ok) {
        const json = await res.json() as any;
        for (const [mint, info] of Object.entries(json || {})) {
          const p = (info as any)?.usdPrice;
          if (p) prices[mint] = parseFloat(String(p));
        }
      }
    } catch (err: any) {
      logger.warn(MODULE, `getOrcaLpValueUsd: Jupiter price fetch failed: ${err.message}`);
    }

    let lpUsd = 0;
    for (const [mint, amount] of lpTotals) {
      lpUsd += amount * (prices[mint] || 0);
    }
    let feeUsd = 0;
    for (const [mint, amount] of feeTotals) {
      feeUsd += amount * (prices[mint] || 0);
    }

    logger.info(MODULE, `Orca LP: $${lpUsd.toFixed(2)} + fees $${feeUsd.toFixed(2)} (${count} positions)`);
    return { lpUsd: +lpUsd.toFixed(2), feeUsd: +feeUsd.toFixed(2), count };
  }

  /**
   * Get per-mint aggregated position assets (same format as ByrealPositionExecutor.getPositionAssets).
   * Cached for 5 min.
   */
  private _lpAssetsCache: { items: Array<{ mint: string; balance: number; decimals: number; pairedStable: Record<string, number>; liquidityUsd: number }>; ts: number } | null = null;

  public async getPositionAssets(): Promise<Array<{ mint: string; balance: number; decimals: number; pairedStable: Record<string, number>; liquidityUsd: number; poolTvl?: number | null }>> {
    if (this._lpAssetsCache && Date.now() - this._lpAssetsCache.ts < 5 * 60 * 1000) {
      return this._lpAssetsCache.items;
    }

    const orcaEntries: { tgtNft: string; ourNft: string }[] = [];
    for (const [tgtNft, ourNft] of this.positionMap.entries()) {
      if (this.positionMap.getDex(tgtNft) === 'orca') {
        orcaEntries.push({ tgtNft, ourNft });
      }
    }
    if (orcaEntries.length === 0) return [];

    // Use free RPC for dashboard reads (not Alchemy)
    const { ctx: freeCtx, client: freeClient } = this.getFreeClient();

    // Aggregate per mint: balance (lp + fee), decimals, paired stable mint → amount
    const totals = new Map<string, { balance: number; decimals: number; pairedStable: Record<string, number>; liquidityUsd: number; poolTvl: number | null }>();
    const mintsNeeded = new Set<string>();

    for (const { ourNft } of orcaEntries) {
      try {
        const nftMint = new PublicKey(ourNft);
        const positionPda = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, nftMint);
        const pos = await freeClient.getPosition(positionPda.publicKey);
        if (!pos) continue;

        const posData = pos.getData();
        if (posData.liquidity.isZero()) continue;

        const pool = await freeClient.getPool(posData.whirlpool);
        const poolData = pool.getData();
        const mintAStr = poolData.tokenMintA.toBase58();
        const mintBStr = poolData.tokenMintB.toBase58();

        const tokenExtensionCtx = await TokenExtensionUtil.buildTokenExtensionContextForPool(
          freeCtx.fetcher, poolData.tokenMintA, poolData.tokenMintB,
        );

        const liqQuote = decreaseLiquidityQuoteByLiquidity(
          posData.liquidity, Percentage.fromFraction(0, 100), pos, pool, tokenExtensionCtx,
        );

        const decA = await this.getMintDecimals(poolData.tokenMintA, freeCtx.fetcher);
        const decB = await this.getMintDecimals(poolData.tokenMintB, freeCtx.fetcher);
        const lpA = parseFloat(liqQuote.tokenEstA.toString()) / Math.pow(10, decA);
        const lpB = parseFloat(liqQuote.tokenEstB.toString()) / Math.pow(10, decB);

        // Fetch pool TVL from Orca API (cached 10min)
        const poolAddr = posData.whirlpool.toBase58();
        const poolTvl = await getOrcaPoolTvl(poolAddr);

        // Aggregate mintA
        const eA = totals.get(mintAStr) || { balance: 0, decimals: decA, pairedStable: {}, liquidityUsd: 0, poolTvl: null };
        eA.balance += lpA;
        eA.pairedStable[mintBStr] = (eA.pairedStable[mintBStr] || 0) + lpB;
        if (poolTvl !== null) eA.poolTvl = poolTvl;
        totals.set(mintAStr, eA);

        // Aggregate mintB
        const eB = totals.get(mintBStr) || { balance: 0, decimals: decB, pairedStable: {}, liquidityUsd: 0, poolTvl: null };
        eB.balance += lpB;
        eB.pairedStable[mintAStr] = (eB.pairedStable[mintAStr] || 0) + lpA;
        if (poolTvl !== null) eB.poolTvl = poolTvl;
        totals.set(mintBStr, eB);

        mintsNeeded.add(mintAStr);
        mintsNeeded.add(mintBStr);
      } catch (err: any) {
        logger.debug(MODULE, `getPositionAssets: error reading ${ourNft.slice(0, 8)}: ${(err.message || '').slice(0, 80)}`);
      }
      await new Promise(r => setTimeout(r, 300));
    }

    // Fetch prices for liquidityUsd
    if (mintsNeeded.size > 0 && config.jupApiKey) {
      try {
        const res = await fetch(`https://api.jup.ag/price/v3?ids=${Array.from(mintsNeeded).join(',')}`, {
          headers: { 'x-api-key': config.jupApiKey },
        });
        if (res.ok) {
          const json = await res.json() as any;
          for (const [mint, info] of Object.entries(json || {})) {
            const p = (info as any)?.usdPrice;
            if (p) {
              const entry = totals.get(mint);
              if (entry) entry.liquidityUsd = entry.balance * parseFloat(String(p));
            }
          }
        }
      } catch { /* ignore */ }
    }

    const items = [...totals.entries()].map(([mint, d]) => ({
      mint, balance: +d.balance.toFixed(6), decimals: d.decimals, pairedStable: d.pairedStable, liquidityUsd: +d.liquidityUsd.toFixed(2), poolTvl: d.poolTvl,
    }));
    this._lpAssetsCache = { items, ts: Date.now() };
    return items;
  }

  private _decimalsCache = new Map<string, number>();
  private async getMintDecimals(mint: PublicKey, fetcher?: any): Promise<number> {
    const key = mint.toBase58();
    if (this._decimalsCache.has(key)) return this._decimalsCache.get(key)!;
    try {
      const f = fetcher || this.readCtx.fetcher;
      const mintInfo = await f.getMintInfo(mint);
      const dec = mintInfo?.decimals ?? 9;
      this._decimalsCache.set(key, dec);
      return dec;
    } catch {
      return 9;
    }
  }

  /** Manual close from dashboard — finds targetNft by ourNft, then closes. */
  async manualClosePosition(ourNftMint: string): Promise<string | null> {
    const targetNft = this.positionMap.findByOurNft(ourNftMint);
    if (!targetNft) {
      logger.warn(MODULE, `Manual close: no mapping found for our NFT ${ourNftMint.slice(0, 8)}`);
      return null;
    }
    return this.copyClosePosition(targetNft);
  }

  /** Reconcile Orca positions: check if target positions still exist, close ours if not. */
  async reconcileOrcaPositions(queue: { enqueue: (label: string, priority: 'HIGH' | 'NORMAL', fn: () => Promise<void>) => void }): Promise<void> {
    const entries = this.positionMap.entries();
    const orcaEntries: { tgtNft: string; ourNft: string }[] = [];

    for (const [tgtNft, ourNft] of entries) {
      if (this.positionMap.getDex(tgtNft) === 'orca') {
        orcaEntries.push({ tgtNft, ourNft });
      }
    }

    if (orcaEntries.length === 0) return;

    logger.info(MODULE, `Reconciling ${orcaEntries.length} Orca position mappings...`);
    const orphans: { tgtNft: string; ourNft: string }[] = [];

    for (const { tgtNft, ourNft } of orcaEntries) {
      try {
        const targetPos = await this.getPositionByNft(new PublicKey(tgtNft));
        if (!targetPos) {
          logger.info(MODULE, `Orca reconcile: target ${tgtNft.slice(0, 8)} gone, orphan detected`);
          orphans.push({ tgtNft, ourNft });
        } else if (targetPos.getData().liquidity.isZero()) {
          logger.info(MODULE, `Orca reconcile: target ${tgtNft.slice(0, 8)} liquidity=0, orphan detected`);
          orphans.push({ tgtNft, ourNft });
        }
      } catch (err: any) {
        if (this.isTransientError(err)) {
          logger.debug(MODULE, `Orca reconcile: RPC transient error for ${tgtNft.slice(0, 8)}, skipping`);
        } else {
          logger.info(MODULE, `Orca reconcile: target ${tgtNft.slice(0, 8)} lookup failed (${(err.message || '').slice(0, 80)}), treating as orphan`);
          orphans.push({ tgtNft, ourNft });
        }
      }
      await new Promise(r => setTimeout(r, 500));
    }

    if (orphans.length === 0) {
      logger.info(MODULE, 'Orca reconciliation complete: no orphans');
      return;
    }

    logger.warn(MODULE, `Found ${orphans.length} Orca orphans, enqueuing closes...`);
    for (const { tgtNft } of orphans) {
      queue.enqueue(`orca-orphan-close(${tgtNft.slice(0, 8)})`, 'NORMAL', async () => {
        try {
          await this.copyClosePosition(tgtNft);
        } catch (err: any) {
          logger.error(MODULE, `Orca orphan close failed: ${err.message}`);
        }
      });
    }
  }
}
