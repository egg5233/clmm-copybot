import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import BN from 'bn.js';
import { CpAmm, derivePositionAddress, derivePositionNftAccount, getTokenProgram } from '@meteora-ag/cp-amm-sdk';
import type { PoolState, PositionState } from '@meteora-ag/cp-amm-sdk';
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

const MODULE = 'DammV2Pos';
const PENDING_FILE = './data/pending-swaps.json';
const DAMMV2_PROGRAM_ID = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';

export class DammV2PositionExecutor {
  private connection: Connection;       // Helius — TX execution
  private readConnection: Connection;   // Alchemy — balance/position reads
  private positionMap: PositionMap;
  private busy = false;

  public solPaused = false;
  public solPausedAt: number | null = null;
  public drawdownPaused = false;
  public drawdownPausedAt: number | null = null;
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
    logger.info(MODULE, 'DammV2PositionExecutor initialized');
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

  private isTokenBlacklisted(mintA: string, mintB: string): boolean {
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    if (config.dammv2SkipSol && (mintA === SOL_MINT || mintB === SOL_MINT)) return true;
    return config.tokenBlacklist.has(mintA) || config.tokenBlacklist.has(mintB);
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
   * Sign and send a Transaction.
   * DAMM v2 SDK returns Promise<Transaction> (TxBuilder = Promise<Transaction>).
   */
  private async signAndSend(tx: Transaction): Promise<string> {
    const userAddress = getUserAddress();

    if (!tx.feePayer) {
      tx.feePayer = userAddress;
    }
    if (!tx.recentBlockhash) {
      const { blockhash } = await this.connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
    }

    const signed = await signLegacy(tx);

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

        return sig;
      } catch (err: any) {
        if (i === config.maxRetry - 1) throw err;
        logger.warn(MODULE, `Send attempt ${i + 1} failed: ${err.message}, retrying...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    throw new Error('signAndSend: exhausted retries');
  }

  /**
   * Sign and send a Transaction that requires an additional signer (e.g. positionNft keypair).
   */
  private async signAndSendWithExtraSigner(tx: Transaction, extraSigner: Keypair): Promise<string> {
    const userAddress = getUserAddress();

    if (!tx.feePayer) {
      tx.feePayer = userAddress;
    }
    if (!tx.recentBlockhash) {
      const { blockhash } = await this.connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
    }

    const signed = await signLegacyWithExtra(tx, [extraSigner]);

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

        const txResult = await this.connection.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
        if (txResult?.meta?.err) {
          throw new Error(`TX confirmed but failed on-chain: ${JSON.stringify(txResult.meta.err)}`);
        }

        return sig;
      } catch (err: any) {
        if (i === config.maxRetry - 1) throw err;
        logger.warn(MODULE, `Send attempt ${i + 1} failed: ${err.message}, retrying...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    throw new Error('signAndSendWithExtraSigner: exhausted retries');
  }

  /**
   * Resolve pool address for a target position from positionMap metadata.
   * Pool label format: "mintA/mintB@poolAddress"
   */
  private getPoolAddressForPosition(targetNft: string): string | null {
    const poolLabel = this.positionMap.getPool(targetNft);
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
  private getPoolAddressForOurPosition(ourPositionNft: string): string | null {
    const targetNft = this.positionMap.findByOurNft(ourPositionNft);
    if (!targetNft) return null;
    return this.getPoolAddressForPosition(targetNft);
  }

  /**
   * Get token program IDs from pool state flags.
   */
  private getTokenPrograms(poolState: PoolState): { tokenAProgram: PublicKey; tokenBProgram: PublicKey } {
    return {
      tokenAProgram: getTokenProgram((poolState as any).tokenAFlag),
      tokenBProgram: getTokenProgram((poolState as any).tokenBFlag),
    };
  }

  // ===== Rent / Backfill =====

  async initRentPerPosition(): Promise<void> {
    try {
      const conn = this.readConnection;
      // DAMM v2 position account + NFT mint + NFT ATA
      const rentPosition = await conn.getMinimumBalanceForRentExemption(300);
      const rentMint = await conn.getMinimumBalanceForRentExemption(82);
      const rentAta = await conn.getMinimumBalanceForRentExemption(165);
      this.rentPerPosition = (rentPosition + rentMint + rentAta) / 1e9;
      logger.info(MODULE, `Rent per position: ${this.rentPerPosition} SOL`);
    } catch (err: any) {
      logger.warn(MODULE, `Failed to query rent exemption, using fallback ${this.rentPerPosition}: ${err.message}`);
    }
  }

  backfillLockedSol(): void {
    const missing: string[] = [];
    for (const [targetNft] of this.positionMap.entries()) {
      const dex = this.positionMap.getDex(targetNft);
      if (dex === 'dammv2' && this.positionMap.getLockedSol(targetNft, -1) === -1) {
        missing.push(targetNft);
      }
    }
    if (missing.length === 0) return;
    logger.info(MODULE, `Backfilling lockedSol for ${missing.length} DAMM v2 positions (${this.rentPerPosition} SOL each)`);
    for (const targetNft of missing) {
      this.positionMap.setLockedSol(targetNft, this.rentPerPosition);
    }
    logger.info(MODULE, `Backfill lockedSol complete: ${missing.length} DAMM v2 positions updated`);
  }

  hasMapping(targetPositionNft: string): boolean {
    return !!this.positionMap.get(targetPositionNft);
  }

  /**
   * Check if an NFT mint belongs to the DAMM v2 program by deriving its position PDA
   * and checking if the account exists on-chain.
   */
  async isDammV2Position(nft: string): Promise<boolean> {
    try {
      const positionPda = derivePositionAddress(new PublicKey(nft));
      const info = await this.readConnection.getAccountInfo(positionPda);
      if (!info) return false;
      return info.owner.toBase58() === DAMMV2_PROGRAM_ID;
    } catch {
      return false;
    }
  }

  // ===== Core Operations =====

  async copyOpenPosition(
    targetPositionNft: string,
    poolAddress: string,
    targetWallet: string,
  ): Promise<string | null> {
    const userAddress = getUserAddress();

    // === PHASE 0: Pre-checks ===
    if (this.positionMap.get(targetPositionNft)) {
      logger.warn(MODULE, `Already have mapping for target position ${targetPositionNft.slice(0, 8)}, skipping`);
      return null;
    }
    if (this.solPaused) { this.lastSkipReason = 'SOL 不足暫停'; return null; }
    if (this.drawdownPaused) { this.lastSkipReason = '回撤保護暫停'; return null; }
    if (config.dammv2CloseOnlyWallets.has(targetWallet)) {
      this.lastSkipReason = 'Close-only 錢包';
      return null;
    }
    if (config.dryRun) {
      logger.info(MODULE, '[DRY RUN] Would copy open position', { poolAddress, targetPositionNft });
      return 'dry-run-dammv2-open';
    }
    if (!this.acquire('copyOpenPosition')) return null;

    try {
      // === PHASE 1: Read pool state and target position ===
      const cpAmm = new CpAmm(this.readConnection);
      let poolState: PoolState | null = null;
      let targetPosState: PositionState | null = null;

      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          logger.info(MODULE, `Target position not found yet, waiting ${(attempt + 1) * 2}s (attempt ${attempt + 1}/3)...`);
          await new Promise(r => setTimeout(r, (attempt + 1) * 2000));
        }
        try {
          poolState = await cpAmm.fetchPoolState(new PublicKey(poolAddress));
          const targetPosPda = derivePositionAddress(new PublicKey(targetPositionNft));
          targetPosState = await cpAmm.fetchPositionState(targetPosPda);
          if (targetPosState) break;
        } catch (err: any) {
          if (attempt < 2 && this.isTransientError(err)) continue;
          if (attempt === 2) throw err;
        }
      }

      if (!poolState || !targetPosState) {
        logger.error(MODULE, `Cannot read pool/position after retries: ${targetPositionNft.slice(0, 8)}`);
        return null;
      }

      const mintA = (poolState as any).tokenAMint as PublicKey;
      const mintB = (poolState as any).tokenBMint as PublicKey;
      const mintAStr = mintA.toBase58();
      const mintBStr = mintB.toBase58();
      const poolLabel = `${mintAStr}/${mintBStr}@${poolAddress}`;
      const { tokenAProgram, tokenBProgram } = this.getTokenPrograms(poolState);

      // === PHASE 2: Filters ===

      // 2a. Token blacklist
      if (this.isTokenBlacklisted(mintAStr, mintBStr)) {
        this.lastSkipReason = '代幣黑名單';
        return null;
      }

      // 2b. Pump token filter
      if (config.pumpFilterMode !== 'off') {
        const pumpMint = mintAStr.toLowerCase().includes('pump') ? mintAStr
          : mintBStr.toLowerCase().includes('pump') ? mintBStr : null;
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

      // 2c. Pool TVL / liquidity filter
      if (config.minPoolTvl > 0) {
        const STABLES = new Set([USDC, USDT_MINT, USDT_T22]);
        for (const [mint, label] of [[mintAStr, 'mintA'], [mintBStr, 'mintB']] as [string, string][]) {
          if (config.poolTvlWhitelist.has(mint)) continue;
          if (STABLES.has(mint) || mint === NATIVE_MINT.toBase58()) continue;
          const tvl = await checkTokenLiquidity(mint);
          if (tvl === null || tvl < config.minPoolTvl) {
            logger.info(MODULE, `[OPEN] Skipped — ${label} ${mint.slice(0, 8)} TVL $${tvl !== null ? tvl.toFixed(0) : '?'} < $${config.minPoolTvl} (${config.tvlSource})`);
            this.lastSkipReason = `TVL 不足 (${label} $${tvl !== null ? tvl.toFixed(0) : '?'} < $${config.minPoolTvl})`;
            return null;
          }
        }
      }

      // === PHASE 3: Calculate deposit amounts ===
      // DAMM v2 is constant-product (full range). Use getDepositQuote to determine amounts.
      // Target's liquidity = unlockedLiquidity (ignore vested/locked for copy-trading)
      const targetLiquidity = new BN((targetPosState as any).unlockedLiquidity.toString());

      if (targetLiquidity.isZero()) {
        this.lastSkipReason = '目標流動性為零';
        return null;
      }

      // Get withdraw quote to determine target's token amounts
      const targetWithdraw = cpAmm.getWithdrawQuote({
        liquidityDelta: targetLiquidity,
        sqrtPrice: (poolState as any).sqrtPrice,
        minSqrtPrice: (poolState as any).sqrtMinPrice,
        maxSqrtPrice: (poolState as any).sqrtMaxPrice,
      });

      const targetAmountA = targetWithdraw.outAmountA;
      const targetAmountB = targetWithdraw.outAmountB;

      const ourTokenA = scaleAmount(targetAmountA, targetWallet);
      const ourTokenB = scaleAmount(targetAmountB, targetWallet);

      if (ourTokenA.isZero() && ourTokenB.isZero()) {
        this.lastSkipReason = '存款金額為零';
        return null;
      }

      const ratio = getAmountRatio(targetWallet);
      logger.info(MODULE, `Target amounts: A=${targetAmountA.toString()}, B=${targetAmountB.toString()}, ratio=${ratio}`);
      logger.info(MODULE, `Our deposit target: A=${ourTokenA.toString()}, B=${ourTokenB.toString()}`);

      // === PHASE 4: Pre-swap (acquire tokens if insufficient) ===
      let balanceA = await this.getTokenBalance(userAddress, mintA);
      let balanceB = await this.getTokenBalance(userAddress, mintB);
      logger.info(MODULE, `Balances before swap: A=${balanceA.toString()}, B=${balanceB.toString()}`);

      // Swap for tokenA if deficit
      if (balanceA.lt(ourTokenA) && !ourTokenA.isZero() && mintAStr !== USDC) {
        const deficit = ourTokenA.sub(balanceA);
        logger.info(MODULE, `Need ${deficit.toString()} more of tokenA (${mintAStr})`);
        let txSig: string | null = null;

        // SOL deficit: only try USDC→SOL (don't spend other tokens for SOL)
        if (mintA.equals(NATIVE_MINT)) {
          txSig = await swapForToken(this.connection, USDC, mintAStr, deficit.toString());
        } else {
          if (!balanceB.isZero()) {
            txSig = await swapForToken(this.connection, mintBStr, mintAStr, deficit.toString());
          }
          if (!txSig) {
            txSig = await swapForToken(this.connection, USDC, mintAStr, deficit.toString());
          }
        }
        if (!txSig) {
          notifySwapFailed(mintAStr, lastSwapError || 'all methods failed');
          return null;
        }
        invalidateHoldingsCache();
        const addedA = await getActualSwapOutput(this.readConnection, txSig, mintAStr, userAddress.toBase58());
        if (addedA) {
          balanceA = balanceA.add(new BN(addedA));
        } else {
          await new Promise(r => setTimeout(r, 5000));
          balanceA = await this.getTokenBalance(userAddress, mintA);
        }
        balanceB = await this.getTokenBalance(userAddress, mintB);
      }

      // Swap for tokenB if deficit
      if (balanceB.lt(ourTokenB) && !ourTokenB.isZero() && mintBStr !== USDC) {
        const deficit = ourTokenB.sub(balanceB);
        logger.info(MODULE, `Need ${deficit.toString()} more of tokenB (${mintBStr})`);
        let txSig: string | null = null;

        // SOL deficit: only try USDC→SOL
        if (mintB.equals(NATIVE_MINT)) {
          txSig = await swapForToken(this.connection, USDC, mintBStr, deficit.toString());
        } else {
          txSig = await swapForToken(this.connection, USDC, mintBStr, deficit.toString());
          if (!txSig && balanceA.gt(ourTokenA)) {
            txSig = await swapForToken(this.connection, mintAStr, mintBStr, deficit.toString());
          }
        }
        if (!txSig) {
          notifySwapFailed(mintBStr, lastSwapError || 'all methods failed');
          return null;
        }
        invalidateHoldingsCache();
        const addedB = await getActualSwapOutput(this.readConnection, txSig, mintBStr, userAddress.toBase58());
        if (addedB) {
          balanceB = balanceB.add(new BN(addedB));
        } else {
          await new Promise(r => setTimeout(r, 5000));
          balanceB = await this.getTokenBalance(userAddress, mintB);
        }
      }

      if (balanceA.isZero() && balanceB.isZero()) {
        logger.error(MODULE, 'No token balance for either side after swaps, cannot open position');
        return null;
      }

      // === PHASE 5: Open position with retry ===
      const cpAmmExec = new CpAmm(this.connection);
      const MAX_OPEN_ATTEMPTS = 2;

      for (let openAttempt = 0; openAttempt < MAX_OPEN_ATTEMPTS; openAttempt++) {
        if (openAttempt > 0) {
          logger.info(MODULE, `Retrying open (attempt ${openAttempt + 1}/${MAX_OPEN_ATTEMPTS}), re-reading balances...`);
          await new Promise(r => setTimeout(r, 2000));
          balanceA = await this.getTokenBalance(userAddress, mintA);
          balanceB = await this.getTokenBalance(userAddress, mintB);
        }

        const tokenMaxA = ourTokenA.isZero() && !ourTokenB.isZero()
          ? balanceA : BN.min(ourTokenA, balanceA);
        const tokenMaxB = ourTokenB.isZero() && !ourTokenA.isZero()
          ? balanceB : BN.min(ourTokenB, balanceB);

        logger.info(MODULE, `Position params: tokenMaxA=${tokenMaxA.toString()}, tokenMaxB=${tokenMaxB.toString()}`);

        try {
          const positionNftKp = Keypair.generate();

          // Step 1: Create position
          const createTx = await cpAmmExec.createPosition({
            owner: userAddress,
            payer: userAddress,
            pool: new PublicKey(poolAddress),
            positionNft: positionNftKp.publicKey,
          });

          const createSig = await this.signAndSendWithExtraSigner(createTx, positionNftKp);
          logger.info(MODULE, `Create position TX: ${createSig}`);

          // Step 2: Add liquidity
          // Re-fetch pool state for fresh sqrtPrice
          const freshPoolState = await cpAmm.fetchPoolState(new PublicKey(poolAddress));
          const freshPrograms = this.getTokenPrograms(freshPoolState);

          // Compute deposit quote from tokenA side
          const depositQuote = cpAmmExec.getDepositQuote({
            inAmount: tokenMaxA,
            isTokenA: true,
            minSqrtPrice: (freshPoolState as any).sqrtMinPrice,
            maxSqrtPrice: (freshPoolState as any).sqrtMaxPrice,
            sqrtPrice: (freshPoolState as any).sqrtPrice,
          });

          const positionPda = derivePositionAddress(positionNftKp.publicKey);
          const positionNftAta = derivePositionNftAccount(positionNftKp.publicKey);

          const addTx = await cpAmmExec.addLiquidity({
            owner: userAddress,
            pool: new PublicKey(poolAddress),
            position: positionPda,
            positionNftAccount: positionNftAta,
            liquidityDelta: depositQuote.liquidityDelta,
            maxAmountTokenA: tokenMaxA,
            maxAmountTokenB: tokenMaxB,
            tokenAAmountThreshold: new BN(0),
            tokenBAmountThreshold: new BN(0),
            tokenAMint: (freshPoolState as any).tokenAMint,
            tokenBMint: (freshPoolState as any).tokenBMint,
            tokenAVault: (freshPoolState as any).tokenAVault,
            tokenBVault: (freshPoolState as any).tokenBVault,
            tokenAProgram: freshPrograms.tokenAProgram,
            tokenBProgram: freshPrograms.tokenBProgram,
          });

          // Write mapping BEFORE verifying (orphan recovery)
          const addSig = await this.signAndSend(addTx);

          this.positionMap.set(
            targetPositionNft,
            positionNftKp.publicKey.toBase58(),
            poolLabel,
            targetWallet,
            0, // no tick range for DAMM v2 (full range)
            0,
            'dammv2',
          );
          this.positionMap.setLockedSol(targetPositionNft, this.rentPerPosition);

          // Store target's liquidity at open time (for proportional decrease tracking)
          this.positionMap.setTargetLiquidity(targetPositionNft, targetLiquidity.toString());

          const success = await this.verifyTxSuccess(addSig);
          if (!success) {
            logger.error(MODULE, `Open TX failed on-chain: ${addSig.slice(0, 8)}, deleting mapping`);
            this.positionMap.delete(targetPositionNft);
            if (openAttempt < MAX_OPEN_ATTEMPTS - 1) continue;
            return null;
          }

          logger.info(MODULE, `Position opened: ${addSig} (nft=${positionNftKp.publicKey.toBase58().slice(0, 8)})`);
          return addSig;

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
      notifyOpenFailed(err, targetPositionNft);
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

  async copyAddLiquidity(
    targetPositionNft: string,
    targetWallet: string,
  ): Promise<string | null> {
    const myPositionNft = this.positionMap.get(targetPositionNft);
    if (!myPositionNft) {
      logger.warn(MODULE, `No mapped position for target: ${targetPositionNft.slice(0, 8)}`);
      return null;
    }
    if (this.solPaused || this.drawdownPaused) {
      logger.info(MODULE, `[ADD] Skipped — paused`);
      return null;
    }
    if (config.dammv2CloseOnlyWallets.has(targetWallet)) {
      logger.info(MODULE, `[ADD] Skipped — close-only wallet`);
      return null;
    }
    if (config.dryRun) {
      return 'dry-run-dammv2-add';
    }
    if (!this.acquire('copyAddLiquidity')) return null;

    try {
      const userAddress = getUserAddress();
      const cpAmm = new CpAmm(this.readConnection);

      // 2s initial delay for RPC lag
      await new Promise(r => setTimeout(r, 2000));

      const poolAddress = this.getPoolAddressForPosition(targetPositionNft);
      if (!poolAddress) return null;

      const poolState = await cpAmm.fetchPoolState(new PublicKey(poolAddress));
      const mintA = (poolState as any).tokenAMint as PublicKey;
      const mintB = (poolState as any).tokenBMint as PublicKey;
      const mintAStr = mintA.toBase58();
      const mintBStr = mintB.toBase58();
      const { tokenAProgram, tokenBProgram } = this.getTokenPrograms(poolState);

      const mapEntry = this.positionMap.toJSON()[targetPositionNft];
      const targetWalletAddr = mapEntry?.targetWallet || targetWallet;

      let deltaA!: BN;
      let deltaB!: BN;

      // Retry if delta <= 0 (RPC lag)
      for (let readAttempt = 0; readAttempt < 2; readAttempt++) {
        if (readAttempt > 0) {
          logger.info(MODULE, 'Delta <= 0 after detecting add TX, waiting 3s for RPC...');
          await new Promise(r => setTimeout(r, 3000));
        }

        // Read target position
        const targetPosPda = derivePositionAddress(new PublicKey(targetPositionNft));
        const targetPosState = await cpAmm.fetchPositionState(targetPosPda);
        const targetLiq = new BN((targetPosState as any).unlockedLiquidity.toString());
        const targetWithdraw = cpAmm.getWithdrawQuote({
          liquidityDelta: targetLiq,
          sqrtPrice: (poolState as any).sqrtPrice,
          minSqrtPrice: (poolState as any).sqrtMinPrice,
          maxSqrtPrice: (poolState as any).sqrtMaxPrice,
        });

        const targetAmountA = scaleAmount(targetWithdraw.outAmountA, targetWallet);
        const targetAmountB = scaleAmount(targetWithdraw.outAmountB, targetWallet);

        // Read our position
        const ourPosPda = derivePositionAddress(new PublicKey(myPositionNft));
        const ourPosState = await cpAmm.fetchPositionState(ourPosPda);
        const ourLiq = new BN((ourPosState as any).unlockedLiquidity.toString());
        const ourWithdraw = cpAmm.getWithdrawQuote({
          liquidityDelta: ourLiq,
          sqrtPrice: (poolState as any).sqrtPrice,
          minSqrtPrice: (poolState as any).sqrtMinPrice,
          maxSqrtPrice: (poolState as any).sqrtMaxPrice,
        });

        deltaA = targetAmountA.sub(ourWithdraw.outAmountA);
        deltaB = targetAmountB.sub(ourWithdraw.outAmountB);

        if (deltaA.gt(new BN(0)) || deltaB.gt(new BN(0))) break;
      }

      if (deltaA.lte(new BN(0)) && deltaB.lte(new BN(0))) {
        logger.info(MODULE, 'Our position already matches or exceeds target, no add needed');
        return null;
      }

      logger.info(MODULE, `Add: deltaA=${deltaA.toString()}, deltaB=${deltaB.toString()}`);

      const increaseA = deltaA.gt(new BN(0)) ? deltaA : new BN(0);
      const increaseB = deltaB.gt(new BN(0)) ? deltaB : new BN(0);
      let balanceA = await this.getTokenBalance(userAddress, mintA);
      let balanceB = await this.getTokenBalance(userAddress, mintB);

      // Pre-swap for tokenA
      if (balanceA.lt(increaseA) && !increaseA.isZero() && mintAStr !== USDC) {
        const deficit = increaseA.sub(balanceA);
        logger.info(MODULE, `Need ${deficit.toString()} more of tokenA (${mintAStr})`);
        let txSig: string | null = null;
        if (mintA.equals(NATIVE_MINT)) {
          txSig = await swapForToken(this.connection, USDC, mintAStr, deficit.toString());
        } else {
          if (!balanceB.isZero()) {
            txSig = await swapForToken(this.connection, mintBStr, mintAStr, deficit.toString());
          }
          if (!txSig) {
            txSig = await swapForToken(this.connection, USDC, mintAStr, deficit.toString());
          }
        }
        if (!txSig) {
          notifySwapFailed(mintAStr, lastSwapError || 'all methods failed');
          return null;
        }
        invalidateHoldingsCache();
        const addedA = await getActualSwapOutput(this.readConnection, txSig, mintAStr, userAddress.toBase58());
        if (addedA) { balanceA = balanceA.add(new BN(addedA)); } else {
          await new Promise(r => setTimeout(r, 5000));
          balanceA = await this.getTokenBalance(userAddress, mintA);
        }
        balanceB = await this.getTokenBalance(userAddress, mintB);
      }

      // Pre-swap for tokenB
      if (balanceB.lt(increaseB) && !increaseB.isZero() && mintBStr !== USDC) {
        const deficit = increaseB.sub(balanceB);
        logger.info(MODULE, `Need ${deficit.toString()} more of tokenB (${mintBStr})`);
        let txSig: string | null = null;
        if (mintB.equals(NATIVE_MINT)) {
          txSig = await swapForToken(this.connection, USDC, mintBStr, deficit.toString());
        } else {
          txSig = await swapForToken(this.connection, USDC, mintBStr, deficit.toString());
          if (!txSig && balanceA.gt(increaseA)) {
            txSig = await swapForToken(this.connection, mintAStr, mintBStr, deficit.toString());
          }
        }
        if (!txSig) {
          notifySwapFailed(mintBStr, lastSwapError || 'all methods failed');
          return null;
        }
        invalidateHoldingsCache();
        const addedB = await getActualSwapOutput(this.readConnection, txSig, mintBStr, userAddress.toBase58());
        if (addedB) { balanceB = balanceB.add(new BN(addedB)); } else {
          await new Promise(r => setTimeout(r, 5000));
          balanceB = await this.getTokenBalance(userAddress, mintB);
        }
      }

      // Add liquidity with retry
      const cpAmmExec = new CpAmm(this.connection);
      const MAX_ADD_ATTEMPTS = 2;
      for (let addAttempt = 0; addAttempt < MAX_ADD_ATTEMPTS; addAttempt++) {
        if (addAttempt > 0) {
          await new Promise(r => setTimeout(r, 2000));
          balanceA = await this.getTokenBalance(userAddress, mintA);
          balanceB = await this.getTokenBalance(userAddress, mintB);
        }

        const tokenMaxA = increaseA.isZero() && !increaseB.isZero()
          ? balanceA : BN.min(increaseA, balanceA);
        const tokenMaxB = increaseB.isZero() && !increaseA.isZero()
          ? balanceB : BN.min(increaseB, balanceB);

        try {
          // Re-fetch pool state for fresh sqrtPrice
          const freshPoolState = await cpAmm.fetchPoolState(new PublicKey(poolAddress));

          const depositQuote = cpAmmExec.getDepositQuote({
            inAmount: tokenMaxA,
            isTokenA: true,
            minSqrtPrice: (freshPoolState as any).sqrtMinPrice,
            maxSqrtPrice: (freshPoolState as any).sqrtMaxPrice,
            sqrtPrice: (freshPoolState as any).sqrtPrice,
          });

          const positionPda = derivePositionAddress(new PublicKey(myPositionNft));
          const positionNftAta = derivePositionNftAccount(new PublicKey(myPositionNft));

          const addTx = await cpAmmExec.addLiquidity({
            owner: userAddress,
            pool: new PublicKey(poolAddress),
            position: positionPda,
            positionNftAccount: positionNftAta,
            liquidityDelta: depositQuote.liquidityDelta,
            maxAmountTokenA: tokenMaxA,
            maxAmountTokenB: tokenMaxB,
            tokenAAmountThreshold: new BN(0),
            tokenBAmountThreshold: new BN(0),
            tokenAMint: (freshPoolState as any).tokenAMint,
            tokenBMint: (freshPoolState as any).tokenBMint,
            tokenAVault: (freshPoolState as any).tokenAVault,
            tokenBVault: (freshPoolState as any).tokenBVault,
            tokenAProgram,
            tokenBProgram,
          });

          const txSig = await this.signAndSend(addTx);
          logger.info(MODULE, `Add liquidity TX: ${txSig}`);

          // Update stored target liquidity after successful add (for proportional decrease tracking)
          try {
            const updatedTargetPosPda = derivePositionAddress(new PublicKey(targetPositionNft));
            const updatedTargetPosState = await cpAmm.fetchPositionState(updatedTargetPosPda);
            const updatedTargetLiq = new BN((updatedTargetPosState as any).unlockedLiquidity.toString());
            this.positionMap.setTargetLiquidity(targetPositionNft, updatedTargetLiq.toString());
            logger.info(MODULE, `Updated stored targetLiquidity: ${updatedTargetLiq.toString()}`);
          } catch (tlErr: any) {
            logger.warn(MODULE, `Failed to update targetLiquidity after add: ${tlErr.message}`);
          }

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
    targetPositionNft: string,
  ): Promise<{ txSig: string; type: string } | null> {
    const myPositionNft = this.positionMap.get(targetPositionNft);
    if (!myPositionNft) {
      logger.warn(MODULE, `No mapped position for target: ${targetPositionNft.slice(0, 8)}`);
      return null;
    }
    if (!this.acquire('copyRemoveLiquidity')) return null;

    try {
      const userAddress = getUserAddress();
      const cpAmm = new CpAmm(this.readConnection);
      const poolAddress = this.getPoolAddressForPosition(targetPositionNft);
      if (!poolAddress) return null;

      const poolState = await cpAmm.fetchPoolState(new PublicKey(poolAddress));
      const { tokenAProgram, tokenBProgram } = this.getTokenPrograms(poolState);

      // Read target's current liquidity to determine: full decrease, partial decrease, or fee collection
      let targetCurrentLiq: BN | null = null;
      try {
        const targetPosPda = derivePositionAddress(new PublicKey(targetPositionNft));
        const targetPosState = await cpAmm.fetchPositionState(targetPosPda);
        targetCurrentLiq = new BN((targetPosState as any).unlockedLiquidity.toString());
      } catch { /* target position may be closed already → full decrease */ }

      // Determine decrease amount by comparing target's current vs stored liquidity
      let decreaseAmount: BN | null = null; // null = full decrease
      if (targetCurrentLiq && !targetCurrentLiq.isZero()) {
        const storedLiqStr = this.positionMap.getTargetLiquidity(targetPositionNft);
        if (storedLiqStr) {
          const storedLiq = new BN(storedLiqStr);
          if (targetCurrentLiq.lt(storedLiq)) {
            // Partial decrease — calculate proportional amount for our position
            const removedLiq = storedLiq.sub(targetCurrentLiq);
            const pctNumerator = removedLiq.mul(new BN(10000));
            const pctBps = pctNumerator.div(storedLiq).toNumber();
            logger.info(MODULE, `Partial decrease detected: target ${storedLiq.toString()} -> ${targetCurrentLiq.toString()} (removed ${pctBps / 100}%)`);

            try {
              const ourPosPda = derivePositionAddress(new PublicKey(myPositionNft));
              const ourPosState = await cpAmm.fetchPositionState(ourPosPda);
              const ourLiq = new BN((ourPosState as any).unlockedLiquidity.toString());
              // ourDecrease = ourLiq * removedLiq / storedLiq
              decreaseAmount = ourLiq.mul(removedLiq).div(storedLiq);
              if (decreaseAmount.isZero()) {
                logger.info(MODULE, 'Proportional decrease rounds to zero, collecting fees instead');
              } else {
                logger.info(MODULE, `Our decrease: ${decreaseAmount.toString()} of ${ourLiq.toString()}`);
              }
            } catch (err: any) {
              logger.warn(MODULE, `Cannot read our position for proportional calc: ${err.message}`);
            }

            // Update stored target liquidity for next decrease
            this.positionMap.setTargetLiquidity(targetPositionNft, targetCurrentLiq.toString());
          } else {
            // Target liquidity >= stored — likely fee collection only
            logger.info(MODULE, `Target liquidity ${targetCurrentLiq.toString()} >= stored ${storedLiq.toString()}, collecting fees`);
            decreaseAmount = new BN(0);
          }
        } else {
          // No stored liquidity (legacy position) — can't calculate proportion, collect fees
          logger.info(MODULE, `No stored targetLiquidity for ${targetPositionNft.slice(0, 8)}, collecting fees (legacy position)`);
          decreaseAmount = new BN(0);
        }
      }
      // targetCurrentLiq is null or zero → full decrease (decreaseAmount stays null)

      // Fee collection only (decreaseAmount is zero)
      if (decreaseAmount && decreaseAmount.isZero()) {
        const MAX_FEE_ATTEMPTS = 2;
        for (let attempt = 0; attempt < MAX_FEE_ATTEMPTS; attempt++) {
          try {
            const positionPda = derivePositionAddress(new PublicKey(myPositionNft));
            const positionNftAta = derivePositionNftAccount(new PublicKey(myPositionNft));

            const cpAmmExec = new CpAmm(this.connection);
            const claimTx = await cpAmmExec.claimPositionFee2({
              owner: userAddress,
              position: positionPda,
              pool: new PublicKey(poolAddress),
              positionNftAccount: positionNftAta,
              tokenAMint: (poolState as any).tokenAMint,
              tokenBMint: (poolState as any).tokenBMint,
              tokenAVault: (poolState as any).tokenAVault,
              tokenBVault: (poolState as any).tokenBVault,
              tokenAProgram,
              tokenBProgram,
              receiver: userAddress,
            });

            const txSig = await this.signAndSend(claimTx);
            if (txSig) return { txSig, type: 'COLLECT_FEE' };
          } catch (err: any) {
            if (attempt < MAX_FEE_ATTEMPTS - 1 && this.isTransientError(err)) continue;
            throw err;
          }
        }
        return null;
      }

      // Partial decrease (decreaseAmount > 0) or full decrease (decreaseAmount is null)
      const isPartial = decreaseAmount !== null;
      logger.info(MODULE, `${isPartial ? 'Partial' : 'Full'} decrease for our NFT: ${myPositionNft.slice(0, 8)}...`);

      const MAX_DECREASE_ATTEMPTS = 2;
      for (let attempt = 0; attempt < MAX_DECREASE_ATTEMPTS; attempt++) {
        try {
          const positionPda = derivePositionAddress(new PublicKey(myPositionNft));
          const positionNftAta = derivePositionNftAccount(new PublicKey(myPositionNft));
          const ourPosState = await cpAmm.fetchPositionState(positionPda);
          const ourLiq = new BN((ourPosState as any).unlockedLiquidity.toString());

          if (ourLiq.isZero()) {
            logger.info(MODULE, 'Our position already has zero liquidity');
            return null;
          }

          const cpAmmExec = new CpAmm(this.connection);
          let txSig: string | null = null;

          if (isPartial) {
            // Partial decrease — use removeLiquidity with liquidityDelta
            const removeTx = await cpAmmExec.removeLiquidity({
              owner: userAddress,
              position: positionPda,
              pool: new PublicKey(poolAddress),
              positionNftAccount: positionNftAta,
              liquidityDelta: BN.min(decreaseAmount!, ourLiq),
              tokenAAmountThreshold: new BN(0),
              tokenBAmountThreshold: new BN(0),
              tokenAMint: (poolState as any).tokenAMint,
              tokenBMint: (poolState as any).tokenBMint,
              tokenAVault: (poolState as any).tokenAVault,
              tokenBVault: (poolState as any).tokenBVault,
              tokenAProgram,
              tokenBProgram,
              vestings: [],
              currentPoint: new BN(Math.floor(Date.now() / 1000)),
            });
            txSig = await this.signAndSend(removeTx);
          } else {
            // Full decrease — use removeAllLiquidity
            const removeTx = await cpAmmExec.removeAllLiquidity({
              owner: userAddress,
              position: positionPda,
              pool: new PublicKey(poolAddress),
              positionNftAccount: positionNftAta,
              tokenAAmountThreshold: new BN(0),
              tokenBAmountThreshold: new BN(0),
              tokenAMint: (poolState as any).tokenAMint,
              tokenBMint: (poolState as any).tokenBMint,
              tokenAVault: (poolState as any).tokenAVault,
              tokenBVault: (poolState as any).tokenBVault,
              tokenAProgram,
              tokenBProgram,
              vestings: [],
              currentPoint: new BN(Math.floor(Date.now() / 1000)),
            });
            txSig = await this.signAndSend(removeTx);
          }

          if (txSig) {
            // Queue pending swaps for received tokens
            const tokenChanges = await this.parseTxTokenChanges(txSig, userAddress);
            for (const change of tokenChanges) {
              this.addPendingSwap(change.mint, change.amount);
            }
            return { txSig, type: 'DECREASE' };
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

  async copyClosePosition(targetPositionNft: string): Promise<string | null> {
    const myPositionNft = this.positionMap.get(targetPositionNft);
    if (!myPositionNft) {
      logger.warn(MODULE, `No mapped position for target: ${targetPositionNft.slice(0, 8)}`);
      return null;
    }

    logger.info(MODULE, `Closing position: ${myPositionNft.slice(0, 8)}...`);
    if (config.dryRun) {
      logger.info(MODULE, '[DRY RUN] Would close position', { myPositionNft });
      return 'dry-run-dammv2-close';
    }
    if (!this.acquire('copyClosePosition')) return null;

    try {
      const userAddress = getUserAddress();
      const cpAmm = new CpAmm(this.readConnection);
      let lastTxSig: string | null = null;

      const MAX_CLOSE_ATTEMPTS = 3;
      for (let attempt = 0; attempt < MAX_CLOSE_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          logger.info(MODULE, `Retrying close (attempt ${attempt + 1}/${MAX_CLOSE_ATTEMPTS})...`);
          await new Promise(r => setTimeout(r, 2000));
        }

        try {
          const poolAddress = this.getPoolAddressForPosition(targetPositionNft);
          if (!poolAddress) {
            logger.error(MODULE, 'Cannot determine pool address for position');
            this.positionMap.delete(targetPositionNft);
            return null;
          }

          const poolState = await cpAmm.fetchPoolState(new PublicKey(poolAddress));
          const { tokenAProgram, tokenBProgram } = this.getTokenPrograms(poolState);
          const positionPda = derivePositionAddress(new PublicKey(myPositionNft));
          const positionNftAta = derivePositionNftAccount(new PublicKey(myPositionNft));

          // Check if position exists and has liquidity
          let ourPosState: PositionState;
          try {
            ourPosState = await cpAmm.fetchPositionState(positionPda);
          } catch {
            logger.warn(MODULE, `Position not found on-chain: ${myPositionNft.slice(0, 8)}, deleting mapping`);
            this.positionMap.delete(targetPositionNft);
            return null;
          }

          const ourLiq = new BN((ourPosState as any).unlockedLiquidity.toString());
          const cpAmmExec = new CpAmm(this.connection);

          if (ourLiq.gt(new BN(0))) {
            // Use removeAllLiquidityAndClosePosition for atomic close
            const closeTx = await cpAmmExec.removeAllLiquidityAndClosePosition({
              owner: userAddress,
              position: positionPda,
              positionNftAccount: positionNftAta,
              poolState,
              positionState: ourPosState,
              tokenAAmountThreshold: new BN(0),
              tokenBAmountThreshold: new BN(0),
              vestings: [],
              currentPoint: new BN(Math.floor(Date.now() / 1000)),
            });

            lastTxSig = await this.signAndSend(closeTx);
            logger.info(MODULE, `Close position (with liquidity) TX: ${lastTxSig}`);
          } else {
            // Position already empty, just close it
            const closeTx = await cpAmmExec.closePosition({
              owner: userAddress,
              pool: new PublicKey(poolAddress),
              position: positionPda,
              positionNftMint: (ourPosState as any).nftMint,
              positionNftAccount: positionNftAta,
            });

            lastTxSig = await this.signAndSend(closeTx);
            logger.info(MODULE, `Close position (empty) TX: ${lastTxSig}`);
          }

        } catch (closeErr: any) {
          if (attempt < MAX_CLOSE_ATTEMPTS - 1 && (this.isRetryableSimError(closeErr) || this.isTransientError(closeErr))) {
            logger.warn(MODULE, `Close attempt ${attempt + 1} failed (${(closeErr.message || '').slice(0, 100)}), will retry...`);
            continue;
          }
          throw closeErr;
        }

        if (!lastTxSig) return null;

        const success = await this.verifyTxSuccess(lastTxSig);
        if (success) break;

        if (attempt < MAX_CLOSE_ATTEMPTS - 1) {
          logger.warn(MODULE, `Close TX failed on-chain: ${lastTxSig.slice(0, 8)}, retrying...`);
          lastTxSig = null;
          continue;
        }
        logger.error(MODULE, `Close TX failed after ${MAX_CLOSE_ATTEMPTS} attempts, keeping mapping`);
        notifyCloseFailed(myPositionNft, 'on-chain failure after max attempts', MAX_CLOSE_ATTEMPTS);
        return null;
      }

      if (!lastTxSig) return null;

      // Post-close: delete mapping
      logger.info(MODULE, `Position closed: ${myPositionNft.slice(0, 8)} TX: ${lastTxSig}`);
      this.positionMap.delete(targetPositionNft);

      // Parse TX for received tokens -> queue as pending swaps
      const received = await this.parseTxTokenChanges(lastTxSig, userAddress);
      for (const { mint, amount } of received) {
        logger.info(MODULE, `Received from close: ${mint.toBase58().slice(0, 8)}... = ${amount.toString()}`);
        this.addPendingSwap(mint, amount);
      }

      return lastTxSig;

    } catch (err: any) {
      logger.error(MODULE, `Close position failed: ${typeof err?.message === 'string' ? err.message : JSON.stringify(err)}`);
      notifyCloseFailed(myPositionNft, err, 0);
      return null;
    } finally {
      this.release();
    }
  }

  async copyClaimFee(targetPositionNft: string): Promise<string | null> {
    const myPositionNft = this.positionMap.get(targetPositionNft);
    if (!myPositionNft) {
      logger.warn(MODULE, `No mapped position for target: ${targetPositionNft.slice(0, 8)}`);
      return null;
    }
    if (config.dryRun) {
      logger.info(MODULE, '[DRY RUN] Would claim fees', { myPositionNft });
      return 'dry-run-dammv2-fee';
    }
    if (!this.acquire('copyClaimFee')) return null;

    try {
      const userAddress = getUserAddress();
      const cpAmm = new CpAmm(this.readConnection);
      const poolAddress = this.getPoolAddressForPosition(targetPositionNft);
      if (!poolAddress) return null;

      const poolState = await cpAmm.fetchPoolState(new PublicKey(poolAddress));
      const { tokenAProgram, tokenBProgram } = this.getTokenPrograms(poolState);
      const positionPda = derivePositionAddress(new PublicKey(myPositionNft));
      const positionNftAta = derivePositionNftAccount(new PublicKey(myPositionNft));

      const cpAmmExec = new CpAmm(this.connection);
      const claimTx = await cpAmmExec.claimPositionFee2({
        owner: userAddress,
        position: positionPda,
        pool: new PublicKey(poolAddress),
        positionNftAccount: positionNftAta,
        tokenAMint: (poolState as any).tokenAMint,
        tokenBMint: (poolState as any).tokenBMint,
        tokenAVault: (poolState as any).tokenAVault,
        tokenBVault: (poolState as any).tokenBVault,
        tokenAProgram,
        tokenBProgram,
        receiver: userAddress,
      });

      const txSig = await this.signAndSend(claimTx);
      logger.info(MODULE, `Fee claim TX: ${txSig}`);
      return txSig;

    } catch (err: any) {
      logger.error(MODULE, `Fee collection failed: ${err.message}`);
      return null;
    } finally {
      this.release();
    }
  }

  // ===== Dashboard / Manual / Reconcile =====

  async manualClosePosition(ourPositionNft: string): Promise<string | null> {
    const targetNft = this.positionMap.findByOurNft(ourPositionNft);
    if (!targetNft) {
      logger.warn(MODULE, `Manual close: no mapping found for our position ${ourPositionNft.slice(0, 8)}`);
      return null;
    }
    return this.copyClosePosition(targetNft);
  }

  async reconcileDammV2Positions(_opQueue: OperationQueue): Promise<void> {
    const allEntries = this.positionMap.toJSON();
    const dammv2Entries = Object.entries(allEntries).filter(([_, e]) => e.dex === 'dammv2');

    if (dammv2Entries.length === 0) return;
    logger.info(MODULE, `Reconciling ${dammv2Entries.length} DAMM v2 positions...`);

    const cpAmm = new CpAmm(this.readConnection);

    for (const [targetNft, entry] of dammv2Entries) {
      try {
        const positionPda = derivePositionAddress(new PublicKey(entry.ourNft));
        const info = await this.readConnection.getAccountInfo(positionPda);
        if (!info) {
          logger.warn(MODULE, `Orphan detected: target=${targetNft.slice(0, 8)}, our=${entry.ourNft.slice(0, 8)} — not found on-chain`);
          this.positionMap.delete(targetNft);
        }

        await new Promise(r => setTimeout(r, 500));
      } catch (err: any) {
        if (this.isTransientError(err)) {
          logger.debug(MODULE, `Reconcile skipped ${targetNft.slice(0, 8)}: transient error`);
          continue;
        }
        logger.warn(MODULE, `Reconcile error for ${targetNft.slice(0, 8)}: ${err.message}`);
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
   * Get detailed LP value breakdown for asset-trend.
   * Returns positions array and totalUsd for dashboard compatibility.
   */
  async getPositionAssets(): Promise<Array<{ mint: string; balance: number; decimals: number; pairedStable: Record<string, number>; liquidityUsd: number }>> {
    const STABLE_MINTS = new Set([
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      'Es9vMFrzaCERmKfrE1SBVYuL9sSMdCL3DscMVPR1YnG5',
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    ]);

    const allEntries = this.positionMap.toJSON();
    const dammv2Entries = Object.entries(allEntries).filter(([_, e]) => e.dex === 'dammv2');
    if (dammv2Entries.length === 0) return [];

    const cpAmm = new CpAmm(this.readConnection);
    const mintTotals = new Map<string, { balance: number; decimals: number; pairedStable: Record<string, number>; liquidityUsd: number }>();

    for (const [targetNft, entry] of dammv2Entries) {
      try {
        const poolAddress = this.getPoolAddressForPosition(targetNft);
        if (!poolAddress) continue;

        const poolState = await cpAmm.fetchPoolState(new PublicKey(poolAddress));
        const positionPda = derivePositionAddress(new PublicKey(entry.ourNft));
        let posState: PositionState;
        try { posState = await cpAmm.fetchPositionState(positionPda); } catch { continue; }

        const mintAStr = ((poolState as any).tokenAMint as PublicKey).toBase58();
        const mintBStr = ((poolState as any).tokenBMint as PublicKey).toBase58();
        const decA = await this.getMintDecimals((poolState as any).tokenAMint);
        const decB = await this.getMintDecimals((poolState as any).tokenBMint);

        const liq = new BN((posState as any).unlockedLiquidity.toString());
        const withdrawQuote = cpAmm.getWithdrawQuote({
          liquidityDelta: liq,
          sqrtPrice: (poolState as any).sqrtPrice,
          minSqrtPrice: (poolState as any).sqrtMinPrice,
          maxSqrtPrice: (poolState as any).sqrtMaxPrice,
        });

        const amtA = parseFloat(withdrawQuote.outAmountA.toString()) / Math.pow(10, decA);
        const amtB = parseFloat(withdrawQuote.outAmountB.toString()) / Math.pow(10, decB);

        const addToMint = (mint: string, amount: number, decimals: number, pairedMint: string, pairedAmount: number) => {
          const existing = mintTotals.get(mint) || { balance: 0, decimals, pairedStable: {}, liquidityUsd: 0 };
          existing.balance += amount;
          if (STABLE_MINTS.has(pairedMint)) {
            existing.pairedStable[pairedMint] = (existing.pairedStable[pairedMint] || 0) + pairedAmount;
          }
          mintTotals.set(mint, existing);
        };

        addToMint(mintAStr, amtA, decA, mintBStr, amtB);
        addToMint(mintBStr, amtB, decB, mintAStr, amtA);
      } catch { /* skip */ }
      await new Promise(r => setTimeout(r, 200));
    }

    return Array.from(mintTotals.entries()).map(([mint, data]) => ({ mint, ...data }));
  }

  async getDammV2LpDetails(): Promise<{ positions: any[]; totalUsd: number }> {
    const allEntries = this.positionMap.toJSON();
    const dammv2Entries = Object.entries(allEntries).filter(([_, e]) => e.dex === 'dammv2');
    if (dammv2Entries.length === 0) return { positions: [], totalUsd: 0 };

    const cpAmm = new CpAmm(this.readConnection);
    const lpTotals = new Map<string, number>();
    const feeTotals = new Map<string, number>();
    const mintsNeeded = new Set<string>();
    const positions: any[] = [];

    for (const [targetNft, entry] of dammv2Entries) {
      try {
        const poolAddress = this.getPoolAddressForPosition(targetNft);
        if (!poolAddress) continue;

        const poolState = await cpAmm.fetchPoolState(new PublicKey(poolAddress));
        const positionPda = derivePositionAddress(new PublicKey(entry.ourNft));
        let posState: PositionState;
        try {
          posState = await cpAmm.fetchPositionState(positionPda);
        } catch { continue; }

        const mintAStr = ((poolState as any).tokenAMint as PublicKey).toBase58();
        const mintBStr = ((poolState as any).tokenBMint as PublicKey).toBase58();
        const decA = await this.getMintDecimals((poolState as any).tokenAMint);
        const decB = await this.getMintDecimals((poolState as any).tokenBMint);

        const liq = new BN((posState as any).unlockedLiquidity.toString());
        const withdrawQuote = cpAmm.getWithdrawQuote({
          liquidityDelta: liq,
          sqrtPrice: (poolState as any).sqrtPrice,
          minSqrtPrice: (poolState as any).sqrtMinPrice,
          maxSqrtPrice: (poolState as any).sqrtMaxPrice,
        });

        const lpA = parseFloat(withdrawQuote.outAmountA.toString()) / Math.pow(10, decA);
        const lpB = parseFloat(withdrawQuote.outAmountB.toString()) / Math.pow(10, decB);

        lpTotals.set(mintAStr, (lpTotals.get(mintAStr) || 0) + lpA);
        lpTotals.set(mintBStr, (lpTotals.get(mintBStr) || 0) + lpB);

        // Fee values
        const MAX_SANE_FEE = new BN('1000000000000000');
        const feeA = new BN(((posState as any).feeAPending || 0).toString());
        const feeB = new BN(((posState as any).feeBPending || 0).toString());
        const safeFeeA = feeA.gt(MAX_SANE_FEE) ? new BN(0) : feeA;
        const safeFeeB = feeB.gt(MAX_SANE_FEE) ? new BN(0) : feeB;
        const feeAUi = parseFloat(safeFeeA.toString()) / Math.pow(10, decA);
        const feeBUi = parseFloat(safeFeeB.toString()) / Math.pow(10, decB);

        feeTotals.set(mintAStr, (feeTotals.get(mintAStr) || 0) + feeAUi);
        feeTotals.set(mintBStr, (feeTotals.get(mintBStr) || 0) + feeBUi);

        mintsNeeded.add(mintAStr);
        mintsNeeded.add(mintBStr);

        positions.push({
          targetNft,
          ourNft: entry.ourNft,
          pool: poolAddress,
          mintA: mintAStr,
          mintB: mintBStr,
          lpA,
          lpB,
          feeA: feeAUi,
          feeB: feeBUi,
        });
      } catch (err: any) {
        logger.debug(MODULE, `getDammV2LpDetails: error reading ${entry.ourNft.slice(0, 8)}: ${(err.message || '').slice(0, 80)}`);
      }
      await new Promise(r => setTimeout(r, 300));
    }

    if (mintsNeeded.size === 0) return { positions: [], totalUsd: 0 };

    // Fetch prices
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
      logger.warn(MODULE, `getDammV2LpDetails: Jupiter price fetch failed: ${err.message}`);
    }

    let totalLpUsd = 0;
    let totalFeeUsd = 0;
    for (const [mint, amount] of lpTotals) {
      totalLpUsd += amount * (prices[mint] || 0);
    }
    for (const [mint, amount] of feeTotals) {
      totalFeeUsd += amount * (prices[mint] || 0);
    }

    const totalUsd = +(totalLpUsd + totalFeeUsd).toFixed(2);
    logger.info(MODULE, `DAMM v2 LP: $${totalLpUsd.toFixed(2)} + fees $${totalFeeUsd.toFixed(2)} (${positions.length} positions)`);
    return { positions, totalUsd };
  }
}
