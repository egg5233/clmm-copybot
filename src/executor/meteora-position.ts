import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import BN from 'bn.js';
import DLMM from '@meteora-ag/dlmm';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getUserAddress, signLegacy, signLegacyWithExtra } from '../utils/wallet';
import { scaleAmount, getAmountRatio } from '../utils/ratio';
import { PositionMap } from '../state/position-map';
import { notifyOpenFailed, notifyCloseFailed, notifySolInsufficient, notifyPumpApproval, notifySwapFailed } from '../discord/notify';
import { isPumpPending, isPumpApproved, isPumpRejected, addPumpPending } from '../state/pump-pending';
import { swapForToken, getActualSwapOutput, lastSwapError, invalidateHoldingsCache } from './jupiter-swap';
import { OperationQueue } from './queue';
import { checkTokenLiquidity } from '../monitor/pool-tvl';
import * as fs from 'fs';
import * as path from 'path';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmKfrE1SBVYuL9sSMdCL3DscMVPR1YnG5';
const USDT_T22 = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

const MODULE = 'MeteoraPos';
const PENDING_FILE = './data/pending-swaps.json';

// DLMM pool cache: avoid redundant DLMM.create() calls (each = ~14 RPC requests)
const dlmmPoolCache = new Map<string, { pool: DLMM; createdAt: number }>();
const DLMM_CACHE_TTL = 30 * 60 * 1000; // 30 min — safe because bot only reads immutable fields (tokenX/Y.publicKey); SDK methods refetch internally

async function getCachedDlmmPool(connection: Connection, poolAddress: string): Promise<DLMM> {
  const key = poolAddress;
  const cached = dlmmPoolCache.get(key);
  if (cached && Date.now() - cached.createdAt < DLMM_CACHE_TTL) {
    return cached.pool;
  }
  const pool = await DLMM.create(connection, new PublicKey(poolAddress));
  dlmmPoolCache.set(key, { pool, createdAt: Date.now() });
  return pool;
}

function invalidateDlmmCache(poolAddress: string): void {
  dlmmPoolCache.delete(poolAddress);
}

// Meteora pool TVL cache: poolAddress -> { tvlUsdc, fetchedAt }
const meteoraTvlCache = new Map<string, { tvlUsdc: number; fetchedAt: number }>();
const METEORA_TVL_CACHE_MS = 10 * 60 * 1000; // 10 min

async function getMeteoraPairTvl(poolAddress: string): Promise<number | null> {
  const cached = meteoraTvlCache.get(poolAddress);
  if (cached && Date.now() - cached.fetchedAt < METEORA_TVL_CACHE_MS) return cached.tvlUsdc;

  try {
    const res = await fetch(
      `https://dlmm-api.meteora.ag/pair/all_by_groups?sort_key=tvl&order_by=desc&search_term=${poolAddress}`
    );
    if (!res.ok) return cached?.tvlUsdc ?? null;

    const data = (await res.json()) as any;
    const pairs = data?.groups?.[0]?.pairs;
    if (!Array.isArray(pairs) || pairs.length === 0) return cached?.tvlUsdc ?? null;

    const match = pairs.find((p: any) => p.address === poolAddress);
    const tvl = parseFloat(match?.tvl ?? '0');

    meteoraTvlCache.set(poolAddress, { tvlUsdc: tvl, fetchedAt: Date.now() });
    return tvl;
  } catch {
    return cached?.tvlUsdc ?? null;
  }
}

export class MeteoraPositionExecutor {
  private connection: Connection;       // Helius — TX execution + SDK ops
  private readConnection: Connection;   // Alchemy — balance/position reads
  private positionMap: PositionMap;
  private busy = false;

  public solPaused = false;
  public solPausedAt: number | null = null;
  public drawdownPaused = false;
  public drawdownPausedAt: number | null = null;
  public drawdownWarning = false;
  public lastSkipReason: string | null = null;
  public cachedSolBalance: number | null = null;
  public rentPerPosition: number = 0.00890880; // fallback, queried from RPC

  constructor(connection: Connection, positionMap: PositionMap) {
    this.connection = connection;
    this.readConnection = config.readRpcUrl
      ? new Connection(config.readRpcUrl, { commitment: 'confirmed' })
      : connection;
    this.positionMap = positionMap;

    this.getSolBalance().then(b => { this.cachedSolBalance = b; }).catch(() => {});
    logger.info(MODULE, 'MeteoraPositionExecutor initialized');
  }

  get isBusy(): boolean { return this.busy; }

  updateConnection(newConn: Connection): void {
    this.connection = newConn;
    logger.info(MODULE, 'Connection updated after reconnect');
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

  private isTokenBlacklisted(mintX: string, mintY: string): boolean {
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    if (config.meteoraSkipSol && (mintX === SOL_MINT || mintY === SOL_MINT)) return true;
    return config.tokenBlacklist.has(mintX) || config.tokenBlacklist.has(mintY);
  }

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
   * Sign and send a Transaction (or Transaction array).
   * Meteora SDK returns legacy Transaction objects.
   * SDK may set feePayer/blockhash — we fallback if missing.
   */
  private async signAndSend(txOrTxs: Transaction | Transaction[], additionalSigners?: Keypair[]): Promise<string> {
    const txs = Array.isArray(txOrTxs) ? txOrTxs : [txOrTxs];
    const userAddress = getUserAddress();
    let lastSig = '';

    for (const tx of txs) {
      if (!tx.feePayer) {
        tx.feePayer = userAddress;
      }
      if (!tx.recentBlockhash) {
        const { blockhash } = await this.connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
      }

      const signed = additionalSigners && additionalSigners.length > 0
        ? await signLegacyWithExtra(tx, additionalSigners)
        : await signLegacy(tx);

      for (let i = 0; i < config.maxRetry; i++) {
        try {
          const sig = await this.connection.sendRawTransaction(signed.serialize(), {
            skipPreflight: config.skipPreflight,
            maxRetries: 2,
          });
          const latestBlockhash = await this.connection.getLatestBlockhash();
          await this.connection.confirmTransaction({
            signature: sig,
            ...latestBlockhash,
          }, 'confirmed');

          // BUG FIX: v1.20.2 — verify meta.err after confirmTransaction
          const txResult = await this.connection.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
          if (txResult?.meta?.err) {
            throw new Error(`TX confirmed but failed on-chain: ${JSON.stringify(txResult.meta.err)}`);
          }

          lastSig = sig;
          break;
        } catch (err: any) {
          if (i === config.maxRetry - 1) throw err;
          logger.warn(MODULE, `Send attempt ${i + 1} failed: ${err.message}, retrying...`);
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }

    return lastSig;
  }

  /**
   * Resolve pool address for a target position from positionMap metadata.
   * Pool label format: "mintX/mintY@poolAddress"
   */
  private getPoolAddressForPosition(targetPos: string): string | null {
    const poolLabel = this.positionMap.getPool(targetPos);
    if (!poolLabel) return null;

    const atIdx = poolLabel.indexOf('@');
    if (atIdx > 0) {
      return poolLabel.slice(atIdx + 1);
    }

    logger.warn(MODULE, `Cannot derive pool address from label: ${poolLabel}`);
    return null;
  }

  /**
   * Resolve pool address for one of our positions (reverse lookup).
   */
  private getPoolAddressForOurPosition(ourPositionAddress: string): string | null {
    const targetNft = this.positionMap.findByOurNft(ourPositionAddress);
    if (!targetNft) return null;
    return this.getPoolAddressForPosition(targetNft);
  }

  // ===== Rent / Backfill =====

  /**
   * Query rent exemption from RPC for Meteora position accounts.
   * Position PDA (~300 bytes). No NFT mint or ATA needed.
   */
  async initRentPerPosition(): Promise<void> {
    try {
      const conn = this.readConnection;
      const rentPosition = await conn.getMinimumBalanceForRentExemption(300);
      this.rentPerPosition = rentPosition / 1e9;
      logger.info(MODULE, `Rent per position: ${this.rentPerPosition} SOL (${rentPosition} lamports)`);
    } catch (err: any) {
      logger.warn(MODULE, `Failed to query rent exemption, using fallback ${this.rentPerPosition}: ${err.message}`);
    }
  }

  backfillLockedSol(): void {
    const missing: string[] = [];
    for (const [targetNft] of this.positionMap.entries()) {
      const dex = this.positionMap.getDex(targetNft);
      if (dex === 'meteora' && this.positionMap.getLockedSol(targetNft, -1) === -1) {
        missing.push(targetNft);
      }
    }
    if (missing.length === 0) return;
    logger.info(MODULE, `Backfilling lockedSol for ${missing.length} Meteora positions (${this.rentPerPosition} SOL each)`);
    for (const targetNft of missing) {
      this.positionMap.setLockedSol(targetNft, this.rentPerPosition);
    }
    logger.info(MODULE, `Backfill lockedSol complete: ${missing.length} Meteora positions updated`);
  }

  hasMapping(targetPos: string): boolean {
    return !!this.positionMap.get(targetPos);
  }

  // ===== Core Operations =====

  async copyOpenPosition(
    targetPositionAddress: string,
    poolAddress: string,
    targetWallet: string,
  ): Promise<string | null> {
    const userAddress = getUserAddress();

    // === PHASE 0: Pre-checks ===
    if (this.positionMap.get(targetPositionAddress)) {
      logger.warn(MODULE, `Already have mapping for target position ${targetPositionAddress.slice(0, 8)}, skipping`);
      return null;
    }
    if (this.solPaused) { this.lastSkipReason = 'SOL 不足暫停'; return null; }
    if (this.drawdownPaused) { this.lastSkipReason = '回撤保護暫停'; return null; }
    if (config.meteoraCloseOnlyWallets.has(targetWallet)) {
      this.lastSkipReason = 'Close-only 錢包';
      return null;
    }
    if (config.dryRun) {
      logger.info(MODULE, '[DRY RUN] Would copy open position', { poolAddress, targetPositionAddress });
      return 'dry-run-meteora-open';
    }
    if (!this.acquire('copyOpenPosition')) return null;

    try {
      // === PHASE 1: Read target position with RPC lag retry ===
      // v1.24.4: Use dlmmPool.getPosition() (single getAccountInfo) instead of
      // getPositionsByUserAndLbPair (getProgramAccounts) to avoid RPC rate limits
      let dlmmPool: DLMM | null = null;
      let targetPosData: any = null;

      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          logger.info(MODULE, `Target position not found yet, waiting ${(attempt + 1) * 2}s (attempt ${attempt + 1}/3)...`);
          await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
        }
        try {
          dlmmPool = await getCachedDlmmPool(this.readConnection, poolAddress);
          targetPosData = await dlmmPool.getPosition(new PublicKey(targetPositionAddress));
          if (targetPosData) break;
        } catch (err: any) {
          if (attempt < 2 && this.isTransientError(err)) continue;
          if (attempt === 2) throw err;
        }
      }

      if (!targetPosData || !dlmmPool) {
        logger.error(MODULE, `Cannot read target position after retries: ${targetPositionAddress.slice(0, 8)}`);
        return null;
      }

      const mintX = dlmmPool.tokenX.publicKey;
      const mintY = dlmmPool.tokenY.publicKey;
      const mintXStr = mintX.toBase58();
      const mintYStr = mintY.toBase58();
      const poolLabel = `${mintXStr}/${mintYStr}@${poolAddress}`;
      const lowerBinId = targetPosData.positionData.lowerBinId;
      const upperBinId = targetPosData.positionData.upperBinId;

      // === PHASE 2: Filters ===

      // 2a. Token blacklist
      if (this.isTokenBlacklisted(mintXStr, mintYStr)) {
        this.lastSkipReason = '代幣黑名單';
        return null;
      }

      // 2b. Pump token filter (same tri-state as Orca)
      if (config.pumpFilterMode !== 'off') {
        const pumpMint = mintXStr.toLowerCase().includes('pump') ? mintXStr
          : mintYStr.toLowerCase().includes('pump') ? mintYStr : null;
        if (pumpMint) {
          if (!isPumpApproved(pumpMint)) {
            if (config.pumpFilterMode === 'full') {
              this.lastSkipReason = 'Pump 代幣過濾';
              return null;
            }
            if (isPumpRejected(pumpMint)) { this.lastSkipReason = 'Pump 代幣已拒絕'; return null; }
            if (!isPumpPending(pumpMint)) {
              const symbol = this.getTokenSymbol(pumpMint);
              addPumpPending({ mint: pumpMint, symbol, pool: poolLabel, targetWallet, detectedAt: Date.now() });
              notifyPumpApproval(pumpMint, symbol, poolLabel).catch(() => {});
            }
            this.lastSkipReason = 'Pump 代幣等待確認';
            return null;
          }
        }
      }

      // 2c. Pool TVL filter
      if (config.minPoolTvl > 0) {
        const STABLES = new Set([USDC, USDT_MINT, USDT_T22]);
        const checkMint = (!STABLES.has(mintXStr) && mintXStr !== NATIVE_MINT.toBase58()) ? mintXStr : mintYStr;
        const tvl = await checkTokenLiquidity(checkMint, () => getMeteoraPairTvl(poolAddress));
        if (tvl === null || tvl < config.minPoolTvl) {
          this.lastSkipReason = `TVL 不足 ($${tvl !== null ? tvl.toFixed(0) : '?'} < $${config.minPoolTvl})`;
          return null;
        }
      }

      // 2d. Duplicate bin range check
      if (this.positionMap.hasDuplicateTickRange(targetWallet, poolLabel, lowerBinId, upperBinId)) {
        this.lastSkipReason = '重複 bin range';
        return null;
      }

      // === PHASE 3: Calculate deposit amounts ===
      const targetAmountX = new BN(targetPosData.positionData.totalXAmount);
      const targetAmountY = new BN(targetPosData.positionData.totalYAmount);

      const ourTokenX = scaleAmount(targetAmountX, targetWallet);
      const ourTokenY = scaleAmount(targetAmountY, targetWallet);

      if (ourTokenX.isZero() && ourTokenY.isZero()) {
        this.lastSkipReason = '存款金額為零';
        return null;
      }

      const ratio = getAmountRatio(targetWallet);
      logger.info(MODULE, `Target amounts: X=${targetAmountX.toString()}, Y=${targetAmountY.toString()}, ratio=${ratio}`);
      logger.info(MODULE, `Our deposit target: X=${ourTokenX.toString()}, Y=${ourTokenY.toString()}`);

      // === PHASE 4: Pre-swap (acquire tokens if insufficient) ===
      // BUG FIX: v1.20.1 — invalidateHoldingsCache + re-read balance after swap
      let balanceX = await this.getTokenBalance(userAddress, mintX);
      let balanceY = await this.getTokenBalance(userAddress, mintY);
      logger.info(MODULE, `Balances before swap: X=${balanceX.toString()}, Y=${balanceY.toString()}`);

      // Swap for tokenX if deficit
      if (balanceX.lt(ourTokenX) && !ourTokenX.isZero() && mintXStr !== USDC) {
        const deficit = ourTokenX.sub(balanceX);
        logger.info(MODULE, `Need ${deficit.toString()} more of tokenX (${mintXStr})`);
        let txSig: string | null = null;

        if (mintX.equals(NATIVE_MINT)) {
          // SOL deficit: only try USDC→SOL
          txSig = await swapForToken(this.connection, USDC, mintXStr, deficit.toString());
        } else {
          // Try 1: tokenY -> tokenX (if have tokenY surplus)
          if (!balanceY.isZero()) {
            txSig = await swapForToken(this.connection, mintYStr, mintXStr, deficit.toString());
          }
          // Try 2: USDC -> tokenX
          if (!txSig) {
            txSig = await swapForToken(this.connection, USDC, mintXStr, deficit.toString());
          }
        }
        if (!txSig) {
          notifySwapFailed(mintXStr, lastSwapError || 'all methods failed');
          return null;
        }
        invalidateHoldingsCache();
        const addedX = await getActualSwapOutput(this.readConnection, txSig, mintXStr, userAddress.toBase58());
        if (addedX) {
          balanceX = balanceX.add(new BN(addedX));
        } else {
          await new Promise(r => setTimeout(r, 5000));
          balanceX = await this.getTokenBalance(userAddress, mintX);
        }
        balanceY = await this.getTokenBalance(userAddress, mintY);
      }

      // Swap for tokenY if deficit
      if (balanceY.lt(ourTokenY) && !ourTokenY.isZero() && mintYStr !== USDC) {
        const deficit = ourTokenY.sub(balanceY);
        logger.info(MODULE, `Need ${deficit.toString()} more of tokenY (${mintYStr})`);
        let txSig: string | null = null;

        if (mintY.equals(NATIVE_MINT)) {
          // SOL deficit: only try USDC→SOL
          txSig = await swapForToken(this.connection, USDC, mintYStr, deficit.toString());
        } else {
          txSig = await swapForToken(this.connection, USDC, mintYStr, deficit.toString());
          // BUG FIX: v1.20.1 — surplus-only last-resort swap
          if (!txSig && balanceX.gt(ourTokenX)) {
            txSig = await swapForToken(this.connection, mintXStr, mintYStr, deficit.toString());
          }
        }
        if (!txSig) {
          notifySwapFailed(mintYStr, lastSwapError || 'all methods failed');
          return null;
        }
        invalidateHoldingsCache();
        const addedY = await getActualSwapOutput(this.readConnection, txSig, mintYStr, userAddress.toBase58());
        if (addedY) {
          balanceY = balanceY.add(new BN(addedY));
        } else {
          await new Promise(r => setTimeout(r, 5000));
          balanceY = await this.getTokenBalance(userAddress, mintY);
        }
      }

      if (balanceX.isZero() && balanceY.isZero()) {
        logger.error(MODULE, 'No token balance for either side after swaps, cannot open position');
        return null;
      }

      // === PHASE 5: Open position with retry ===
      const MAX_OPEN_ATTEMPTS = 2;
      const binCount = upperBinId - lowerBinId + 1;
      const LARGE_BIN_THRESHOLD = 70; // DEFAULT_BIN_PER_POSITION in SDK

      for (let openAttempt = 0; openAttempt < MAX_OPEN_ATTEMPTS; openAttempt++) {
        if (openAttempt > 0) {
          logger.info(MODULE, `Retrying open (attempt ${openAttempt + 1}/${MAX_OPEN_ATTEMPTS}), re-reading balances...`);
          await new Promise(r => setTimeout(r, 2000));
          balanceX = await this.getTokenBalance(userAddress, mintX);
          balanceY = await this.getTokenBalance(userAddress, mintY);
        }

        // BUG FIX: v1.20.2 — cap tokenMax: BN.min(target, balance)
        // BUG FIX: v1.20.8 — LiquidityZero: when one token is 0, use wallet balance
        const tokenMaxX = ourTokenX.isZero() && !ourTokenY.isZero()
          ? balanceX : BN.min(ourTokenX, balanceX);
        const tokenMaxY = ourTokenY.isZero() && !ourTokenX.isZero()
          ? balanceY : BN.min(ourTokenY, balanceY);

        logger.info(MODULE, `Position params: bins=[${lowerBinId}, ${upperBinId}] (${binCount} bins${binCount > LARGE_BIN_THRESHOLD ? ', multi-TX' : ''})`, {
          tokenMaxX: tokenMaxX.toString(),
          tokenMaxY: tokenMaxY.toString(),
        });

        try {
          const newPositionKp = Keypair.generate();
          let txSig: string;

          if (binCount <= LARGE_BIN_THRESHOLD) {
            // Small position: single-TX via initializePosition (v1)
            const createPositionTx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
              positionPubKey: newPositionKp.publicKey,
              user: userAddress,
              totalXAmount: tokenMaxX,
              totalYAmount: tokenMaxY,
              strategy: {
                maxBinId: upperBinId,
                minBinId: lowerBinId,
                strategyType: 0, // Spot strategy
              },
            });
            txSig = await this.signAndSend(createPositionTx, [newPositionKp]);

          } else {
            // v1.24.5: Large position — multi-TX via initializePosition2 + increasePositionLength2
            // Avoids CPI realloc limit of 10,240 bytes per inner instruction
            const pool = dlmmPool as any;
            const MAX_RESIZE = 91; // MAX_RESIZE_LENGTH in SDK
            const MAX_BIN_ARRAY_SIZE = 512;

            // Step 1: Compute bin array indexes needed
            const binIdToArrayIdx = (id: number) => {
              const div = Math.trunc(id / MAX_BIN_ARRAY_SIZE);
              const mod = id % MAX_BIN_ARRAY_SIZE;
              return id < 0 && mod !== 0 ? div - 1 : div;
            };
            const lowerIdx = binIdToArrayIdx(lowerBinId);
            const upperIdx = binIdToArrayIdx(upperBinId);
            const binArrayIndexes: BN[] = [];
            for (let i = lowerIdx; i <= upperIdx; i++) {
              binArrayIndexes.push(new BN(i));
            }

            // Step 2: Build init TX — bin arrays + initPosition2 + extends
            const initTx = new Transaction();

            // Create bin arrays if needed (private SDK method, cast to any)
            const binArrayIxs = await pool.createBinArraysIfNeeded(binArrayIndexes, userAddress);
            if (binArrayIxs.length > 0) {
              initTx.add(...binArrayIxs);
              logger.info(MODULE, `Creating ${binArrayIxs.length} bin array(s)`);
            }

            // initializePosition2: creates position with initial width (up to 70 bins)
            const initialWidth = Math.min(binCount, LARGE_BIN_THRESHOLD);
            const initIx = await pool.program.methods
              .initializePosition2(lowerBinId, initialWidth)
              .accountsPartial({
                position: newPositionKp.publicKey,
                lbPair: pool.pubkey,
                owner: userAddress,
                payer: userAddress,
              })
              .instruction();
            initTx.add(initIx);

            // increasePositionLength2: extend position to full range
            let currentEnd = lowerBinId + initialWidth - 1;
            let extendCount = 0;
            while (currentEnd < upperBinId) {
              currentEnd = Math.min(currentEnd + MAX_RESIZE, upperBinId);
              const extendIx = await pool.program.methods
                .increasePositionLength2(currentEnd)
                .accountsPartial({
                  lbPair: pool.pubkey,
                  position: newPositionKp.publicKey,
                  funder: userAddress,
                  owner: userAddress,
                })
                .instruction();
              initTx.add(extendIx);
              extendCount++;
            }

            logger.info(MODULE, `Multi-TX: init(${initialWidth}) + ${extendCount} extend(s) → ${binCount} bins`);
            const initSig = await this.signAndSend(initTx, [newPositionKp]);
            const initOk = await this.verifyTxSuccess(initSig);
            if (!initOk) {
              throw new Error(`Init position TX failed on-chain: ${initSig}`);
            }
            logger.info(MODULE, `Position created: ${initSig}`);

            // Step 3: Add liquidity via chunkable method
            const addLiqTxs = await dlmmPool.addLiquidityByStrategyChunkable({
              positionPubKey: newPositionKp.publicKey,
              totalXAmount: tokenMaxX,
              totalYAmount: tokenMaxY,
              strategy: {
                maxBinId: upperBinId,
                minBinId: lowerBinId,
                strategyType: 0,
              },
              user: userAddress,
              slippage: 2,
            });

            logger.info(MODULE, `Adding liquidity in ${addLiqTxs.length} TX(s)...`);
            txSig = '';
            for (const liqTx of addLiqTxs) {
              txSig = await this.signAndSend(liqTx);
            }
          }

          // BUG FIX: v1.20.4 — write mapping BEFORE verifying (orphan recovery)
          this.positionMap.set(
            targetPositionAddress,
            newPositionKp.publicKey.toBase58(),
            poolLabel,
            targetWallet,
            lowerBinId,
            upperBinId,
            'meteora',
          );
          this.positionMap.setLockedSol(targetPositionAddress, this.rentPerPosition);

          // Store target liquidity at open time for partial decrease tracking
          try {
            const targetTotalLiq = new BN(targetPosData.positionData.totalXAmount)
              .add(new BN(targetPosData.positionData.totalYAmount));
            this.positionMap.setTargetLiquidity(targetPositionAddress, targetTotalLiq.toString());
            logger.debug(MODULE, `Stored targetLiquidity at open: ${targetTotalLiq.toString()}`);
          } catch { /* non-critical */ }

          const success = await this.verifyTxSuccess(txSig);
          if (!success) {
            logger.error(MODULE, `Open TX failed on-chain: ${txSig.slice(0, 8)}, deleting mapping`);
            this.positionMap.delete(targetPositionAddress);
            if (openAttempt < MAX_OPEN_ATTEMPTS - 1) continue;
            return null;
          }

          logger.info(MODULE, `Position opened: ${txSig} (pos=${newPositionKp.publicKey.toBase58().slice(0, 8)})`);
          return txSig;

        } catch (openErr: any) {
          if (openAttempt < MAX_OPEN_ATTEMPTS - 1 && (this.isRetryableSimError(openErr) || this.isTransientError(openErr))) {
            logger.warn(MODULE, `Open attempt ${openAttempt + 1} failed (${(openErr.message || '').slice(0, 100)}), will retry...`);
            continue;
          }
          throw openErr;
        }
      }
      return null;

    } catch (err: any) {
      logger.error(MODULE, `Open position failed: ${err.message}`);
      notifyOpenFailed(err, targetPositionAddress);
      if (/insufficient lamports/i.test(err.message)) {
        this.solPaused = true;
        this.solPausedAt = Date.now();
        logger.error(MODULE, 'SOL 不足，已暫停開倉/加倉');
        notifySolInsufficient(this.cachedSolBalance ?? 0);
      }
      return null;
    } finally {
      // === PHASE 6: Cleanup ===
      this.release();
      this.getSolBalance().then(b => { this.cachedSolBalance = b; }).catch(() => {});
    }
  }

  async copyClosePosition(targetPositionAddress: string): Promise<string | null> {
    const myPositionAddress = this.positionMap.get(targetPositionAddress);
    if (!myPositionAddress) {
      logger.warn(MODULE, `No mapped position for target: ${targetPositionAddress.slice(0, 8)}`);
      return null;
    }

    logger.info(MODULE, `Closing position: ${myPositionAddress.slice(0, 8)}...`);
    if (config.dryRun) {
      logger.info(MODULE, '[DRY RUN] Would close position', { myPositionAddress });
      return 'dry-run-meteora-close';
    }
    if (!this.acquire('copyClosePosition')) return null;

    try {
      const userAddress = getUserAddress();
      let lastTxSig: string | null = null;

      const MAX_CLOSE_ATTEMPTS = 3;
      for (let attempt = 0; attempt < MAX_CLOSE_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          logger.info(MODULE, `Retrying close (attempt ${attempt + 1}/${MAX_CLOSE_ATTEMPTS})...`);
          await new Promise(r => setTimeout(r, 2000));
        }

        try {
          const poolAddress = this.getPoolAddressForPosition(targetPositionAddress);
          if (!poolAddress) {
            logger.error(MODULE, 'Cannot determine pool address for position');
            this.positionMap.delete(targetPositionAddress);
            return null;
          }

          const dlmmPool = await getCachedDlmmPool(this.readConnection, poolAddress);

          // v1.24.6: Use getPosition (3-5 RPC) instead of getPositionsByUserAndLbPair (5-16+ RPC)
          // CRITICAL: distinguish 429/transient errors from "position genuinely gone"
          let ourPosData: any;
          try {
            ourPosData = await dlmmPool.getPosition(new PublicKey(myPositionAddress));
          } catch (err: any) {
            const msg = err?.message || '';
            // SDK throws "Position account ... not found" when getAccountInfo returns null
            if (msg.includes('not found')) {
              logger.warn(MODULE, `Position confirmed closed on-chain: ${myPositionAddress}, deleting mapping`);
              this.positionMap.delete(targetPositionAddress);
              return null;
            }
            // Transient error (429, timeout, etc.) → do NOT delete mapping, throw to trigger retry
            invalidateDlmmCache(poolAddress);
            throw err;
          }

          // Step 1: Remove ALL liquidity
          // removeLiquidity uses fromBinId/toBinId (NOT binIds array)
          // Returns Transaction[]
          const removeTxs = await dlmmPool.removeLiquidity({
            position: new PublicKey(myPositionAddress),
            user: userAddress,
            fromBinId: ourPosData.positionData.lowerBinId,
            toBinId: ourPosData.positionData.upperBinId,
            bps: new BN(10000), // 100% = full removal
          });

          for (const tx of removeTxs) {
            const sig = await this.signAndSend(tx);
            logger.info(MODULE, `Remove liquidity TX: ${sig}`);
            lastTxSig = sig;
          }

          // Step 2: Close position account (reclaim rent)
          // closePosition needs the full LbPosition object
          const closeTx = await dlmmPool.closePosition({
            owner: userAddress,
            position: ourPosData as { publicKey: PublicKey; positionData: any; version: any },
          });
          const closeSig = await this.signAndSend(closeTx);
          logger.info(MODULE, `Close position TX: ${closeSig}`);
          lastTxSig = closeSig;

        } catch (closeErr: any) {
          if (attempt < MAX_CLOSE_ATTEMPTS - 1 && (this.isRetryableSimError(closeErr) || this.isTransientError(closeErr))) {
            logger.warn(MODULE, `Close attempt ${attempt + 1} failed (${(closeErr.message || '').slice(0, 100)}), will retry...`);
            continue;
          }
          throw closeErr;
        }

        if (!lastTxSig) return null;

        // BUG FIX: v1.20.2 — verify TX actually succeeded on-chain
        const success = await this.verifyTxSuccess(lastTxSig);
        if (success) break;

        if (attempt < MAX_CLOSE_ATTEMPTS - 1) {
          logger.warn(MODULE, `Close TX failed on-chain: ${lastTxSig.slice(0, 8)}, retrying...`);
          lastTxSig = null;
          continue;
        }
        logger.error(MODULE, `Close TX failed after ${MAX_CLOSE_ATTEMPTS} attempts, keeping mapping`);
        notifyCloseFailed(myPositionAddress, 'on-chain failure after max attempts', MAX_CLOSE_ATTEMPTS);
        return null;
      }

      if (!lastTxSig) return null;

      // Post-close: delete mapping
      logger.info(MODULE, `Position closed: ${myPositionAddress.slice(0, 8)} TX: ${lastTxSig}`);
      this.positionMap.delete(targetPositionAddress);

      // BUG FIX: v1.20.2 — parse TX for received tokens -> queue as pending swaps
      const received = await this.parseTxTokenChanges(lastTxSig, userAddress);
      for (const { mint, amount } of received) {
        logger.info(MODULE, `Received from close: ${mint.toBase58().slice(0, 8)}... = ${amount.toString()}`);
        this.addPendingSwap(mint, amount);
      }

      return lastTxSig;

    } catch (err: any) {
      logger.error(MODULE, `Close position failed: ${typeof err?.message === 'string' ? err.message : JSON.stringify(err)}`);
      notifyCloseFailed(myPositionAddress, err, 0);
      return null;
    } finally {
      this.release();
    }
  }

  async copyAddLiquidity(
    targetPositionAddress: string,
    targetWallet: string,
  ): Promise<string | null> {
    const myPositionAddress = this.positionMap.get(targetPositionAddress);
    if (!myPositionAddress) {
      logger.warn(MODULE, `No mapped position for target: ${targetPositionAddress.slice(0, 8)}`);
      return null;
    }
    if (this.solPaused || this.drawdownPaused) {
      logger.info(MODULE, `[ADD] Skipped — paused`);
      return null;
    }
    if (config.meteoraCloseOnlyWallets.has(targetWallet)) {
      logger.info(MODULE, `[ADD] Skipped — close-only wallet`);
      return null;
    }
    if (config.dryRun) {
      return 'dry-run-meteora-add';
    }
    if (!this.acquire('copyAddLiquidity')) return null;

    try {
      const userAddress = getUserAddress();

      // BUG FIX: v1.20.9 — 2s initial delay (freshly detected increase TX may not be on-chain)
      await new Promise(r => setTimeout(r, 2000));

      const poolAddress = this.getPoolAddressForPosition(targetPositionAddress);
      if (!poolAddress) return null;

      const dlmmPool = await getCachedDlmmPool(this.readConnection, poolAddress);
      const mintX = dlmmPool.tokenX.publicKey;
      const mintY = dlmmPool.tokenY.publicKey;
      const mintXStr = mintX.toBase58();
      const mintYStr = mintY.toBase58();

      const mapEntry = this.positionMap.toJSON()[targetPositionAddress];
      const targetWalletAddr = mapEntry?.targetWallet || targetWallet;

      let deltaX!: BN;
      let deltaY!: BN;
      let ourPosLowerBinId = 0;
      let ourPosUpperBinId = 0;

      // BUG FIX: v1.20.9 — retry if delta <= 0 (RPC lag: target not updated yet)
      for (let readAttempt = 0; readAttempt < 2; readAttempt++) {
        if (readAttempt > 0) {
          logger.info(MODULE, 'Delta <= 0 after detecting add TX, waiting 3s for RPC...');
          await new Promise(r => setTimeout(r, 3000));
        }

        const targetPositions = await dlmmPool.getPositionsByUserAndLbPair(
          new PublicKey(targetWalletAddr)
        );
        const targetPos = targetPositions.userPositions.find(
          (p: any) => p.publicKey.toBase58() === targetPositionAddress
        );
        if (!targetPos) {
          logger.warn(MODULE, 'Cannot read target position for add');
          return null;
        }

        const targetAmountX = scaleAmount(new BN(targetPos.positionData.totalXAmount), targetWallet);
        const targetAmountY = scaleAmount(new BN(targetPos.positionData.totalYAmount), targetWallet);

        const ourPositions = await dlmmPool.getPositionsByUserAndLbPair(userAddress);
        const ourPos = ourPositions.userPositions.find(
          (p: any) => p.publicKey.toBase58() === myPositionAddress
        );
        if (!ourPos) {
          logger.warn(MODULE, 'Cannot read our position for add');
          return null;
        }

        ourPosLowerBinId = ourPos.positionData.lowerBinId;
        ourPosUpperBinId = ourPos.positionData.upperBinId;

        deltaX = targetAmountX.sub(new BN(ourPos.positionData.totalXAmount));
        deltaY = targetAmountY.sub(new BN(ourPos.positionData.totalYAmount));

        if (deltaX.gt(new BN(0)) || deltaY.gt(new BN(0))) break;
      }

      if (deltaX.lte(new BN(0)) && deltaY.lte(new BN(0))) {
        logger.info(MODULE, 'Our position already matches or exceeds target, no add needed');
        return null;
      }

      logger.info(MODULE, `Add: deltaX=${deltaX.toString()}, deltaY=${deltaY.toString()}`);

      const increaseX = deltaX.gt(new BN(0)) ? deltaX : new BN(0);
      const increaseY = deltaY.gt(new BN(0)) ? deltaY : new BN(0);
      let balanceX = await this.getTokenBalance(userAddress, mintX);
      let balanceY = await this.getTokenBalance(userAddress, mintY);

      // Pre-swap for tokenX
      if (balanceX.lt(increaseX) && !increaseX.isZero() && mintXStr !== USDC) {
        const deficit = increaseX.sub(balanceX);
        logger.info(MODULE, `Need ${deficit.toString()} more of tokenX (${mintXStr})`);
        let txSig: string | null = null;
        if (mintX.equals(NATIVE_MINT)) {
          txSig = await swapForToken(this.connection, USDC, mintXStr, deficit.toString());
        } else {
          if (!balanceY.isZero()) {
            txSig = await swapForToken(this.connection, mintYStr, mintXStr, deficit.toString());
          }
          if (!txSig) {
            txSig = await swapForToken(this.connection, USDC, mintXStr, deficit.toString());
          }
        }
        if (!txSig) {
          notifySwapFailed(mintXStr, lastSwapError || 'all methods failed');
          return null;
        }
        invalidateHoldingsCache();
        const addedX = await getActualSwapOutput(this.readConnection, txSig, mintXStr, userAddress.toBase58());
        if (addedX) { balanceX = balanceX.add(new BN(addedX)); } else {
          await new Promise(r => setTimeout(r, 5000));
          balanceX = await this.getTokenBalance(userAddress, mintX);
        }
        balanceY = await this.getTokenBalance(userAddress, mintY);
      }

      // Pre-swap for tokenY
      if (balanceY.lt(increaseY) && !increaseY.isZero() && mintYStr !== USDC) {
        const deficit = increaseY.sub(balanceY);
        logger.info(MODULE, `Need ${deficit.toString()} more of tokenY (${mintYStr})`);
        let txSig: string | null = null;
        if (mintY.equals(NATIVE_MINT)) {
          txSig = await swapForToken(this.connection, USDC, mintYStr, deficit.toString());
        } else {
          txSig = await swapForToken(this.connection, USDC, mintYStr, deficit.toString());
          if (!txSig && balanceX.gt(increaseX)) {
            txSig = await swapForToken(this.connection, mintXStr, mintYStr, deficit.toString());
          }
        }
        if (!txSig) {
          notifySwapFailed(mintYStr, lastSwapError || 'all methods failed');
          return null;
        }
        invalidateHoldingsCache();
        const addedY = await getActualSwapOutput(this.readConnection, txSig, mintYStr, userAddress.toBase58());
        if (addedY) { balanceY = balanceY.add(new BN(addedY)); } else {
          await new Promise(r => setTimeout(r, 5000));
          balanceY = await this.getTokenBalance(userAddress, mintY);
        }
      }

      // Add liquidity with retry
      const MAX_ADD_ATTEMPTS = 2;
      for (let addAttempt = 0; addAttempt < MAX_ADD_ATTEMPTS; addAttempt++) {
        if (addAttempt > 0) {
          await new Promise(r => setTimeout(r, 2000));
          balanceX = await this.getTokenBalance(userAddress, mintX);
          balanceY = await this.getTokenBalance(userAddress, mintY);
        }

        // BUG FIX: v1.20.2 — cap tokenMax: BN.min(delta, balance)
        // BUG FIX: v1.20.8 — LiquidityZero: when one delta is 0, use balance
        const tokenMaxX = increaseX.isZero() && !increaseY.isZero()
          ? balanceX : BN.min(increaseX, balanceX);
        const tokenMaxY = increaseY.isZero() && !increaseX.isZero()
          ? balanceY : BN.min(increaseY, balanceY);

        try {
          const addTx = await dlmmPool.addLiquidityByStrategy({
            positionPubKey: new PublicKey(myPositionAddress),
            user: userAddress,
            totalXAmount: tokenMaxX,
            totalYAmount: tokenMaxY,
            strategy: {
              maxBinId: ourPosUpperBinId,
              minBinId: ourPosLowerBinId,
              strategyType: 0, // Spot
            },
            slippage: 2,
          });

          const txSig = await this.signAndSend(addTx);
          logger.info(MODULE, `Add liquidity TX: ${txSig}`);

          // Update stored targetLiquidity so partial decrease calculations remain correct
          try {
            const targetPositions = await dlmmPool.getPositionsByUserAndLbPair(new PublicKey(targetWalletAddr));
            const updatedTargetPos = targetPositions.userPositions.find(
              (p: any) => p.publicKey.toBase58() === targetPositionAddress
            );
            if (updatedTargetPos) {
              const newTargetLiq = new BN(updatedTargetPos.positionData.totalXAmount)
                .add(new BN(updatedTargetPos.positionData.totalYAmount));
              this.positionMap.setTargetLiquidity(targetPositionAddress, newTargetLiq.toString());
              logger.debug(MODULE, `Updated targetLiquidity after add: ${newTargetLiq.toString()}`);
            }
          } catch { /* non-critical */ }

          return txSig;

        } catch (addErr: any) {
          if (addAttempt < MAX_ADD_ATTEMPTS - 1 && (this.isRetryableSimError(addErr) || this.isTransientError(addErr))) {
            logger.warn(MODULE, `Add attempt ${addAttempt + 1} failed, retrying...`);
            continue;
          }
          throw addErr;
        }
      }
      return null;

    } catch (err: any) {
      logger.error(MODULE, `Add liquidity failed: ${err.message}`);
      return null;
    } finally {
      this.release();
    }
  }

  async copyRemoveLiquidity(
    targetPositionAddress: string,
  ): Promise<{ txSig: string; type: string } | null> {
    const myPositionAddress = this.positionMap.get(targetPositionAddress);
    if (!myPositionAddress) {
      logger.warn(MODULE, `No mapped position for target: ${targetPositionAddress.slice(0, 8)}`);
      return null;
    }
    if (!this.acquire('copyRemoveLiquidity')) return null;

    try {
      const userAddress = getUserAddress();
      const poolAddress = this.getPoolAddressForPosition(targetPositionAddress);
      if (!poolAddress) return null;

      const dlmmPool = await getCachedDlmmPool(this.readConnection, poolAddress);

      // Read target position to determine type (partial vs full)
      const mapEntry = this.positionMap.toJSON()[targetPositionAddress];
      const targetWalletAddr = mapEntry?.targetWallet;
      let targetCurrentLiq: BN | null = null;

      if (targetWalletAddr) {
        try {
          const targetPositions = await dlmmPool.getPositionsByUserAndLbPair(new PublicKey(targetWalletAddr));
          const targetPos = targetPositions.userPositions.find(
            (p: any) => p.publicKey.toBase58() === targetPositionAddress
          );
          if (targetPos) {
            targetCurrentLiq = new BN(targetPos.positionData.totalXAmount)
              .add(new BN(targetPos.positionData.totalYAmount));
          }
        } catch { /* target position may be closed already — treat as full remove */ }
      }

      // Determine remove BPS by comparing target's current vs stored liquidity
      let removeBps: number | null = null; // null = full remove (10000 bps)

      if (targetCurrentLiq && !targetCurrentLiq.isZero()) {
        const storedLiqStr = this.positionMap.getTargetLiquidity(targetPositionAddress);
        if (storedLiqStr) {
          const storedLiq = new BN(storedLiqStr);
          if (targetCurrentLiq.lt(storedLiq)) {
            // Partial decrease — calculate BPS removed relative to stored baseline
            const removedLiq = storedLiq.sub(targetCurrentLiq);
            removeBps = removedLiq.mul(new BN(10000)).div(storedLiq).toNumber();
            if (removeBps <= 0) removeBps = 0;
            if (removeBps > 10000) removeBps = 10000;
            logger.info(MODULE, `Partial decrease detected: target ${storedLiq.toString()} -> ${targetCurrentLiq.toString()} (${removeBps / 100}%)`);

            // Update stored target liquidity for next decrease
            this.positionMap.setTargetLiquidity(targetPositionAddress, targetCurrentLiq.toString());
          } else {
            // Target liquidity >= stored — likely fee collection only (increase happened?)
            logger.info(MODULE, `Target liquidity ${targetCurrentLiq.toString()} >= stored ${storedLiq.toString()}, collecting fees`);
            removeBps = 0;
          }
        } else {
          // No stored liquidity (legacy position) — safe fallback to fee collection
          logger.info(MODULE, `No stored targetLiquidity for ${targetPositionAddress}, collecting fees (legacy position)`);
          removeBps = 0;
        }
      }
      // targetCurrentLiq is null or zero → full remove (removeBps stays null)

      // Fee collection only (removeBps is 0)
      if (removeBps === 0) {
        logger.info(MODULE, 'Fee collection only (no liquidity decrease)');
        const MAX_FEE_ATTEMPTS = 2;
        for (let attempt = 0; attempt < MAX_FEE_ATTEMPTS; attempt++) {
          try {
            const feePositions = await dlmmPool.getPositionsByUserAndLbPair(userAddress);
            const feePosObj = feePositions.userPositions.find(
              (p: any) => p.publicKey.toBase58() === myPositionAddress
            );
            if (!feePosObj) {
              logger.warn(MODULE, 'Position not found for fee collection');
              return null;
            }
            // claimAllSwapFee (NOT claimAllFees!)
            const feeTxs = await dlmmPool.claimAllSwapFee({
              owner: userAddress,
              positions: [feePosObj],
            });
            const txArray = Array.isArray(feeTxs) ? feeTxs : [feeTxs];
            let lastSig = '';
            for (const tx of txArray) {
              lastSig = await this.signAndSend(tx);
            }
            if (lastSig) return { txSig: lastSig, type: 'COLLECT_FEE' };
          } catch (err: any) {
            if (attempt < MAX_FEE_ATTEMPTS - 1 && this.isTransientError(err)) continue;
            throw err;
          }
        }
        return null;
      }

      // Partial or full decrease
      const actualBps = removeBps ?? 10000;
      const isPartial = removeBps !== null && removeBps < 10000;
      logger.info(MODULE, `${isPartial ? 'Partial' : 'Full'} decrease: bps=${actualBps} for position ${myPositionAddress}`);

      const MAX_DECREASE_ATTEMPTS = 2;
      for (let attempt = 0; attempt < MAX_DECREASE_ATTEMPTS; attempt++) {
        try {
          const ourPositions = await dlmmPool.getPositionsByUserAndLbPair(userAddress);
          const ourPos = ourPositions.userPositions.find(
            (p: any) => p.publicKey.toBase58() === myPositionAddress
          );
          if (!ourPos) {
            logger.warn(MODULE, 'Our position not found for decrease');
            return null;
          }

          const removeTxs = await dlmmPool.removeLiquidity({
            position: new PublicKey(myPositionAddress),
            user: userAddress,
            fromBinId: ourPos.positionData.lowerBinId,
            toBinId: ourPos.positionData.upperBinId,
            bps: new BN(actualBps),
          });

          const txArray = Array.isArray(removeTxs) ? removeTxs : [removeTxs];
          let lastSig = '';
          for (const tx of txArray) {
            lastSig = await this.signAndSend(tx);
          }

          if (lastSig) {
            // Queue pending swaps for received tokens from partial/full decrease
            try {
              const received = await this.parseTxTokenChanges(lastSig, userAddress);
              for (const { mint, amount } of received) {
                logger.info(MODULE, `Received from decrease: ${mint.toBase58()} = ${amount.toString()}`);
                this.addPendingSwap(mint, amount);
              }
            } catch { /* non-critical */ }

            return { txSig: lastSig, type: 'DECREASE' };
          }

        } catch (err: any) {
          if (attempt < MAX_DECREASE_ATTEMPTS - 1 && this.isTransientError(err)) continue;
          throw err;
        }
      }
      return null;

    } catch (err: any) {
      logger.error(MODULE, `Remove liquidity failed: ${err.message}`);
      return null;
    } finally {
      this.release();
    }
  }

  async collectFees(ourPositionAddress: string): Promise<string | null> {
    if (config.dryRun) {
      logger.info(MODULE, '[DRY RUN] Would collect fees', { ourPositionAddress });
      return 'dry-run-meteora-fee';
    }
    if (!this.acquire('collectFees')) return null;

    try {
      const userAddress = getUserAddress();
      const poolAddress = this.getPoolAddressForOurPosition(ourPositionAddress);
      if (!poolAddress) return null;

      const dlmmPool = await getCachedDlmmPool(this.readConnection, poolAddress);

      // Need LbPosition object for claimAllSwapFee
      const allPositions = await dlmmPool.getPositionsByUserAndLbPair(userAddress);
      const posObj = allPositions.userPositions.find(
        (p: any) => p.publicKey.toBase58() === ourPositionAddress
      );
      if (!posObj) {
        logger.warn(MODULE, `Position not found for fee collection: ${ourPositionAddress.slice(0, 8)}`);
        return null;
      }

      // claimAllSwapFee (NOT claimAllFees!)
      const claimTxs = await dlmmPool.claimAllSwapFee({
        owner: userAddress,
        positions: [posObj],
      });

      const txArray = Array.isArray(claimTxs) ? claimTxs : [claimTxs];
      let lastSig = '';
      for (const tx of txArray) {
        lastSig = await this.signAndSend(tx);
        logger.info(MODULE, `Fee claim TX: ${lastSig}`);
      }

      return lastSig || null;

    } catch (err: any) {
      logger.error(MODULE, `Fee collection failed: ${err.message}`);
      return null;
    } finally {
      this.release();
    }
  }

  // ===== Dashboard / Manual / Reconcile =====

  async manualClosePosition(ourPositionAddress: string): Promise<string | null> {
    const targetNft = this.positionMap.findByOurNft(ourPositionAddress);
    if (!targetNft) {
      logger.warn(MODULE, `Manual close: no mapping found for our position ${ourPositionAddress.slice(0, 8)}`);
      return null;
    }
    return this.copyClosePosition(targetNft);
  }

  async isMeteoraPosition(positionAddress: string): Promise<boolean> {
    for (const [tgtNft, ourNft] of this.positionMap.entries()) {
      if (tgtNft === positionAddress) {
        if (this.positionMap.getDex(tgtNft) === 'meteora') return true;
      }
    }
    return false;
  }

  async reconcileMeteoraPositions(_opQueue: OperationQueue): Promise<void> {
    const allEntries = this.positionMap.toJSON();
    const meteoraEntries = Object.entries(allEntries).filter(([_, e]) => (e as any).dex === 'meteora');

    if (meteoraEntries.length === 0) return;
    logger.info(MODULE, `Reconciling ${meteoraEntries.length} Meteora positions...`);

    // v1.24.8: Lightweight reconcile — single getAccountInfo per position
    // instead of heavy DLMM.create + getPositionsByUserAndLbPair (11-16 RPC calls → 1)
    for (const [targetPos, entry] of meteoraEntries) {
      try {
        const acct = await this.readConnection.getAccountInfo(new PublicKey(entry.ourNft));
        if (!acct) {
          logger.warn(MODULE, `Orphan: position ${entry.ourNft.slice(0, 8)} no longer exists on-chain, removing mapping`);
          this.positionMap.delete(targetPos);
        }
        await new Promise(r => setTimeout(r, 200));
      } catch (err: any) {
        if (this.isTransientError(err)) {
          logger.debug(MODULE, `Reconcile skipped ${targetPos.slice(0, 8)}: transient error`);
          continue;
        }
        logger.warn(MODULE, `Reconcile error for ${targetPos.slice(0, 8)}: ${err.message}`);
      }
    }
  }

  // ===== LP Value / Assets =====

  private _decimalsCache = new Map<string, number>();
  private async getMintDecimals(mint: PublicKey): Promise<number> {
    const key = mint.toBase58();
    if (this._decimalsCache.has(key)) return this._decimalsCache.get(key)!;
    try {
      const info = await this.readConnection.getParsedAccountInfo(mint);
      const parsed = (info.value?.data as any)?.parsed;
      const dec = parsed?.info?.decimals ?? 9;
      this._decimalsCache.set(key, dec);
      return dec;
    } catch {
      return 9;
    }
  }

  /**
   * Get total USD value of all Meteora LP positions.
   * Returns a single number (lpUsd + feeUsd) for asset-trend compatibility.
   */
  async getMeteoraLpValueUsd(): Promise<number> {
    const details = await this.getMeteoraLpDetails();
    return details.lpUsd + details.feeUsd;
  }

  /**
   * Detailed LP value breakdown: lpUsd, feeUsd, count.
   */
  async getMeteoraLpDetails(): Promise<{ lpUsd: number; feeUsd: number; count: number }> {
    let totalLpUsd = 0;
    let totalFeeUsd = 0;
    let count = 0;

    const allEntries = this.positionMap.toJSON();
    const meteoraEntries = Object.entries(allEntries).filter(([_, e]) => (e as any).dex === 'meteora');
    if (meteoraEntries.length === 0) return { lpUsd: 0, feeUsd: 0, count: 0 };

    const lpTotals = new Map<string, number>();
    const feeTotals = new Map<string, number>();
    const mintsNeeded = new Set<string>();

    for (const [targetPos, entry] of meteoraEntries) {
      try {
        const poolAddress = this.getPoolAddressForPosition(targetPos);
        if (!poolAddress) continue;

        const dlmmPool = await getCachedDlmmPool(this.readConnection, poolAddress);
        // v1.24.5: Use getPosition (single getAccountInfo) instead of getPositionsByUserAndLbPair (getProgramAccounts)
        const ourPos = await dlmmPool.getPosition(new PublicKey(entry.ourNft));
        if (!ourPos) continue;

        const mintXStr = dlmmPool.tokenX.publicKey.toBase58();
        const mintYStr = dlmmPool.tokenY.publicKey.toBase58();
        const decX = await this.getMintDecimals(dlmmPool.tokenX.publicKey);
        const decY = await this.getMintDecimals(dlmmPool.tokenY.publicKey);

        const lpX = parseFloat(ourPos.positionData.totalXAmount.toString()) / Math.pow(10, decX);
        const lpY = parseFloat(ourPos.positionData.totalYAmount.toString()) / Math.pow(10, decY);

        lpTotals.set(mintXStr, (lpTotals.get(mintXStr) || 0) + lpX);
        lpTotals.set(mintYStr, (lpTotals.get(mintYStr) || 0) + lpY);

        // Fee value with overflow guard (BUG FIX: v1.20.6)
        const MAX_SANE_FEE = new BN('1000000000000000');
        const feeX = ourPos.positionData.feeX || new BN(0);
        const feeY = ourPos.positionData.feeY || new BN(0);
        const safeFeeX = feeX.gt(MAX_SANE_FEE) ? new BN(0) : feeX;
        const safeFeeY = feeY.gt(MAX_SANE_FEE) ? new BN(0) : feeY;
        const feeXUi = parseFloat(safeFeeX.toString()) / Math.pow(10, decX);
        const feeYUi = parseFloat(safeFeeY.toString()) / Math.pow(10, decY);

        feeTotals.set(mintXStr, (feeTotals.get(mintXStr) || 0) + feeXUi);
        feeTotals.set(mintYStr, (feeTotals.get(mintYStr) || 0) + feeYUi);

        mintsNeeded.add(mintXStr);
        mintsNeeded.add(mintYStr);
        count++;
      } catch (err: any) {
        logger.debug(MODULE, `getMeteoraLpDetails: error reading ${entry.ourNft.slice(0, 8)}: ${(err.message || '').slice(0, 80)}`);
      }
      await new Promise(r => setTimeout(r, 300));
    }

    if (mintsNeeded.size === 0) return { lpUsd: 0, feeUsd: 0, count: 0 };

    const mintList = Array.from(mintsNeeded).join(',');
    let prices: Record<string, number> = {};
    try {
      const res = await fetch(`https://api.jup.ag/price/v3?ids=${mintList}`, {
        headers: config.jupApiKey ? { 'x-api-key': config.jupApiKey } : {},
      });
      if (res.ok) {
        const json = await res.json() as any;
        for (const [mint, info] of Object.entries(json || {})) {
          const p = (info as any)?.usdPrice;
          if (p) prices[mint] = parseFloat(String(p));
        }
      }
    } catch (err: any) {
      logger.warn(MODULE, `getMeteoraLpDetails: Jupiter price fetch failed: ${err.message}`);
    }

    for (const [mint, amount] of lpTotals) {
      totalLpUsd += amount * (prices[mint] || 0);
    }
    for (const [mint, amount] of feeTotals) {
      totalFeeUsd += amount * (prices[mint] || 0);
    }

    logger.info(MODULE, `Meteora LP: $${totalLpUsd.toFixed(2)} + fees $${totalFeeUsd.toFixed(2)} (${count} positions)`);
    return { lpUsd: +totalLpUsd.toFixed(2), feeUsd: +totalFeeUsd.toFixed(2), count };
  }

  private _lpAssetsCache: { items: Array<{ mint: string; balance: number; decimals: number; pairedStable: Record<string, number>; liquidityUsd: number }>; ts: number } | null = null;

  async getPositionAssets(): Promise<Array<{ mint: string; balance: number; decimals: number; pairedStable: Record<string, number>; liquidityUsd: number; poolTvl?: number | null }>> {
    if (this._lpAssetsCache && Date.now() - this._lpAssetsCache.ts < 5 * 60 * 1000) {
      return this._lpAssetsCache.items;
    }

    const allEntries = this.positionMap.toJSON();
    const meteoraEntries = Object.entries(allEntries).filter(([_, e]) => (e as any).dex === 'meteora');
    if (meteoraEntries.length === 0) return [];

    const totals = new Map<string, { balance: number; decimals: number; pairedStable: Record<string, number>; liquidityUsd: number; poolTvl: number | null }>();
    const mintsNeeded = new Set<string>();

    for (const [targetPos] of meteoraEntries) {
      try {
        const poolAddress = this.getPoolAddressForPosition(targetPos);
        if (!poolAddress) continue;

        const entry = allEntries[targetPos];
        const dlmmPool = await getCachedDlmmPool(this.readConnection, poolAddress);
        // v1.24.5: Use getPosition (single getAccountInfo) instead of getPositionsByUserAndLbPair (getProgramAccounts)
        const ourPos = await dlmmPool.getPosition(new PublicKey(entry.ourNft));
        if (!ourPos) continue;

        const mintXStr = dlmmPool.tokenX.publicKey.toBase58();
        const mintYStr = dlmmPool.tokenY.publicKey.toBase58();
        const decX = await this.getMintDecimals(dlmmPool.tokenX.publicKey);
        const decY = await this.getMintDecimals(dlmmPool.tokenY.publicKey);
        const lpX = parseFloat(ourPos.positionData.totalXAmount.toString()) / Math.pow(10, decX);
        const lpY = parseFloat(ourPos.positionData.totalYAmount.toString()) / Math.pow(10, decY);

        const poolTvl = await getMeteoraPairTvl(poolAddress);

        const eX = totals.get(mintXStr) || { balance: 0, decimals: decX, pairedStable: {}, liquidityUsd: 0, poolTvl: null };
        eX.balance += lpX;
        eX.pairedStable[mintYStr] = (eX.pairedStable[mintYStr] || 0) + lpY;
        if (poolTvl !== null) eX.poolTvl = poolTvl;
        totals.set(mintXStr, eX);

        const eY = totals.get(mintYStr) || { balance: 0, decimals: decY, pairedStable: {}, liquidityUsd: 0, poolTvl: null };
        eY.balance += lpY;
        eY.pairedStable[mintXStr] = (eY.pairedStable[mintXStr] || 0) + lpX;
        if (poolTvl !== null) eY.poolTvl = poolTvl;
        totals.set(mintYStr, eY);

        mintsNeeded.add(mintXStr);
        mintsNeeded.add(mintYStr);
      } catch (err: any) {
        logger.debug(MODULE, `getPositionAssets: error reading position: ${(err.message || '').slice(0, 80)}`);
      }
      await new Promise(r => setTimeout(r, 300));
    }

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
              const e = totals.get(mint);
              if (e) e.liquidityUsd = e.balance * parseFloat(String(p));
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
}
