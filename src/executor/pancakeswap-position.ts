import {
  AccountInfo,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
} from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import BN from 'bn.js';
import { Chain, makeTransaction, IGetPositionInfoByNftMintReturn } from 'byreal-clmm-sdk-alpha';
import { config, MIN_SDK_PRIORITY_FEE_MICROLAMPORTS } from '../config';
import { logger } from '../utils/logger';
import { getUserAddress, signerCallback } from '../utils/wallet';
import { scaleAmount } from '../utils/ratio';
import { jupiterFetch } from '../utils/jupiter-api';
import { swapForToken, getActualSwapOutput, lastSwapError } from './jupiter-swap';
import { PositionMap } from '../state/position-map';
import { OperationQueue } from './queue';
import {
  notifyOpenFailed,
  notifyCloseFailed,
  notifySolInsufficient,
  notifySwapFailed,
  notifyPumpApproval,
} from '../discord/notify';
import { checkTokenLiquidity } from '../monitor/pool-tvl';
import {
  isPumpPending,
  isPumpApproved,
  isPumpRejected,
  addPumpPending,
} from '../state/pump-pending';
import * as fs from 'fs';
import * as path from 'path';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MODULE = 'PcsPos';

// Stablecoins excluded from TVL check
const STABLE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmKfrE1SBVYuL9sSMdCL3DscMVPR1YnG5', // USDT (standard)
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT (Token2022)
]);

/**
 * Monkey-patch byreal-clmm-sdk-alpha to accept PancakeSwap CLMM program ID.
 * PCS is a Raydium CLMM fork with identical IDL — same instruction set, same account layouts.
 * The SDK's getAmmV3Program() has a hardcoded whitelist; we patch it at runtime via CJS exports.
 */
let sdkPatched = false;
function patchSdkForPcs(): void {
  if (sdkPatched) return;
  try {
    // SDK package.json exports map blocks deep requires — use absolute path to bypass
    const sdkDir = path.dirname(require.resolve('byreal-clmm-sdk-alpha/package.json'));
    const baseModulePath = path.join(sdkDir, 'dist', 'cjs', 'instructions', 'baseInstruction.js');
    const baseModule = require(baseModulePath);
    const originalFn = baseModule.getAmmV3Program;
    const PCS_ID = config.pcsProgramId.toBase58();

    baseModule.getAmmV3Program = (programId: any) => {
      if (programId.toBase58() === PCS_ID) {
        // Use Byreal IDL (identical instruction set) but with PCS program address
        const idlPath = path.join(
          sdkDir,
          'dist',
          'cjs',
          'instructions',
          'target',
          'idl',
          'byreal_amm_v3.json',
        );
        const idl = JSON.parse(fs.readFileSync(idlPath, 'utf-8'));
        const pcsIdl = { ...idl, address: PCS_ID };
        const anchor = require('@coral-xyz/anchor');
        const { Connection: SolConnection, clusterApiUrl } = require('@solana/web3.js');
        const provider = new anchor.AnchorProvider(
          new SolConnection(clusterApiUrl('mainnet-beta'), 'confirmed'),
          {},
          { commitment: 'confirmed' },
        );
        return new anchor.Program(pcsIdl, provider);
      }
      return originalFn(programId);
    };
    sdkPatched = true;
    logger.info(MODULE, 'SDK patched for PancakeSwap CLMM program ID');
  } catch (err: any) {
    logger.error(MODULE, `SDK patch failed: ${err.message}`);
  }
}

/**
 * Patch connection.getMultipleAccountsInfo to auto-chunk when >100 keys.
 */
function patchConnectionChunking(conn: Connection): void {
  const original = conn.getMultipleAccountsInfo.bind(conn);
  conn.getMultipleAccountsInfo = async (
    keys: PublicKey[],
    ...args: any[]
  ): Promise<(AccountInfo<Buffer> | null)[]> => {
    if (keys.length <= 100) return original(keys, ...args);
    const results: (AccountInfo<Buffer> | null)[] = [];
    for (let i = 0; i < keys.length; i += 100) {
      const chunk = keys.slice(i, i + 100);
      const chunkResults = await original(chunk, ...args);
      results.push(...chunkResults);
    }
    return results;
  };
}

export class PcsPositionExecutor {
  private chain: Chain;
  private connection: Connection;
  private readConnection: Connection;
  private positionMap: PositionMap;
  private busy = false;

  public solPaused = false;
  public solPausedAt: number | null = null;
  public drawdownPaused = false;
  public drawdownPausedAt: number | null = null;
  public drawdownWarning = false;
  public lastSkipReason: string | null = null;
  public cachedSolBalance: number | null = null;
  public rentPerPosition: number = 0.0090132; // Same as Byreal (Raydium fork)
  public poolIdToMints: Map<string, string> = new Map();

  constructor(connection: Connection, positionMap: PositionMap) {
    patchSdkForPcs(); // Patch SDK before creating Chain

    this.connection = connection;
    this.readConnection = config.readRpcUrl
      ? new Connection(config.readRpcUrl, { commitment: 'confirmed' })
      : connection;
    patchConnectionChunking(this.readConnection);

    this.chain = new Chain({
      connection: this.readConnection,
      programId: config.pcsProgramId,
    });
    this.positionMap = positionMap;

    // Fetch initial SOL balance
    this.getSolBalance()
      .then((b) => {
        this.cachedSolBalance = b;
      })
      .catch(() => {});
  }

  get isBusy(): boolean {
    return this.busy;
  }

  private stripSdkComputeUnitPriceInstructions(
    instructions: TransactionInstruction[],
  ): TransactionInstruction[] {
    return instructions.filter((ix) => {
      if (!ix.programId.equals(ComputeBudgetProgram.programId)) return true;
      const data = Buffer.from(ix.data);
      return data[0] !== 3;
    });
  }

  private async makeSdkTransactionWithMinimumPriorityFee(result: {
    instructions: TransactionInstruction[];
    signers?: any[];
  }): Promise<any> {
    return makeTransaction({
      connection: this.connection,
      payerPublicKey: getUserAddress(),
      instructions: this.stripSdkComputeUnitPriceInstructions(result.instructions),
      signers: result.signers ?? [],
      options: { computeUnitPrice: MIN_SDK_PRIORITY_FEE_MICROLAMPORTS },
    });
  }

  private acquire(op: string): boolean {
    if (this.busy) {
      logger.warn(MODULE, `Executor busy, skipping ${op}`);
      return false;
    }
    this.busy = true;
    return true;
  }

  private release(): void {
    this.busy = false;
  }

  // ===== Token checks =====

  isTokenBlacklisted(pool: string): boolean {
    if (!pool) return false;
    const parts = pool.split('/');
    if (parts.length !== 2) return config.tokenBlacklist.has(pool);
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    if (config.pcsSkipSol && (parts[0] === SOL_MINT || parts[1] === SOL_MINT)) return true;
    return config.tokenBlacklist.has(parts[0]) || config.tokenBlacklist.has(parts[1]);
  }

  hasMapping(targetNftMint: string): boolean {
    return !!this.positionMap.get(targetNftMint);
  }

  updateConnection(conn: Connection): void {
    this.connection = conn;
  }

  // ===== RPC helpers =====

  async getSolBalance(): Promise<number> {
    try {
      return (await this.readConnection.getBalance(getUserAddress())) / 1e9;
    } catch {
      return 0;
    }
  }

  private async getTokenBalance(owner: PublicKey, mint: PublicKey): Promise<BN> {
    try {
      if (mint.equals(NATIVE_MINT)) {
        const lamports = await this.readConnection.getBalance(owner);
        const reserved = 0.05 * 1e9; // Keep 0.05 SOL for TX fees
        const available = Math.max(0, lamports - reserved);
        return new BN(Math.floor(available));
      }

      // Try TOKEN_PROGRAM_ID first, then TOKEN_2022_PROGRAM_ID
      for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
        try {
          const accounts = await this.readConnection.getTokenAccountsByOwner(owner, {
            mint,
            programId,
          });
          if (accounts.value.length > 0) {
            let total = new BN(0);
            for (const acc of accounts.value) {
              const data = acc.account.data;
              const amount = new BN(data.slice(64, 72), 'le');
              total = total.add(amount);
            }
            return total;
          }
        } catch {
          /* try next */
        }
      }
      return new BN(0);
    } catch {
      return new BN(0);
    }
  }

  /**
   * Read target's position info with retry (RPC lag after open can cause null reads).
   */
  private async retryGetPosition(
    nftMint: PublicKey,
  ): Promise<IGetPositionInfoByNftMintReturn | null> {
    for (let i = 0; i < 5; i++) {
      try {
        const info = await this.chain.getPositionInfoByNftMint(nftMint);
        if (info) return info;
      } catch {
        /* retry */
      }
      const delay = i === 0 ? 2000 : 3000 * i;
      await new Promise((r) => setTimeout(r, delay));
    }
    return null;
  }

  /**
   * Retry a function on transient errors (blockhash expired, RPC timeout, etc.)
   */
  private async retryOnTransient<T>(
    fn: () => Promise<T>,
    label: string,
    maxRetries = 3,
  ): Promise<T> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await fn();
      } catch (err: any) {
        const msg = err.message || '';
        const isTransient =
          /blockhash/i.test(msg) ||
          /timeout/i.test(msg) ||
          /429/i.test(msg) ||
          /ECONNRESET/i.test(msg) ||
          /fetch failed/i.test(msg);
        if (isTransient && i < maxRetries - 1) {
          logger.warn(
            MODULE,
            `${label}: transient error (${msg.slice(0, 80)}), retry ${i + 1}/${maxRetries}...`,
          );
          await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
          continue;
        }
        throw err;
      }
    }
    throw new Error(`${label}: max retries exceeded`);
  }

  private isRetryableSimError(err: any): boolean {
    const msg = err?.message || '';
    return /simulation/i.test(msg) || /InstructionError/i.test(msg) || /0x1/i.test(msg);
  }

  private isTransientError(err: any): boolean {
    const msg = err?.message || '';
    return /502|503|504|429|ECONNRESET|ETIMEDOUT|ENOTFOUND|timeout|Too Many Requests|Internal server error|Blockhash not found|block height exceeded|has expired|PriceSlippageCheck|0x1785/i.test(
      msg,
    );
  }

  /**
   * Verify TX actually succeeded on-chain.
   */
  private async verifyTxSuccess(txSig: string): Promise<boolean> {
    try {
      const latestBlockhash = await this.connection.getLatestBlockhash();
      await this.connection.confirmTransaction(
        { signature: txSig, ...latestBlockhash },
        'confirmed',
      );
      const tx = await this.readConnection.getParsedTransaction(txSig, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      return tx !== null && !tx.meta?.err;
    } catch {
      return false;
    }
  }

  /**
   * Extract actual locked SOL from TX's innerInstructions.
   */
  private async extractLockedSolFromTx(txSig: string): Promise<number | null> {
    try {
      const tx = await this.readConnection.getParsedTransaction(txSig, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      if (!tx?.meta?.innerInstructions) return null;
      const botWallet = getUserAddress().toBase58();
      let totalLamports = 0;
      for (const inner of tx.meta.innerInstructions) {
        for (const ix of inner.instructions) {
          const parsed = (ix as any).parsed;
          if (!parsed) continue;
          if ((ix as any).program !== 'system') continue;
          const info = parsed.info;
          if (!info || info.source !== botWallet) continue;
          if (parsed.type === 'createAccount' || parsed.type === 'transfer') {
            totalLamports += info.lamports || 0;
          }
        }
      }
      return totalLamports > 0 ? totalLamports / 1e9 : null;
    } catch {
      return null;
    }
  }

  // ===== Core Operations =====

  async copyOpenPosition(
    targetNftMint: string,
    poolId: string,
    refererPosition: string | null,
    targetWallet?: string,
  ): Promise<string | null> {
    const userAddress = getUserAddress();

    if (this.positionMap.get(targetNftMint)) {
      logger.warn(MODULE, `Already have mapping for ${targetNftMint.slice(0, 8)}, skipping`);
      return null;
    }

    logger.info(MODULE, `Copying position: pool=${poolId.slice(0, 8)}`, {
      targetNft: targetNftMint.slice(0, 8),
    });

    if (config.dryRun) {
      logger.info(MODULE, '[DRY RUN] Would copy open position');
      return 'dry-run-pcs-open';
    }

    if (!this.acquire('copyOpenPosition')) return null;

    try {
      // 1. Read target position
      const positionInfo = await this.retryGetPosition(new PublicKey(targetNftMint));
      if (!positionInfo) {
        logger.error(MODULE, `Cannot read target position: ${targetNftMint}`);
        return null;
      }

      const { rawPositionInfo, rawPoolInfo } = positionInfo;
      const tickLower = rawPositionInfo.tickLower;
      const tickUpper = rawPositionInfo.tickUpper;
      const mintA = rawPoolInfo.mintA;
      const mintB = rawPoolInfo.mintB;
      const mintAStr = mintA.toBase58();
      const mintBStr = mintB.toBase58();
      const poolLabel = `${mintAStr}/${mintBStr}`;

      // 2. Filters: blacklist, pump, TVL
      if (this.isTokenBlacklisted(poolLabel)) {
        this.lastSkipReason = '黑名單代幣';
        return null;
      }

      if (config.pumpFilterMode !== 'off') {
        const pumpMint = mintAStr.toLowerCase().includes('pump')
          ? mintAStr
          : mintBStr.toLowerCase().includes('pump')
            ? mintBStr
            : null;
        if (pumpMint && !isPumpApproved(pumpMint)) {
          if (config.pumpFilterMode === 'full') {
            this.lastSkipReason = 'Pump 代幣過濾';
            return null;
          }
          if (isPumpRejected(pumpMint)) {
            this.lastSkipReason = 'Pump 代幣已拒絕';
            return null;
          }
          if (!isPumpPending(pumpMint)) {
            addPumpPending({
              mint: pumpMint,
              symbol: '',
              pool: poolLabel,
              targetWallet: targetWallet || '',
              detectedAt: Date.now(),
            });
            notifyPumpApproval(pumpMint, '', poolLabel).catch(() => {});
          }
          this.lastSkipReason = 'Pump 代幣等待確認';
          return null;
        }
      }

      if (config.minPoolTvl > 0) {
        for (const [mint, label] of [
          [mintAStr, 'mintA'],
          [mintBStr, 'mintB'],
        ] as [string, string][]) {
          if (config.poolTvlWhitelist.has(mint)) continue;
          if (STABLE_MINTS.has(mint)) continue;
          const tvl = await checkTokenLiquidity(mint);
          if (tvl === null || tvl < config.minPoolTvl) {
            this.lastSkipReason = `TVL 不足 (${label} $${tvl !== null ? tvl.toFixed(0) : '?'} < $${config.minPoolTvl})`;
            return null;
          }
        }
      }

      // Duplicate tick range check
      if (config.skipSameTickRange && targetWallet) {
        if (this.positionMap.hasDuplicateTickRange(targetWallet, poolLabel, tickLower, tickUpper)) {
          this.lastSkipReason = '重複 tick 範圍';
          return null;
        }
      }

      // 3. Calculate scaled amounts
      const targetA = scaleAmount(positionInfo.tokenA.amount, targetWallet);
      const targetB = scaleAmount(positionInfo.tokenB.amount, targetWallet);
      logger.info(
        MODULE,
        `Target deposited: A=${positionInfo.tokenA.uiAmount}, B=${positionInfo.tokenB.uiAmount}`,
      );

      // 4. Check balances + swap if needed
      let ourBalanceA = await this.getTokenBalance(userAddress, mintA);
      let ourBalanceB = await this.getTokenBalance(userAddress, mintB);

      // Swap for tokenA
      if (ourBalanceA.lt(targetA) && !targetA.isZero()) {
        const deficit = targetA.sub(ourBalanceA);
        let txSig: string | null = null;
        if (mintA.equals(NATIVE_MINT)) {
          if (mintAStr !== USDC)
            txSig = await swapForToken(this.connection, USDC, mintAStr, deficit.toString());
        } else {
          if (!ourBalanceB.isZero())
            txSig = await swapForToken(this.connection, mintBStr, mintAStr, deficit.toString());
          if (!txSig && mintAStr !== USDC)
            txSig = await swapForToken(this.connection, USDC, mintAStr, deficit.toString());
        }
        if (!txSig) {
          notifySwapFailed(mintAStr, lastSwapError || 'all methods failed');
          return null;
        }
        const addedA = await getActualSwapOutput(
          this.readConnection,
          txSig,
          mintAStr,
          userAddress.toBase58(),
        );
        if (addedA) ourBalanceA = ourBalanceA.add(new BN(addedA));
        else {
          await new Promise((r) => setTimeout(r, 5000));
          ourBalanceA = await this.getTokenBalance(userAddress, mintA);
        }
      }

      // Swap for tokenB
      if (ourBalanceB.lt(targetB) && !targetB.isZero()) {
        const deficit = targetB.sub(ourBalanceB);
        let txSig: string | null = null;
        if (mintB.equals(NATIVE_MINT)) {
          if (mintBStr !== USDC)
            txSig = await swapForToken(this.connection, USDC, mintBStr, deficit.toString());
        } else {
          if (mintBStr !== USDC)
            txSig = await swapForToken(this.connection, USDC, mintBStr, deficit.toString());
          if (!txSig && !ourBalanceA.isZero())
            txSig = await swapForToken(this.connection, mintAStr, mintBStr, deficit.toString());
        }
        if (!txSig) {
          notifySwapFailed(mintBStr, lastSwapError || 'all methods failed');
          return null;
        }
        const addedB = await getActualSwapOutput(
          this.readConnection,
          txSig,
          mintBStr,
          userAddress.toBase58(),
        );
        if (addedB) ourBalanceB = ourBalanceB.add(new BN(addedB));
        else {
          await new Promise((r) => setTimeout(r, 5000));
          ourBalanceB = await this.getTokenBalance(userAddress, mintB);
        }
      }

      if (ourBalanceA.isZero() && ourBalanceB.isZero()) {
        logger.error(MODULE, 'No balance for either token after swaps');
        return null;
      }

      // 5. Build + send position TX (with retry)
      const MAX_OPEN_ATTEMPTS = 2;
      for (let attempt = 0; attempt < MAX_OPEN_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 2000));
          ourBalanceA = await this.getTokenBalance(userAddress, mintA);
          ourBalanceB = await this.getTokenBalance(userAddress, mintB);
        }

        let base: 'MintA' | 'MintB';
        let baseAmount: BN;
        let otherAmountMax: BN;

        if (targetA.gt(new BN(0))) {
          base = 'MintA';
          baseAmount = BN.min(targetA, ourBalanceA);
          otherAmountMax = BN.min(targetB, ourBalanceB);
        } else {
          base = 'MintB';
          baseAmount = BN.min(targetB, ourBalanceB);
          otherAmountMax = BN.min(targetA, ourBalanceA);
        }

        try {
          const { instructions, signers, nftAddress } = await this.chain.createPositionInstructions(
            {
              userAddress,
              poolInfo: rawPoolInfo,
              tickLower,
              tickUpper,
              base,
              baseAmount,
              otherAmountMax,
            },
          );

          const txSig = await this.retryOnTransient(async () => {
            const tx = await makeTransaction({
              connection: this.connection,
              payerPublicKey: userAddress,
              instructions,
              signers,
              options: { computeUnitPrice: MIN_SDK_PRIORITY_FEE_MICROLAMPORTS },
            });
            const signed = await signerCallback(tx);
            return this.connection.sendTransaction(signed, { skipPreflight: config.skipPreflight });
          }, 'buildSignSend');

          // Save mapping immediately
          if (nftAddress) {
            this.positionMap.set(
              targetNftMint,
              nftAddress,
              poolLabel,
              targetWallet,
              tickLower,
              tickUpper,
              'pancakeswap',
            );
            this.positionMap.setLockedSol(targetNftMint, this.rentPerPosition);
            this.positionMap.setTargetLiquidity(
              targetNftMint,
              positionInfo.rawPositionInfo.liquidity.toString(),
            );
            this.poolIdToMints.set(poolId, poolLabel);
          }

          // Confirm (best-effort)
          try {
            const bh = await this.connection.getLatestBlockhash();
            await this.connection.confirmTransaction({ signature: txSig, ...bh }, 'confirmed');
          } catch {
            /* mapping already saved */
          }

          // Extract actual locked SOL (non-blocking)
          this.extractLockedSolFromTx(txSig)
            .then((actual) => {
              if (actual !== null) this.positionMap.setLockedSol(targetNftMint, actual);
            })
            .catch(() => {});

          return txSig;
        } catch (openErr: any) {
          if (attempt < MAX_OPEN_ATTEMPTS - 1 && this.isRetryableSimError(openErr)) continue;
          throw openErr;
        }
      }
      return null;
    } catch (err: any) {
      logger.error(MODULE, `Open position failed: ${err.message}`);
      notifyOpenFailed(err, targetNftMint);
      if (/insufficient lamports/i.test(err.message)) {
        this.solPaused = true;
        this.solPausedAt = Date.now();
        notifySolInsufficient(this.cachedSolBalance ?? 0);
      }
      return null;
    } finally {
      this.release();
      this.getSolBalance()
        .then((b) => {
          this.cachedSolBalance = b;
        })
        .catch(() => {});
    }
  }

  async copyIncreaseLiquidity(
    targetNftMint: string,
    targetWallet?: string,
  ): Promise<string | null> {
    const myNftMint = this.positionMap.get(targetNftMint);
    if (!myNftMint) return null;

    if (config.dryRun) return 'dry-run-pcs-increase';
    if (!this.acquire('copyIncreaseLiquidity')) return null;

    try {
      // Wait + retry to handle RPC lag after target's increase TX
      await new Promise((r) => setTimeout(r, 2000));

      const targetPosition = await this.retryGetPosition(new PublicKey(targetNftMint));
      if (!targetPosition) {
        logger.error(MODULE, `Cannot read target position: ${targetNftMint.slice(0, 8)}`);
        return null;
      }

      const { rawPoolInfo } = targetPosition;
      const mintA = rawPoolInfo.mintA;
      const mintB = rawPoolInfo.mintB;
      const mintAStr = mintA.toBase58();
      const mintBStr = mintB.toBase58();
      const userAddress = getUserAddress();

      const fullTargetA = scaleAmount(targetPosition.tokenA.amount, targetWallet);
      const fullTargetB = scaleAmount(targetPosition.tokenB.amount, targetWallet);

      // Read our existing position to calculate delta (how much MORE we need to add)
      const myPosition = await this.retryGetPosition(new PublicKey(myNftMint));
      const myAmountA = myPosition ? myPosition.tokenA.amount : new BN(0);
      const myAmountB = myPosition ? myPosition.tokenB.amount : new BN(0);

      // Delta = target amounts - our existing position amounts (only positive deltas matter)
      const targetA = fullTargetA.gt(myAmountA) ? fullTargetA.sub(myAmountA) : new BN(0);
      const targetB = fullTargetB.gt(myAmountB) ? fullTargetB.sub(myAmountB) : new BN(0);

      if (targetA.isZero() && targetB.isZero()) {
        logger.info(MODULE, 'Our position already matches or exceeds target, no increase needed');
        return null;
      }

      logger.info(
        MODULE,
        `Increase delta: A=${targetA.toString()}, B=${targetB.toString()} (full target: A=${fullTargetA.toString()}, B=${fullTargetB.toString()}, our pos: A=${myAmountA.toString()}, B=${myAmountB.toString()})`,
      );

      let ourBalanceA = await this.getTokenBalance(userAddress, mintA);
      let ourBalanceB = await this.getTokenBalance(userAddress, mintB);

      // Swap for tokenA
      if (ourBalanceA.lt(targetA) && !targetA.isZero()) {
        const deficit = targetA.sub(ourBalanceA);
        let txSig: string | null = null;
        if (mintA.equals(NATIVE_MINT)) {
          if (mintAStr !== USDC)
            txSig = await swapForToken(this.connection, USDC, mintAStr, deficit.toString());
        } else {
          if (!ourBalanceB.isZero())
            txSig = await swapForToken(this.connection, mintBStr, mintAStr, deficit.toString());
          if (!txSig && mintAStr !== USDC)
            txSig = await swapForToken(this.connection, USDC, mintAStr, deficit.toString());
        }
        if (txSig) {
          const added = await getActualSwapOutput(
            this.readConnection,
            txSig,
            mintAStr,
            userAddress.toBase58(),
          );
          if (added) ourBalanceA = ourBalanceA.add(new BN(added));
          else {
            await new Promise((r) => setTimeout(r, 5000));
            ourBalanceA = await this.getTokenBalance(userAddress, mintA);
          }
        }
      }

      // Swap for tokenB
      if (ourBalanceB.lt(targetB) && !targetB.isZero()) {
        const deficit = targetB.sub(ourBalanceB);
        let txSig: string | null = null;
        if (mintB.equals(NATIVE_MINT)) {
          if (mintBStr !== USDC)
            txSig = await swapForToken(this.connection, USDC, mintBStr, deficit.toString());
        } else {
          if (mintBStr !== USDC)
            txSig = await swapForToken(this.connection, USDC, mintBStr, deficit.toString());
          if (!txSig && !ourBalanceA.isZero())
            txSig = await swapForToken(this.connection, mintAStr, mintBStr, deficit.toString());
        }
        if (txSig) {
          const added = await getActualSwapOutput(
            this.readConnection,
            txSig,
            mintBStr,
            userAddress.toBase58(),
          );
          if (added) ourBalanceB = ourBalanceB.add(new BN(added));
          else {
            await new Promise((r) => setTimeout(r, 5000));
            ourBalanceB = await this.getTokenBalance(userAddress, mintB);
          }
        }
      }

      if (ourBalanceA.isZero() && ourBalanceB.isZero()) return null;

      const MAX_ATTEMPTS = 2;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 2000));
          ourBalanceA = await this.getTokenBalance(userAddress, mintA);
          ourBalanceB = await this.getTokenBalance(userAddress, mintB);
        }

        let base: 'MintA' | 'MintB';
        let baseAmount: BN;
        let otherAmountMax: BN;

        if (targetA.gt(new BN(0))) {
          base = 'MintA';
          baseAmount = BN.min(targetA, ourBalanceA);
          otherAmountMax = BN.min(targetB, ourBalanceB);
        } else {
          base = 'MintB';
          baseAmount = BN.min(targetB, ourBalanceB);
          otherAmountMax = BN.min(targetA, ourBalanceA);
        }

        try {
          const txSig = await this.retryOnTransient(
            async () => {
              const result = await this.chain.addLiquidityInstructions({
                userAddress,
                nftMint: new PublicKey(myNftMint),
                base,
                baseAmount,
                otherAmountMax,
                computeBudgetOptions: { computeUnitPrice: MIN_SDK_PRIORITY_FEE_MICROLAMPORTS },
              });
              const signed = await signerCallback(result.transaction);
              return this.connection.sendTransaction(signed, {
                skipPreflight: config.skipPreflight,
              });
            },
            `addLiquidity(${myNftMint.slice(0, 8)})`,
          );
          logger.info(MODULE, `Liquidity increased: ${txSig}`);

          // Update stored target liquidity for proportional decrease tracking
          try {
            const updatedTarget = await this.retryGetPosition(new PublicKey(targetNftMint));
            if (updatedTarget) {
              this.positionMap.setTargetLiquidity(
                targetNftMint,
                updatedTarget.rawPositionInfo.liquidity.toString(),
              );
            }
          } catch {
            /* non-critical */
          }

          return txSig;
        } catch (err: any) {
          if (attempt < MAX_ATTEMPTS - 1 && this.isRetryableSimError(err)) continue;
          throw err;
        }
      }
      return null;
    } catch (err: any) {
      logger.error(MODULE, `Increase liquidity failed: ${err.message}`);
      return null;
    } finally {
      this.release();
    }
  }

  async copyDecreaseLiquidity(
    targetNftMint: string,
  ): Promise<{ txSig: string; type: 'DECREASE' | 'COLLECT_FEE' } | null> {
    const myNftMint = this.positionMap.get(targetNftMint);
    if (!myNftMint) return null;

    // Read target's current liquidity to determine: full decrease, partial decrease, or fee collection
    let targetCurrentLiq: BN | null = null;
    try {
      const targetPos = await this.retryGetPosition(new PublicKey(targetNftMint));
      if (targetPos) {
        targetCurrentLiq = targetPos.rawPositionInfo.liquidity;
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
          const removedLiq = storedLiq.sub(targetCurrentLiq);
          const pctNumerator = removedLiq.mul(new BN(10000));
          const pctBps = pctNumerator.div(storedLiq).toNumber(); // basis points removed
          logger.info(
            MODULE,
            `Partial decrease detected: target ${storedLiq.toString()} -> ${targetCurrentLiq.toString()} (removed ${pctBps / 100}%)`,
          );

          try {
            const myPos = await this.retryGetPosition(new PublicKey(myNftMint));
            if (myPos) {
              const myLiq = myPos.rawPositionInfo.liquidity;
              // ourDecrease = myLiq * removedLiq / storedLiq
              const calcAmount = myLiq.mul(removedLiq).div(storedLiq);
              decreaseAmount = calcAmount;
              if (calcAmount.isZero()) {
                logger.info(
                  MODULE,
                  `Proportional decrease rounds to zero, collecting fees instead`,
                );
              } else {
                logger.info(
                  MODULE,
                  `Our decrease: ${calcAmount.toString()} of ${myLiq.toString()}`,
                );
              }
            }
          } catch (err: any) {
            logger.warn(MODULE, `Cannot read our position for proportional calc: ${err.message}`);
          }

          // Update stored target liquidity for next decrease
          this.positionMap.setTargetLiquidity(targetNftMint, targetCurrentLiq.toString());
        } else {
          // Target liquidity >= stored — likely fee collection only (increase happened?)
          logger.info(
            MODULE,
            `Target liquidity ${targetCurrentLiq.toString()} >= stored ${storedLiq.toString()}, collecting fees`,
          );
          decreaseAmount = new BN(0);
        }
      } else {
        // No stored liquidity (legacy position) — can't calculate proportion, collect fees
        logger.info(
          MODULE,
          `No stored targetLiquidity for ${targetNftMint.slice(0, 8)}, collecting fees (legacy position)`,
        );
        decreaseAmount = new BN(0);
      }
    }
    // targetCurrentLiq is null or zero → full decrease (decreaseAmount stays null)

    // Fee collection only (decreaseAmount is zero)
    if (decreaseAmount && decreaseAmount.isZero()) {
      if (config.dryRun) return { txSig: 'dry-run-pcs-collect-fee', type: 'COLLECT_FEE' };
      if (!this.acquire('collectFees')) return null;

      try {
        const txSig = await this.retryOnTransient(
          async () => {
            const result = await this.chain.collectFeesInstructions({
              userAddress: getUserAddress(),
              nftMint: new PublicKey(myNftMint),
            });
            const tx = await this.makeSdkTransactionWithMinimumPriorityFee(result);
            const signed = await signerCallback(tx);
            return this.connection.sendTransaction(signed, { skipPreflight: config.skipPreflight });
          },
          `collectFees(${myNftMint.slice(0, 8)})`,
        );
        logger.info(MODULE, `Fees collected: ${myNftMint.slice(0, 8)} TX: ${txSig}`);
        return { txSig, type: 'COLLECT_FEE' };
      } catch (err: any) {
        logger.error(MODULE, `Collect fees failed: ${err.message}`);
        return null;
      } finally {
        this.release();
      }
    }

    // Decrease liquidity (full or proportional)
    const isPartial = decreaseAmount !== null;
    logger.info(
      MODULE,
      `${isPartial ? 'Partial' : 'Full'} decrease for our NFT: ${myNftMint.slice(0, 8)}...`,
    );

    if (config.dryRun) return { txSig: 'dry-run-pcs-decrease', type: 'DECREASE' };
    if (!this.acquire('copyDecreaseLiquidity')) return null;

    try {
      const MAX_DECREASE_ATTEMPTS = 2;
      for (let attempt = 0; attempt < MAX_DECREASE_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          logger.info(
            MODULE,
            `Retrying decrease (attempt ${attempt + 1}/${MAX_DECREASE_ATTEMPTS})...`,
          );
          await new Promise((r) => setTimeout(r, 2000));
        }

        try {
          if (isPartial) {
            // Partial decrease — use decreaseLiquidityInstructions with exact amount
            const myPos = await this.retryGetPosition(new PublicKey(myNftMint));
            if (!myPos) {
              logger.error(MODULE, `Cannot read our position: ${myNftMint.slice(0, 8)}`);
              return null;
            }
            const liquidityToDecrease = BN.min(decreaseAmount!, myPos.rawPositionInfo.liquidity);

            if (liquidityToDecrease.isZero()) {
              logger.info(MODULE, `Our position already has zero liquidity, collecting fees`);
              try {
                const feeResult = await this.chain.collectFeesInstructions({
                  userAddress: getUserAddress(),
                  nftMint: new PublicKey(myNftMint),
                });
                const feeTx = await this.makeSdkTransactionWithMinimumPriorityFee(feeResult);
                const feeSigned = await signerCallback(feeTx);
                const feeTxSig = await this.connection.sendTransaction(feeSigned, {
                  skipPreflight: config.skipPreflight,
                });
                logger.info(MODULE, `Fees collected: ${feeTxSig}`);
                return { txSig: feeTxSig, type: 'COLLECT_FEE' };
              } catch (feeErr: any) {
                logger.error(MODULE, `Collect fees failed: ${feeErr.message}`);
                return null;
              }
            }

            const txSig = await this.retryOnTransient(
              async () => {
                const result = await this.chain.decreaseLiquidityInstructions({
                  userAddress: getUserAddress(),
                  nftMint: new PublicKey(myNftMint),
                  liquidity: liquidityToDecrease,
                });
                const tx = await this.makeSdkTransactionWithMinimumPriorityFee(result);
                const signed = await signerCallback(tx);
                return this.connection.sendTransaction(signed, {
                  skipPreflight: config.skipPreflight,
                });
              },
              `pcsPartialDecrease(${myNftMint.slice(0, 8)})`,
            );
            logger.info(MODULE, `Partial liquidity decreased: ${txSig}`);

            // Queue received tokens as pending swaps
            try {
              const tx = await this.readConnection.getParsedTransaction(txSig, {
                maxSupportedTransactionVersion: 0,
                commitment: 'confirmed',
              });
              if (tx) {
                const botStr = getUserAddress().toBase58();
                const pre = tx.meta?.preTokenBalances || [];
                const post = tx.meta?.postTokenBalances || [];
                const preMap = new Map<string, bigint>();
                for (const b of pre) {
                  if (b.owner === botStr && b.uiTokenAmount.decimals > 0) {
                    preMap.set(b.mint, BigInt(b.uiTokenAmount.amount));
                  }
                }
                for (const b of post) {
                  if (b.owner !== botStr || b.uiTokenAmount.decimals === 0) continue;
                  const postAmt = BigInt(b.uiTokenAmount.amount);
                  const preAmt = preMap.get(b.mint) || 0n;
                  if (postAmt > preAmt) {
                    const diff = (postAmt - preAmt).toString();
                    logger.info(
                      MODULE,
                      `Received from partial decrease: ${b.mint.slice(0, 8)} = ${diff}`,
                    );
                  }
                }
              }
            } catch {
              /* non-critical */
            }

            return { txSig, type: 'DECREASE' };
          } else {
            // Full decrease
            const txSig = await this.retryOnTransient(
              async () => {
                const result = await this.chain.decreaseFullLiquidityInstructions({
                  userAddress: getUserAddress(),
                  nftMint: new PublicKey(myNftMint),
                  closePosition: false,
                });
                const tx = await this.makeSdkTransactionWithMinimumPriorityFee(result);
                const signed = await signerCallback(tx);
                return this.connection.sendTransaction(signed, {
                  skipPreflight: config.skipPreflight,
                });
              },
              `decreaseLiquidity(${myNftMint.slice(0, 8)})`,
            );
            logger.info(MODULE, `Liquidity decreased (full): ${txSig}`);
            return { txSig, type: 'DECREASE' };
          }
        } catch (decErr: any) {
          if (
            attempt < MAX_DECREASE_ATTEMPTS - 1 &&
            (this.isRetryableSimError(decErr) || this.isTransientError(decErr))
          ) {
            logger.warn(
              MODULE,
              `Decrease attempt ${attempt + 1} failed (${(decErr.message || '').slice(0, 100)}), will retry...`,
            );
            continue;
          }
          throw decErr;
        }
      }

      return null; // should not reach here
    } catch (err: any) {
      logger.error(MODULE, `Decrease failed: ${err.message}`);
      return null;
    } finally {
      this.release();
    }
  }

  async copyClosePosition(targetNftMint: string): Promise<string | null> {
    const myNftMint = this.positionMap.get(targetNftMint);
    if (!myNftMint) return null;

    if (config.dryRun) return 'dry-run-pcs-close';
    if (!this.acquire('copyClosePosition')) return null;

    try {
      let txSig: string | null = null;
      const MAX_CLOSE_ATTEMPTS = 3;

      for (let attempt = 0; attempt < MAX_CLOSE_ATTEMPTS; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 2000));

        try {
          txSig = await this.retryOnTransient(
            async () => {
              const result = await this.chain.decreaseFullLiquidityInstructions({
                userAddress: getUserAddress(),
                nftMint: new PublicKey(myNftMint),
                closePosition: true,
              });
              const tx = await this.makeSdkTransactionWithMinimumPriorityFee(result);
              const signed = await signerCallback(tx);
              return this.connection.sendTransaction(signed, {
                skipPreflight: config.skipPreflight,
              });
            },
            `closePosition(${myNftMint.slice(0, 8)})`,
          );
        } catch (err: any) {
          if (
            attempt < MAX_CLOSE_ATTEMPTS - 1 &&
            (this.isRetryableSimError(err) || this.isTransientError(err))
          )
            continue;
          throw err;
        }

        if (!txSig) return null;

        const success = await this.verifyTxSuccess(txSig);
        if (success) break;

        if (attempt < MAX_CLOSE_ATTEMPTS - 1) {
          logger.warn(MODULE, `Close TX failed on-chain: ${txSig.slice(0, 8)}, retrying...`);
          txSig = null;
          continue;
        }
        notifyCloseFailed(myNftMint, 'on-chain failure after max attempts', MAX_CLOSE_ATTEMPTS);
        return null;
      }

      if (!txSig) return null;

      logger.info(MODULE, `Position closed: ${myNftMint.slice(0, 8)} TX: ${txSig}`);
      this.positionMap.delete(targetNftMint);

      // Track received tokens as pending swaps (reuse Byreal's pending-swaps file)
      try {
        const tx = await this.readConnection.getParsedTransaction(txSig, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });
        if (tx) {
          const botStr = getUserAddress().toBase58();
          const pre = tx.meta?.preTokenBalances || [];
          const post = tx.meta?.postTokenBalances || [];
          const preMap = new Map<string, bigint>();
          for (const b of pre) {
            if (b.owner === botStr && b.uiTokenAmount.decimals > 0) {
              preMap.set(b.mint, BigInt(b.uiTokenAmount.amount));
            }
          }
          for (const b of post) {
            if (b.owner !== botStr || b.uiTokenAmount.decimals === 0) continue;
            const postAmt = BigInt(b.uiTokenAmount.amount);
            const preAmt = preMap.get(b.mint) || 0n;
            if (postAmt > preAmt) {
              const diff = (postAmt - preAmt).toString();
              logger.info(MODULE, `Received from close: ${b.mint.slice(0, 8)} = ${diff}`);
              // Note: pending swap tracking delegated to Byreal executor's recordBotCloseReceived
            }
          }
        }
      } catch {
        /* non-critical */
      }

      return txSig;
    } catch (err: any) {
      logger.error(
        MODULE,
        `Close position failed: ${typeof err?.message === 'string' ? err.message : JSON.stringify(err)}`,
      );
      notifyCloseFailed(myNftMint, err, 0);
      return null;
    } finally {
      this.release();
    }
  }

  async manualClosePosition(ourNftMint: string): Promise<string | null> {
    const targetNft = this.positionMap.findByOurNft(ourNftMint);

    if (config.dryRun) return 'dry-run-pcs-manual-close';
    if (!this.acquire('manualClosePosition')) return null;

    try {
      const txSig = await this.retryOnTransient(
        async () => {
          const result = await this.chain.decreaseFullLiquidityInstructions({
            userAddress: getUserAddress(),
            nftMint: new PublicKey(ourNftMint),
            closePosition: true,
          });
          const tx = await this.makeSdkTransactionWithMinimumPriorityFee(result);
          const signed = await signerCallback(tx);
          return this.connection.sendTransaction(signed, { skipPreflight: config.skipPreflight });
        },
        `manualClose(${ourNftMint.slice(0, 8)})`,
      );

      logger.info(MODULE, `Manual close done: ${ourNftMint.slice(0, 8)} TX: ${txSig}`);
      if (targetNft) this.positionMap.delete(targetNft);
      return txSig;
    } catch (err: any) {
      logger.error(MODULE, `Manual close failed: ${err.message}`);
      return null;
    } finally {
      this.release();
    }
  }

  // ===== Maintenance =====

  async initRentPerPosition(): Promise<void> {
    try {
      const conn = this.readConnection;
      // Same account sizes as Byreal (Raydium fork): Position PDA 281, NFT Mint(T22) 270, ATA(T22) 170
      const [rentPDA, rentMint, rentATA] = await Promise.all([
        conn.getMinimumBalanceForRentExemption(281),
        conn.getMinimumBalanceForRentExemption(270),
        conn.getMinimumBalanceForRentExemption(170),
      ]);
      const METADATA_TRANSFER = 1_322_400;
      const totalLamports = rentPDA + rentMint + METADATA_TRANSFER + rentATA;
      this.rentPerPosition = totalLamports / 1e9;
      logger.info(MODULE, `PCS rent per position: ${this.rentPerPosition} SOL`);
    } catch (err: any) {
      logger.warn(MODULE, `PCS rent init failed (using fallback): ${err.message}`);
    }
  }

  backfillLockedSol(): void {
    let count = 0;
    for (const [targetNft, entry] of Object.entries(this.positionMap.toJSON())) {
      if ((entry as any).dex === 'pancakeswap' && (entry as any).lockedSol == null) {
        this.positionMap.setLockedSol(targetNft, this.rentPerPosition);
        count++;
      }
    }
    if (count > 0) logger.info(MODULE, `Backfilled lockedSol for ${count} PCS positions`);
  }

  /**
   * Check if a given NFT is a PancakeSwap position (for reconcile protection).
   */
  async isPcsPosition(nftMint: string): Promise<boolean> {
    try {
      const info = await this.chain.getPositionInfoByNftMint(new PublicKey(nftMint));
      return info !== null;
    } catch {
      return false;
    }
  }

  /**
   * Reconcile PCS positions: scan for orphans and close them.
   */
  async reconcilePcsPositions(opQueue: OperationQueue): Promise<void> {
    const entries = this.positionMap.toJSON();
    const orphans: string[] = [];

    for (const [targetNft, entry] of Object.entries(entries)) {
      if ((entry as any).dex !== 'pancakeswap') continue;

      try {
        const targetPos = await this.chain.getPositionInfoByNftMint(new PublicKey(targetNft));
        if (!targetPos) {
          logger.info(
            MODULE,
            `Reconcile: target ${targetNft.slice(0, 8)} no longer exists, orphan detected`,
          );
          orphans.push(targetNft);
        }
      } catch {
        /* skip on RPC error */
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    if (orphans.length === 0) return;
    logger.info(MODULE, `Reconcile: found ${orphans.length} PCS orphans, enqueuing close...`);

    for (const targetNft of orphans) {
      opQueue.enqueue(`PCS-RECONCILE:${targetNft.slice(0, 8)}`, 'NORMAL', async () => {
        const ourNft = this.positionMap.get(targetNft);
        if (!ourNft) return;
        const txSig = await this.manualClosePosition(ourNft);
        if (txSig) {
          logger.info(MODULE, `Reconcile closed orphan: ${targetNft.slice(0, 8)} TX: ${txSig}`);
        }
      });
    }
  }

  /**
   * Get LP details for asset-trend (lpUsd, feeUsd, count).
   * Uses position info from SDK to compute token amounts, then prices via Jupiter.
   */
  async getPcsLpDetails(): Promise<{ lpUsd: number; feeUsd: number; count: number }> {
    const entries = this.positionMap.toJSON();
    let lpUsd = 0;
    let feeUsd = 0;
    let count = 0;

    const pcsEntries = Object.entries(entries).filter(([, e]) => (e as any).dex === 'pancakeswap');
    if (pcsEntries.length === 0) return { lpUsd: 0, feeUsd: 0, count: 0 };

    // Batch price lookup
    const mints = new Set<string>();
    for (const [, entry] of pcsEntries) {
      if (entry.pool) {
        const parts = entry.pool.split('/');
        for (const m of parts) mints.add(m);
      }
    }

    const prices: Record<string, number> = {};
    if (mints.size > 0) {
      try {
        const mintArr = Array.from(mints);
        const res = await jupiterFetch(`https://api.jup.ag/price/v2?ids=${mintArr.join(',')}`);
        if (res.ok) {
          const data = (await res.json()) as any;
          for (const mint of mintArr) {
            if (data.data?.[mint]?.price) prices[mint] = parseFloat(data.data[mint].price);
          }
        }
      } catch {
        /* use empty prices */
      }
    }

    for (const [_targetNft, entry] of pcsEntries) {
      try {
        const ourNft = entry.ourNft;
        const info = await this.chain.getPositionInfoByNftMint(new PublicKey(ourNft));
        if (!info) continue;

        const amtA = parseFloat(info.tokenA.uiAmount.toString());
        const amtB = parseFloat(info.tokenB.uiAmount.toString());
        const feeA = info.tokenA.feeAmount
          ? parseFloat(info.tokenA.feeAmount.toString()) /
            Math.pow(10, info.rawPoolInfo.mintDecimalsA)
          : 0;
        const feeB = info.tokenB.feeAmount
          ? parseFloat(info.tokenB.feeAmount.toString()) /
            Math.pow(10, info.rawPoolInfo.mintDecimalsB)
          : 0;

        const mintAStr = info.rawPoolInfo.mintA.toBase58();
        const mintBStr = info.rawPoolInfo.mintB.toBase58();
        const priceA = prices[mintAStr] || 0;
        const priceB = prices[mintBStr] || 0;

        lpUsd += amtA * priceA + amtB * priceB;
        feeUsd += feeA * priceA + feeB * priceB;
        count++;
      } catch {
        /* skip failed position */
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    return { lpUsd, feeUsd, count };
  }

  /**
   * Get position assets for dashboard asset-breakdown.
   */
  async getPositionAssets(): Promise<
    Array<{
      mint: string;
      balance: number;
      decimals: number;
      pairedStable: Record<string, number>;
      liquidityUsd: number;
    }>
  > {
    const entries = this.positionMap.toJSON();
    const pcsEntries = Object.entries(entries).filter(([, e]) => (e as any).dex === 'pancakeswap');
    if (pcsEntries.length === 0) return [];

    const mintTotals = new Map<
      string,
      {
        balance: number;
        decimals: number;
        pairedStable: Record<string, number>;
        liquidityUsd: number;
      }
    >();

    for (const [, entry] of pcsEntries) {
      try {
        const info = await this.chain.getPositionInfoByNftMint(new PublicKey(entry.ourNft));
        if (!info) continue;

        const mintAStr = info.rawPoolInfo.mintA.toBase58();
        const mintBStr = info.rawPoolInfo.mintB.toBase58();
        const amtA = parseFloat(info.tokenA.uiAmount.toString());
        const amtB = parseFloat(info.tokenB.uiAmount.toString());
        const decA = info.rawPoolInfo.mintDecimalsA;
        const decB = info.rawPoolInfo.mintDecimalsB;

        // Aggregate per-mint
        const addToMint = (
          mint: string,
          amount: number,
          decimals: number,
          pairedMint: string,
          pairedAmount: number,
        ) => {
          const existing = mintTotals.get(mint) || {
            balance: 0,
            decimals,
            pairedStable: {},
            liquidityUsd: 0,
          };
          existing.balance += amount;
          if (STABLE_MINTS.has(pairedMint)) {
            existing.pairedStable[pairedMint] =
              (existing.pairedStable[pairedMint] || 0) + pairedAmount;
          }
          mintTotals.set(mint, existing);
        };

        addToMint(mintAStr, amtA, decA, mintBStr, amtB);
        addToMint(mintBStr, amtB, decB, mintAStr, amtA);
      } catch {
        /* skip */
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    return Array.from(mintTotals.entries()).map(([mint, data]) => ({
      mint,
      ...data,
    }));
  }
}
