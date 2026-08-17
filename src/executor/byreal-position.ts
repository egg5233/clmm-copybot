import fs from 'fs';
import path from 'path';
import {
  AccountInfo,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  Signer,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import BN from 'bn.js';
import {
  Chain,
  MEMO_PROGRAM_ID,
  IGetPositionInfoByNftMintReturn,
  PoolLayout,
  PersonalPositionLayout,
  SqrtPriceMath,
  LiquidityMath,
} from 'byreal-clmm-sdk-alpha';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getUserAddress, signerCallback } from '../utils/wallet';
import { scaleAmount } from '../utils/ratio';
import {
  swapForToken,
  swapViaByrealPool,
  getActualSwapOutput,
  jupSwapExactIn,
  lastSwapError,
} from './jupiter-swap';
import { PositionMap } from '../state/position-map';
import {
  addBotReceived,
  addPending,
  allPendingSwaps,
  clearPendingSwaps,
  countPendingSwaps,
  deletePendingSwap,
  getPendingSwap,
  setPendingSwap,
} from '../state/pending-swaps-store';
import { OperationQueue } from './queue';
import {
  notifySolInsufficient,
  notifyOpenFailed,
  notifyCloseFailed,
  notifySwapFailed,
  notifyPumpApproval,
} from '../discord/notify';
import { getPoolInfo, checkTokenLiquidity } from '../monitor/pool-tvl';
import { getLatestTotalUsd } from '../state/portfolio-state';
import { getAmountRatio } from '../utils/ratio';
import {
  isPumpPending,
  isPumpApproved,
  isPumpRejected,
  addPumpPending,
} from '../state/pump-pending';
import { classifyByrealReconcilePosition, classifyByrealReconcileTarget } from './reconcile-status';
import { ByrealNftAuditResult, diffByrealNftAudit } from './byreal-nft-audit';
import { isRefererDuplicateEntry } from '../utils/byreal-allow-same-tick';
import { isPoolAgeWhitelisted } from '../utils/pool-age-whitelist';

/**
 * Patch connection.getMultipleAccountsInfo to auto-chunk when >100 keys.
 * Workaround for SDK bug (getRawData.ts calls raw method without chunking).
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

const MODULE = 'ByrealPos';
const POSITION_GONE_RE =
  /\b(not found|does not exist|account not found|account does not exist|could not find|position not found)\b/i;

function isPositionGoneError(err: any): boolean {
  const msg = typeof err?.message === 'string' ? err.message : String(err || '');
  return POSITION_GONE_RE.test(msg);
}

function isComputeBudgetInstructionType(ix: TransactionInstruction, type: number): boolean {
  if (!ix.programId.equals(ComputeBudgetProgram.programId)) return false;
  const data = Buffer.from(ix.data);
  return data[0] === type;
}

export function stripByrealComputeUnitPriceInstructions(
  instructions: TransactionInstruction[],
): TransactionInstruction[] {
  return instructions.filter((ix) => !isComputeBudgetInstructionType(ix, 3));
}

async function estimateByrealComputeUnitLimit(
  connection: Connection,
  instructions: TransactionInstruction[],
  payerPublicKey: PublicKey,
  blockhash: string,
): Promise<number> {
  try {
    const filteredInstructions = instructions.filter(
      (ix) => !isComputeBudgetInstructionType(ix, 2),
    );
    const simulationInstructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ...filteredInstructions,
    ];
    const simulationTx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: payerPublicKey,
        recentBlockhash: blockhash,
        instructions: simulationInstructions,
      }).compileToV0Message(),
    );
    const simulation = await connection.simulateTransaction(simulationTx);
    if (simulation.value.logs && simulation.value.unitsConsumed) {
      const consumedUnits = simulation.value.unitsConsumed;
      const estimatedUnits = Math.min(
        Math.max(consumedUnits + 100_000, Math.ceil(consumedUnits * 1.3)),
        1_400_000,
      );
      return Math.max(estimatedUnits, 100_000);
    }
  } catch (error) {
    console.warn('Estimate compute units failed, using default value:', error);
  }
  return 400_000;
}

export async function makeByrealZeroPriorityTransaction(params: {
  connection: Connection;
  payerPublicKey: PublicKey;
  instructions: TransactionInstruction[];
  signers?: Signer[];
  computeUnitLimit?: number;
}): Promise<VersionedTransaction> {
  const { connection, payerPublicKey, signers = [] } = params;
  const { blockhash } = await connection.getLatestBlockhash();
  const cleanedInstructions = stripByrealComputeUnitPriceInstructions(params.instructions);
  const hasComputeUnitLimit = cleanedInstructions.some((ix) =>
    isComputeBudgetInstructionType(ix, 2),
  );
  const finalInstructions = hasComputeUnitLimit
    ? cleanedInstructions
    : [
        ComputeBudgetProgram.setComputeUnitLimit({
          units:
            params.computeUnitLimit ??
            (await estimateByrealComputeUnitLimit(
              connection,
              cleanedInstructions,
              payerPublicKey,
              blockhash,
            )),
        }),
        ...cleanedInstructions,
      ];

  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: payerPublicKey,
      recentBlockhash: blockhash,
      instructions: finalInstructions,
    }).compileToV0Message(),
  );
  if (signers.length > 0) tx.sign(signers);
  return tx;
}

export type ByrealPositionCapStatus = {
  enabled: boolean;
  current: number;
  cap: number;
  reached: boolean;
  reason: string | null;
};

export function getByrealPositionCapStatus(
  positionMap: Pick<PositionMap, 'getByrealOpenCount'>,
  cap: number,
): ByrealPositionCapStatus {
  const current = positionMap.getByrealOpenCount();
  const enabled = cap > 0;
  const reached = enabled && current >= cap;
  return {
    enabled,
    current,
    cap,
    reached,
    reason: reached ? `Byreal position cap reached (${current}/${cap})` : null,
  };
}

// Stablecoins excluded from TVL check (TVL data is 0 for these since they are quote tokens)
const STABLE_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmKfrE1SBVYuL9sSMdCL3DscMVPR1YnG5', // USDT (standard)
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT (Token2022)
]);

export class ByrealPositionExecutor {
  private chain: Chain;
  private freechains: Chain[];
  private freechainIdx = 0;
  private connection: Connection;
  private readConnection: Connection; // Alchemy — for balance/TX reads (avoids Helius indexing lag)
  private positionMap: PositionMap;
  private busy = false; // Executor-level lock: prevents concurrent RPC/TX operations

  /** Optional callback to check if a target NFT is an Orca position (for reconcile). */
  public isOrcaPositionChecker: ((nftMint: string) => Promise<boolean>) | null = null;
  /** Optional callback to check if a target NFT is a Meteora position (for reconcile). */
  public isMeteoraPositionChecker: ((positionAddress: string) => Promise<boolean>) | null = null;
  /** Optional callback to check if a target NFT is a PancakeSwap position (for reconcile). */
  public isPcsPositionChecker: ((nftMint: string) => Promise<boolean>) | null = null;

  /** SOL insufficient pause — disables OPEN/INCREASE until manual restart */
  public solPaused = false;
  public solPausedAt: number | null = null;

  /** Drawdown protection — disables OPEN/INCREASE until manual restart */
  public drawdownPaused = false;
  public drawdownPausedAt: number | null = null;
  public startAssetUsd: number | null = null;
  public drawdownWarning = false; // first detection — wait for confirmation

  /** Per-token cooldown — disables OPEN for specific tokens after consecutive losses */
  public tokenLossStreak: Map<string, number> = new Map();
  public tokenCooldowns: Map<string, number> = new Map();

  /** Pool address → mint pair cache (for token cooldown lookups) */
  public poolIdToMints: Map<string, string> = new Map();

  /**
   * Set by copyOpenPosition when it returns null due to an intentional skip
   * (not a TX failure). Cleared by the caller after reading.
   */
  public lastSkipReason: string | null = null;

  /** Cached SOL balance — updated after each open attempt, not polled */
  public cachedSolBalance: number | null = null;

  /** Cached rent per position in SOL — queried from RPC at startup, fallback to 0.0090132 */
  public rentPerPosition: number = 0.0090132;

  private static REFERER_FILE = './data/opened-referers.json';
  private static PNL_FILE = './data/token-pnl.json';

  constructor(connection: Connection, positionMap: PositionMap) {
    this.connection = connection;
    this.readConnection = config.readRpcUrl
      ? new Connection(config.readRpcUrl, { commitment: 'confirmed' })
      : connection;
    patchConnectionChunking(this.readConnection);
    this.chain = new Chain({
      connection: this.readConnection, // Alchemy — SDK read-only ops (save Helius credits)
      programId: config.byrealProgramId,
    });
    this.freechains = config.rpcUrlsFree.map((url) => {
      const conn = new Connection(url, { commitment: 'confirmed' });
      patchConnectionChunking(conn);
      return new Chain({ connection: conn, programId: config.byrealProgramId });
    });
    this.positionMap = positionMap;
    // Log referer dedup state on startup
    const refererData = this.readRefererFile();
    const refererCount = Object.keys(refererData).length;
    if (refererCount > 0) {
      logger.info(MODULE, `Found ${refererCount} opened referers on disk`);
    }
    // Log pending state on startup (the shared store has already loaded it)
    const pendingCount = countPendingSwaps();
    if (pendingCount > 0) {
      logger.info(MODULE, `Found ${pendingCount} pending swaps`);
    }
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

  private async makeSdkTransactionWithoutPriorityFee(result: {
    instructions: TransactionInstruction[];
    signers?: Signer[];
  }): Promise<VersionedTransaction> {
    return makeByrealZeroPriorityTransaction({
      connection: this.connection,
      payerPublicKey: getUserAddress(),
      instructions: result.instructions,
      signers: result.signers ?? [],
    });
  }

  // ===== Risk Management =====

  /** Extract the non-SOL/non-USDC token from a pool string like "mintA/mintB" */
  private extractToken(pool: string): string {
    const SOL = 'So11111111111111111111111111111111111111112';
    const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const parts = pool.split('/');
    if (parts.length !== 2) return pool;
    // Return whichever side is NOT SOL/USDC
    if (parts[0] === SOL || parts[0] === USDC) return parts[1];
    return parts[0];
  }

  /** Check if a token is currently in cooldown period */
  isTokenCoolingDown(pool: string): boolean {
    if (!pool) return false;
    const token = this.extractToken(pool);
    const until = this.tokenCooldowns.get(token);
    if (!until) return false;
    if (Date.now() >= until) {
      this.tokenCooldowns.delete(token);
      this.tokenLossStreak.delete(token);
      return false;
    }
    return true;
  }

  /** Record PnL result for a closed position — updates streak + cooldown + persists to disk */
  recordTokenPnl(pool: string, pnlUsd: number): void {
    if (!pool) return;
    const token = this.extractToken(pool);
    if (pnlUsd < 0) {
      const streak = (this.tokenLossStreak.get(token) || 0) + 1;
      this.tokenLossStreak.set(token, streak);
      logger.info(
        MODULE,
        `Token ${token.slice(0, 8)}… PnL $${pnlUsd.toFixed(2)} (連續虧損 ${streak} 次)`,
      );
      if (streak >= config.tokenLossStreakLimit && config.tokenLossStreakLimit > 0) {
        // 白名單豁免：連虧仍計入統計，但跳過冷卻
        if (config.tokenWhitelist.has(token)) {
          logger.info(
            MODULE,
            `Token ${token.slice(0, 8)}… 在白名單中，跳過冷卻 (連虧 ${streak} 次仍計入)`,
          );
        } else {
          const until = Date.now() + config.tokenCooldownMinutes * 60 * 1000;
          this.tokenCooldowns.set(token, until);
          logger.warn(
            MODULE,
            `Token ${token.slice(0, 8)}… 連續虧損 ${streak} 次，冷靜 ${config.tokenCooldownMinutes} 分鐘`,
          );
        }
      }
    } else {
      // Profit or breakeven — reset streak and remove cooldown
      this.tokenLossStreak.set(token, 0);
      this.tokenCooldowns.delete(token);
    }

    // 持久化 PnL 資料到磁碟
    const pnlData = this.readPnlFile();
    const rec = pnlData[token] || { totalPnl: 0, tradeCount: 0, lastLossPnl: 0, lastTradeAt: 0 };
    rec.totalPnl = (rec.totalPnl || 0) + pnlUsd;
    rec.tradeCount = (rec.tradeCount || 0) + 1;
    if (pnlUsd < 0) rec.lastLossPnl = pnlUsd;
    rec.lastTradeAt = Date.now();
    pnlData[token] = rec;
    this.writePnlFile(pnlData);
  }

  /** Check if a token is in the blacklist (blocks OPEN for this token) */
  isTokenBlacklisted(pool: string): boolean {
    if (!pool) return false;
    const parts = pool.split('/');
    if (parts.length !== 2) return config.tokenBlacklist.has(pool);
    // Auto-block any pool containing SOL (WSOL) if enabled
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    if (config.byrealSkipSol && (parts[0] === SOL_MINT || parts[1] === SOL_MINT)) return true;
    // Check if EITHER side of the pool is blacklisted
    return config.tokenBlacklist.has(parts[0]) || config.tokenBlacklist.has(parts[1]);
  }

  /** Backfill pool info for positions opened before v1.3.8. Runs once on startup. */
  async backfillPoolInfo(): Promise<void> {
    const missing = this.positionMap.entriesMissingPool();
    if (missing.length === 0) return;
    logger.info(MODULE, `Backfilling pool info for ${missing.length} positions...`);
    let filled = 0;
    for (const [targetNft, ourNft] of missing) {
      try {
        const info = await this.chain.getPositionInfoByNftMint(new PublicKey(ourNft));
        if (info) {
          const mintA = info.rawPoolInfo.mintA.toBase58();
          const mintB = info.rawPoolInfo.mintB.toBase58();
          this.positionMap.setPool(targetNft, `${mintA}/${mintB}`);
          filled++;
        }
        // null = position may be closed, but don't delete here (leave to reconcile)
      } catch {
        // RPC error, skip
      }
      await new Promise((r) => setTimeout(r, 300)); // Rate limit
    }
    logger.info(MODULE, `Backfill complete: ${filled}/${missing.length} positions updated`);
  }

  /**
   * Query rent exemption from RPC for the 3 accounts created per CLMM position,
   * plus Token2022 metadata transfer. Cache the result as rentPerPosition.
   * Call once at startup.
   */
  async initRentPerPosition(): Promise<void> {
    try {
      const conn = this.readConnection;
      // Position PDA: 281 bytes, NFT Mint (Token2022): 270 bytes, NFT ATA (Token2022): 170 bytes
      const [rentPDA, rentMint, rentATA] = await Promise.all([
        conn.getMinimumBalanceForRentExemption(281),
        conn.getMinimumBalanceForRentExemption(270),
        conn.getMinimumBalanceForRentExemption(170),
      ]);
      // Metaplex token metadata account transfer: 1,322,400 lamports (fixed)
      const METADATA_TRANSFER = 1_322_400;
      const totalLamports = rentPDA + rentMint + METADATA_TRANSFER + rentATA;
      this.rentPerPosition = totalLamports / 1e9;
      logger.info(
        MODULE,
        `Rent per position: ${this.rentPerPosition} SOL (${totalLamports} lamports = PDA:${rentPDA} + Mint:${rentMint} + Meta:${METADATA_TRANSFER} + ATA:${rentATA})`,
      );
    } catch (err: any) {
      logger.warn(
        MODULE,
        `Failed to query rent exemption, using fallback ${this.rentPerPosition}: ${err.message}`,
      );
    }
  }

  /**
   * Backfill lockedSol for positions opened before this feature.
   * Sets all missing entries to the current rentPerPosition value.
   * Call once at startup after initRentPerPosition().
   */
  backfillLockedSol(): void {
    const missing = this.positionMap.entriesMissingLockedSol();
    if (missing.length === 0) return;
    logger.info(
      MODULE,
      `Backfilling lockedSol for ${missing.length} positions (${this.rentPerPosition} SOL each)`,
    );
    for (const [targetNft] of missing) {
      this.positionMap.setLockedSol(targetNft, this.rentPerPosition);
    }
    logger.info(MODULE, `Backfill lockedSol complete: ${missing.length} positions updated`);
  }

  /**
   * Extract actual locked SOL from a TX's innerInstructions.
   * Sums all system program createAccount + transfer lamports from bot wallet.
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
          const prog = (ix as any).program;
          if (prog !== 'system') continue;
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

  /** Check if we have a mapping for a target NFT. */
  hasMapping(targetNftMint: string): boolean {
    return !!this.positionMap.get(targetNftMint);
  }

  /** Read pending swaps (public for dashboard). */
  getPendingSwaps(): Record<string, any> {
    return allPendingSwaps();
  }

  /** Read opened referers (public for dashboard). */
  getOpenedReferers(): Record<string, any> {
    return this.readRefererFile();
  }

  /** Check if a referer position was already opened (public for skip detection). */
  isRefererDuplicate(refererPosition: string | null, targetWallet: string): boolean {
    if (!refererPosition) return false;
    const entry = this.readRefererFile()[refererPosition];
    return isRefererDuplicateEntry(
      entry,
      targetWallet,
      config.allowSameWalletReopen,
      config.byrealAllowSameTickWallets,
      config.byrealAllowOpenAfterOthersWallets,
    );
  }

  private _walletBalancesCache: {
    items: Array<{ mint: string; amount: string; decimals: number }>;
    ts: number;
  } | null = null;
  private static WALLET_BALANCES_TTL = 5 * 60 * 1000; // 5 min — synced with asset-trend interval

  /**
   * Get all token balances in bot wallet (including SOL, stablecoins).
   * Cached for 5 min — asset-trend refreshes every 5 min, dashboard reads from cache.
   * Returns full list — callers filter at display time.
   */
  async getWalletTokenBalances(): Promise<{ mint: string; amount: string; decimals: number }[]> {
    if (
      this._walletBalancesCache &&
      Date.now() - this._walletBalancesCache.ts < ByrealPositionExecutor.WALLET_BALANCES_TTL
    ) {
      return this._walletBalancesCache.items;
    }

    const owner = getUserAddress();

    // Primary: Jupiter Holdings（不依賴 jupApiKey — 有 key 帶 header，沒 key 也照打）
    try {
      const items = await this.fetchBalancesViaJupiter(owner.toBase58());
      this._walletBalancesCache = { items, ts: Date.now() };
      return items;
    } catch (err: any) {
      logger.warn(
        MODULE,
        `Jupiter holdings failed, falling back to RPC: ${(err.message || '').slice(0, 120)}`,
      );
    }

    // Fallback: RPC round-robin
    try {
      const items = await this.fetchBalancesViaRpc(owner);
      this._walletBalancesCache = { items, ts: Date.now() };
      return items;
    } catch (err: any) {
      logger.warn(MODULE, `RPC balance fetch failed: ${(err.message || '').slice(0, 120)}`);
    }

    // 兩者都失敗 — 回 stale cache 不 poison（不把空結果寫入 cache）
    if (this._walletBalancesCache) {
      logger.warn(MODULE, 'Returning stale wallet balances (both Jupiter + RPC failed)');
      return this._walletBalancesCache.items;
    }
    return [];
  }

  private async fetchBalancesViaJupiter(
    addressBase58: string,
  ): Promise<Array<{ mint: string; amount: string; decimals: number }>> {
    const headers: Record<string, string> = {};
    if (config.jupApiKey) headers['x-api-key'] = config.jupApiKey;
    const res = await fetch(`https://api.jup.ag/ultra/v1/holdings/${addressBase58}`, { headers });
    if (!res.ok) throw new Error(`Jupiter holdings HTTP ${res.status}`);
    const data = (await res.json()) as any;

    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const results: Array<{ mint: string; amount: string; decimals: number }> = [];

    // SOL — top-level amount is lamports
    const solAmount = data.amount ?? '0';
    results.push({ mint: SOL_MINT, amount: String(solAmount), decimals: 9 });

    // Tokens — 合併同 mint 多個 ATA，沿用 RPC 的過濾條件
    if (data.tokens && typeof data.tokens === 'object') {
      for (const [mint, accounts] of Object.entries(data.tokens)) {
        if (!Array.isArray(accounts) || accounts.length === 0) continue;
        let total = new BN(0);
        let decimals = 0;
        for (const acc of accounts as any[]) {
          if (acc.amount) total = total.add(new BN(String(acc.amount)));
          if (acc.decimals != null) decimals = acc.decimals;
        }
        if (decimals === 0) continue; // 跳過 NFT（沿用 RPC heuristic）
        if (total.lte(new BN(1000))) continue; // dust filter
        results.push({ mint, amount: total.toString(), decimals });
      }
    }

    return results;
  }

  private async fetchBalancesViaRpc(
    owner: PublicKey,
  ): Promise<Array<{ mint: string; amount: string; decimals: number }>> {
    const freeUrl = config.rpcUrlsFree[this.freechainIdx % config.rpcUrlsFree.length];
    this.freechainIdx++;
    const conn = new Connection(freeUrl, { commitment: 'confirmed' });

    // 故意不吞錯 — 讓 caller 決定是否寫 cache / fallback / 回 stale
    const [solLamports, accountsLegacy, accounts2022] = await Promise.all([
      conn.getBalance(owner),
      conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
      conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
    ]);

    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const results: Array<{ mint: string; amount: string; decimals: number }> = [
      { mint: SOL_MINT, amount: solLamports.toString(), decimals: 9 },
    ];
    for (const accounts of [accountsLegacy, accounts2022]) {
      for (const { account } of accounts.value) {
        const info = account.data.parsed.info;
        const mint: string = info.mint;
        const amount: string = info.tokenAmount.amount;
        const decimals: number = info.tokenAmount.decimals;
        if (decimals === 0) continue;
        if (new BN(amount).lte(new BN(1000))) continue;
        results.push({ mint, amount, decimals });
      }
    }
    return results;
  }

  /**
   * Swap a token to USDC using Jupiter — based on wallet balance (not pending file).
   * Used by both auto-swap (target trigger) and manual force-swap (dashboard).
   */
  /**
   * Swap token to USDC.
   * @param maxAmountRaw max raw amount to swap. If provided, swap min(maxAmountRaw, balance). If omitted, swap full balance.
   */
  async swapTokenToUSDC(
    inputMint: string,
    maxAmountRaw?: string,
  ): Promise<{ sig: string; amountRaw: string; outputRaw?: string } | null> {
    const SKIP_MINTS = new Set([
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmKfrE1SBVYuL9sSMdCL3DscMVPR1YnG5', // USDT (SPL)
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT (Token2022)
      NATIVE_MINT.toBase58(), // SOL
    ]);
    if (SKIP_MINTS.has(inputMint)) {
      logger.debug(MODULE, `swapTokenToUSDC: skipping stablecoin/SOL ${inputMint.slice(0, 8)}`);
      return null;
    }

    const balance = await this.getTokenBalance(getUserAddress(), new PublicKey(inputMint));
    if (balance.lte(new BN(1000))) {
      logger.debug(MODULE, `swapTokenToUSDC: no balance for ${inputMint.slice(0, 8)} (or dust)`);
      return null;
    }

    // Cap at maxAmountRaw if provided, otherwise swap full balance
    let swapAmount = balance;
    if (maxAmountRaw) {
      const cap = new BN(maxAmountRaw);
      if (cap.gt(new BN(0)) && cap.lt(balance)) {
        swapAmount = cap;
      }
    }
    if (swapAmount.lte(new BN(1000))) {
      logger.debug(
        MODULE,
        `swapTokenToUSDC: amount too small for ${inputMint.slice(0, 8)} (${swapAmount.toString()})`,
      );
      return null;
    }
    logger.info(
      MODULE,
      `Swap to USDC: ${inputMint.slice(0, 8)}... amount=${swapAmount.toString()}${maxAmountRaw ? ` (capped, balance=${balance.toString()})` : ''}`,
    );

    const amountRaw = swapAmount.toString();

    if (config.dryRun) {
      logger.info(MODULE, '[DRY RUN] Would swap to USDC');
      return { sig: 'dry-run-swap', amountRaw };
    }

    if (!this.acquire('swapTokenToUSDC')) return null;

    try {
      const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
      const sig = await jupSwapExactIn(this.connection, inputMint, USDC_MINT, amountRaw);
      if (sig) {
        logger.info(MODULE, `Swap done: ${inputMint.slice(0, 8)}... -> USDC: ${sig}`);
        // Parse TX to get actual USDC received
        let outputRaw: string | undefined;
        try {
          outputRaw =
            (await getActualSwapOutput(
              this.readConnection,
              sig,
              USDC_MINT,
              getUserAddress().toBase58(),
            )) || undefined;
          if (outputRaw) logger.info(MODULE, `USDC received: ${outputRaw} (raw)`);
        } catch {}
        return { sig, amountRaw, outputRaw };
      }
      return null;
    } catch (err: any) {
      logger.warn(MODULE, `Swap failed for ${inputMint.slice(0, 8)}: ${err.message}`);
      return null;
    } finally {
      this.release();
    }
  }

  /** Clear all pending swaps (dashboard action). */
  clearAllPendingSwaps(): void {
    clearPendingSwaps();
    logger.info(MODULE, 'All pending swaps cleared via dashboard');
  }

  /**
   * Manual close position (dashboard action).
   * Closes our position by ourNftMint, removes mapping and referer.
   */
  async manualClosePosition(ourNftMint: string): Promise<string | null> {
    const targetNft = this.positionMap.findByOurNft(ourNftMint);

    logger.info(MODULE, `Manual close: our NFT ${ourNftMint.slice(0, 8)}...`);

    if (config.dryRun) {
      logger.info(MODULE, '[DRY RUN] Would manually close position');
      return 'dry-run-manual-close';
    }

    if (!this.acquire('manualClosePosition')) return null;

    try {
      const MAX_CLOSE_ATTEMPTS = 2;
      for (let attempt = 0; attempt < MAX_CLOSE_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          logger.info(
            MODULE,
            `Retrying manual close (attempt ${attempt + 1}/${MAX_CLOSE_ATTEMPTS})...`,
          );
          await new Promise((r) => setTimeout(r, 2000));
        }

        try {
          const txSig = await this.retryOnTransient(
            async () => {
              const result = await this.chain.decreaseFullLiquidityInstructions({
                userAddress: getUserAddress(),
                nftMint: new PublicKey(ourNftMint),
                closePosition: true,
              });
              const tx = await this.makeSdkTransactionWithoutPriorityFee(result);
              const signed = await signerCallback(tx);
              return this.connection.sendTransaction(signed, {
                skipPreflight: config.skipPreflight,
              });
            },
            `manualClose(${ourNftMint.slice(0, 8)})`,
          );

          logger.info(MODULE, `Manual close done: ${ourNftMint.slice(0, 8)} TX: ${txSig}`);

          if (targetNft) {
            this.positionMap.delete(targetNft);
            this.removeReferer(targetNft);
          }

          return txSig;
        } catch (closeErr: any) {
          if (
            attempt < MAX_CLOSE_ATTEMPTS - 1 &&
            (this.isRetryableSimError(closeErr) || this.isTransientError(closeErr))
          ) {
            logger.warn(
              MODULE,
              `Manual close attempt ${attempt + 1} failed (${(closeErr.message || '').slice(0, 100)}), will retry...`,
            );
            continue;
          }
          throw closeErr;
        }
      }

      return null; // should not reach here
    } catch (err: any) {
      const msg = err.message || '';
      if (isPositionGoneError(err)) {
        const staleTargetNft = targetNft ?? this.positionMap.findByOurNft(ourNftMint);
        if (staleTargetNft) {
          this.positionMap.delete(staleTargetNft);
          this.removeReferer(staleTargetNft);
          logger.warn(
            MODULE,
            `Manual close skipped: position already gone on-chain, mapping removed: ${ourNftMint.slice(0, 8)}`,
          );
        } else {
          logger.warn(
            MODULE,
            `Manual close skipped: position already gone on-chain and no mapping found: ${ourNftMint.slice(0, 8)}`,
          );
        }
        return null;
      }
      logger.error(MODULE, `Manual close failed: ${msg}`);
      return null;
    } finally {
      this.release();
    }
  }

  /** Clear a single pending swap entry (dashboard action). */
  clearOnePendingSwap(inputMint: string): void {
    this.clearPending(inputMint);
    logger.info(MODULE, `Pending swap cleared via dashboard: ${inputMint.slice(0, 8)}...`);
  }

  /** Force-swap entire pending balance for a mint to USDC (dashboard action). */
  async forceSwapPending(inputMint: string): Promise<string | null> {
    const entry = getPendingSwap(inputMint);
    if (!entry || !entry.pending || new BN(entry.pending).lte(new BN(1000))) {
      logger.warn(MODULE, `forceSwap: no pending for ${inputMint.slice(0, 8)} (or dust)`);
      return null;
    }

    // Use actual wallet balance (more accurate than pending number)
    const balance = await this.getTokenBalance(getUserAddress(), new PublicKey(inputMint));
    if (balance.lte(new BN(1000))) {
      logger.warn(
        MODULE,
        `forceSwap: wallet balance is dust for ${inputMint.slice(0, 8)}, clearing pending`,
      );
      this.clearPending(inputMint);
      return null;
    }

    logger.info(
      MODULE,
      `Force swap: ${inputMint.slice(0, 8)}... balance=${balance.toString()} -> USDC`,
    );

    if (config.dryRun) {
      logger.info(MODULE, '[DRY RUN] Would force swap to USDC');
      this.clearPending(inputMint);
      return 'dry-run-force-swap';
    }

    if (!this.acquire('forceSwapPending')) return null;

    try {
      const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
      const sig = await jupSwapExactIn(this.connection, inputMint, USDC_MINT, balance.toString());
      if (!sig) return null;

      logger.info(MODULE, `Force swap done: ${inputMint.slice(0, 8)}... -> USDC: ${sig}`);
      this.clearPending(inputMint);
      return sig;
    } catch (err: any) {
      logger.warn(MODULE, `Force swap failed: ${err.message}`);
      return null;
    } finally {
      this.release();
    }
  }

  /**
   * Acquire executor lock. Returns false if already busy.
   * Prevents concurrent operations (event handling vs fee collection)
   * that share the same wallet/connection.
   */
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

  /**
   * Claim fees + accrued rewards across every Byreal position our wallet holds on-chain.
   * Discovers positions directly from the CLMM program (not PositionMap), so it also
   * sweeps orphans and positions opened outside the bot. Then reuses
   * chain.collectAllPositionFeesInstructions to build per-position instruction batches,
   * and re-wraps each through the Byreal zero-priority builder + signerCallback so
   * signer-process policy applies without adding a compute unit price.
   */
  async collectAllFees(): Promise<{
    totalPositions: number;
    txCount: number;
    results: Array<{ txSig?: string; error?: string; positionCount: number }>;
  }> {
    if (!this.acquire('collectAllFees')) {
      throw new Error('Executor busy, another operation in progress');
    }
    try {
      const userAddress = getUserAddress();

      logger.info(MODULE, 'Claim-all: enumerating on-chain Byreal positions for wallet');
      const positions = await this.chain.getRawPositionInfoListByUserAddress(userAddress);
      const nftMintList = positions.map((p) => p.nftMint);
      logger.info(MODULE, `Claim-all: discovered ${nftMintList.length} on-chain Byreal positions`);

      if (nftMintList.length === 0) {
        return { totalPositions: 0, txCount: 0, results: [] };
      }

      if (config.dryRun) {
        logger.info(MODULE, `[DRY RUN] Would claim-all for ${nftMintList.length} Byreal positions`);
        return { totalPositions: nftMintList.length, txCount: 0, results: [] };
      }

      logger.info(
        MODULE,
        `Claim-all: building batched instructions for ${nftMintList.length} positions`,
      );
      const { instructionsList } = await this.chain.collectAllPositionFeesInstructions({
        userAddress,
        nftMintList,
      });
      logger.info(MODULE, `Claim-all: ${instructionsList.length} batched TX(s) to send`);

      const results: Array<{ txSig?: string; error?: string; positionCount: number }> = [];
      for (let i = 0; i < instructionsList.length; i++) {
        const instructions = instructionsList[i];
        try {
          const txSig = await this.retryOnTransient(
            async () => {
              const tx = await makeByrealZeroPriorityTransaction({
                connection: this.connection,
                payerPublicKey: userAddress,
                instructions,
              });
              const signed = await signerCallback(tx);
              return this.connection.sendTransaction(signed, {
                skipPreflight: config.skipPreflight,
              });
            },
            `collectAllFees-batch-${i + 1}/${instructionsList.length}`,
          );
          logger.info(MODULE, `Claim-all batch ${i + 1}/${instructionsList.length} OK: ${txSig}`);
          results.push({ txSig, positionCount: instructions.length });
        } catch (err: any) {
          logger.error(
            MODULE,
            `Claim-all batch ${i + 1}/${instructionsList.length} failed: ${err.message || err}`,
          );
          results.push({ error: err.message || String(err), positionCount: instructions.length });
        }
      }
      return { totalPositions: nftMintList.length, txCount: instructionsList.length, results };
    } finally {
      this.release();
    }
  }

  /**
   * Update connection reference (called on WebSocket reconnect).
   */
  updateConnection(connection: Connection): void {
    this.connection = connection;
    // chain uses readConnection (Alchemy) for read-only SDK ops — not affected by WS reconnect
    logger.info(MODULE, 'Send connection updated after reconnect');
  }

  /**
   * Copy an OpenPosition from a target wallet.
   * Read target's position → swap if needed → open same params (pool, tick range, referer).
   * Amount = target's deposit amount (scaled by AMOUNT_RATIO), not our full balance.
   */
  async copyOpenPosition(
    targetNftMint: string,
    poolId: string,
    refererPosition: string | null,
    targetWallet?: string,
  ): Promise<string | null> {
    // Guard: prevent duplicate open for the same target position
    if (this.positionMap.get(targetNftMint)) {
      logger.warn(
        MODULE,
        `Already have mapping for target NFT ${targetNftMint.slice(0, 8)}, skipping duplicate open`,
      );
      return null;
    }

    // Guard: prevent duplicate open for the same provider position (multiple targets copying same provider)
    if (refererPosition && this.isRefererDuplicate(refererPosition, targetWallet || '')) {
      logger.info(
        MODULE,
        `Duplicate referer ${refererPosition.slice(0, 8)}, already opened — skipping`,
      );
      return null;
    }

    const capStatus = getByrealPositionCapStatus(this.positionMap, config.byrealMaxOpenPositions);
    if (capStatus.reached) {
      this.lastSkipReason = capStatus.reason;
      logger.info(MODULE, `[OPEN] Skipped - ${capStatus.reason}`);
      return null;
    }

    logger.info(MODULE, `Copying position: pool=${poolId.slice(0, 8)}...`, {
      targetNft: targetNftMint.slice(0, 8),
      referer: refererPosition?.slice(0, 8) || 'none',
    });

    if (config.dryRun) {
      logger.info(MODULE, '[DRY RUN] Would copy open position', {
        poolId,
        targetNftMint,
        refererPosition,
      });
      return 'dry-run-open-position';
    }

    if (!this.acquire('copyOpenPosition')) return null;

    try {
      const userAddress = getUserAddress();

      // 1. Read target's position to get tick range and pool info (with retry for RPC lag)
      const targetNft = new PublicKey(targetNftMint);
      const positionInfo = await this.retryGetPosition(targetNft);
      if (!positionInfo) {
        logger.error(MODULE, `Cannot read target position after retries: ${targetNftMint}`);
        return null;
      }

      const { rawPositionInfo, rawPoolInfo } = positionInfo;
      const tickLower = rawPositionInfo.tickLower;
      const tickUpper = rawPositionInfo.tickUpper;
      const mintA = rawPoolInfo.mintA;
      const mintB = rawPoolInfo.mintB;
      const mintAStr = mintA.toBase58();
      const mintBStr = mintB.toBase58();
      const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

      const poolLabel = `${mintAStr}/${mintBStr}`;

      // 2a. Duplicate tick range check (optional, controlled by SKIP_SAME_TICK_RANGE)
      if (config.skipSameTickRange && targetWallet) {
        if (this.positionMap.hasDuplicateTickRange(targetWallet, poolLabel, tickLower, tickUpper)) {
          logger.info(
            MODULE,
            `[OPEN] Skipped — same wallet already has open position in ${poolLabel} at ticks [${tickLower}, ${tickUpper}]`,
          );
          this.lastSkipReason = '重複 tick 範圍';
          return null;
        }
      }

      // 2b. Pump token filter (tri-state: off / full / discord)
      if (config.pumpFilterMode !== 'off') {
        const pumpMint = mintAStr.toLowerCase().includes('pump')
          ? mintAStr
          : mintBStr.toLowerCase().includes('pump')
            ? mintBStr
            : null;
        if (pumpMint) {
          // Already approved via whitelist or pump-pending → allow
          if (!isPumpApproved(pumpMint)) {
            if (config.pumpFilterMode === 'full') {
              logger.info(MODULE, `[OPEN] Skipped — pump token detected (${mintAStr}/${mintBStr})`);
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
              addPumpPending({
                mint: pumpMint,
                symbol,
                pool: `${mintAStr}/${mintBStr}`,
                targetWallet: targetWallet || '',
                detectedAt: Date.now(),
              });
              notifyPumpApproval(pumpMint, symbol, `${mintAStr}/${mintBStr}`).catch((e: any) =>
                logger.warn(MODULE, `Pump notify failed: ${e.message}`),
              );
            }
            logger.info(MODULE, `[OPEN] Skipped — pump token pending approval (${pumpMint})`);
            this.lastSkipReason = 'Pump 代幣等待確認';
            return null;
          }
        }
      }

      // 2c. Pool age filter (optional, controlled by MIN_POOL_AGE_DAYS)
      if (
        config.minPoolAgeDays > 0 &&
        !isPoolAgeWhitelisted(mintAStr, mintBStr, config.poolAgeWhitelist)
      ) {
        const poolEntry = getPoolInfo(mintAStr);
        if (poolEntry && poolEntry.openTime > 0) {
          const ageSeconds = Math.floor(Date.now() / 1000) - poolEntry.openTime;
          if (ageSeconds < config.minPoolAgeDays * 86400) {
            const ageDays = (ageSeconds / 86400).toFixed(1);
            logger.info(
              MODULE,
              `[OPEN] Skipped — pool too new (${ageDays}d < ${config.minPoolAgeDays}d) for ${mintAStr.slice(0, 8)}`,
            );
            this.lastSkipReason = `池子太新 (${ageDays}d < ${config.minPoolAgeDays}d)`;
            return null;
          }
        }
      }

      // 2d. Pool TVL filter (optional, controlled by MIN_POOL_TVL)
      if (config.minPoolTvl > 0) {
        for (const [mint, label] of [
          [mintAStr, 'mintA'],
          [mintBStr, 'mintB'],
        ] as [string, string][]) {
          if (config.poolTvlWhitelist.has(mint)) continue;
          if (STABLE_MINTS.has(mint)) continue;
          const tvl = await checkTokenLiquidity(mint);
          if (tvl === null || tvl < config.minPoolTvl) {
            logger.info(
              MODULE,
              `[OPEN] Skipped — ${label} ${mint.slice(0, 8)} TVL $${tvl !== null ? tvl.toFixed(0) : '?'} < $${config.minPoolTvl} (${config.tvlSource})`,
            );
            this.lastSkipReason = `TVL 不足 (${label} $${tvl !== null ? tvl.toFixed(0) : '?'} < $${config.minPoolTvl})`;
            return null;
          }
        }
      }

      // 2e. Concentration filter (optional, controlled by MAX_COIN_CONCENTRATION_USD/PCT)
      const concSkip = this.checkConcentrationLimit(
        mintAStr,
        mintBStr,
        targetWallet,
        positionInfo.tokenA.uiAmount,
        positionInfo.tokenB.uiAmount,
        rawPoolInfo,
        'OPEN',
      );
      if (concSkip) {
        logger.info(MODULE, `[OPEN] Skipped — ${concSkip}`);
        this.lastSkipReason = concSkip;
        return null;
      }

      // 2f. Read target's deposited amounts
      // tokenA.amount and tokenB.amount are already BN from SDK
      const targetA = scaleAmount(positionInfo.tokenA.amount, targetWallet);
      const targetB = scaleAmount(positionInfo.tokenB.amount, targetWallet);

      logger.info(
        MODULE,
        `Target deposited: A=${positionInfo.tokenA.uiAmount}, B=${positionInfo.tokenB.uiAmount}`,
      );
      logger.info(MODULE, `Our target (raw): A=${targetA.toString()}, B=${targetB.toString()}`);

      // 3. Check our balances — swap if insufficient
      let ourBalanceA = await this.getTokenBalance(userAddress, mintA);
      let ourBalanceB = await this.getTokenBalance(userAddress, mintB);
      logger.info(
        MODULE,
        `Our balances before swap: A=${ourBalanceA.toString()}, B=${ourBalanceB.toString()}`,
      );

      // Swap for tokenA if we don't have enough
      if (ourBalanceA.lt(targetA) && !targetA.isZero()) {
        const deficit = targetA.sub(ourBalanceA);
        logger.info(MODULE, `Need ${deficit.toString()} more of tokenA`);
        let txSig: string | null = null;

        if (mintA.equals(NATIVE_MINT)) {
          // SOL deficit: only try USDC→SOL
          if (mintAStr !== USDC)
            txSig = await swapForToken(this.connection, USDC, mintAStr, deficit.toString());
        } else {
          // Try 1: swap tokenB → tokenA (if we have tokenB)
          if (!ourBalanceB.isZero()) {
            txSig = await swapForToken(this.connection, mintBStr, mintAStr, deficit.toString());
            if (!txSig) {
              txSig = await swapViaByrealPool(
                this.chain,
                rawPoolInfo,
                mintB,
                mintA,
                deficit.toString(),
              );
            }
          }

          // Try 2: swap USDC → tokenA
          if (!txSig && mintAStr !== USDC) {
            logger.info(MODULE, 'Trying USDC → tokenA');
            txSig = await swapForToken(this.connection, USDC, mintAStr, deficit.toString());
          }
        }

        if (!txSig) {
          logger.error(MODULE, 'All swap methods failed for tokenA, aborting');
          notifySwapFailed(mintAStr, lastSwapError || 'all methods failed');
          return null;
        }
        const addedA = await getActualSwapOutput(
          this.readConnection,
          txSig,
          mintAStr,
          userAddress.toBase58(),
        );
        if (addedA) {
          ourBalanceA = ourBalanceA.add(new BN(addedA));
        } else {
          logger.warn(MODULE, 'Could not parse swap TX, waiting 5s then re-reading balance');
          await new Promise((r) => setTimeout(r, 5000));
          ourBalanceA = await this.getTokenBalance(userAddress, mintA);
        }
        logger.info(
          MODULE,
          `tokenA after swap: ${ourBalanceA.toString()} (added ${addedA || 're-read'})`,
        );
      }

      // Swap for tokenB if we don't have enough
      if (ourBalanceB.lt(targetB) && !targetB.isZero()) {
        const deficit = targetB.sub(ourBalanceB);
        logger.info(MODULE, `Need ${deficit.toString()} more of tokenB`);
        let txSig: string | null = null;

        if (mintB.equals(NATIVE_MINT)) {
          // SOL deficit: only try USDC→SOL
          if (mintBStr !== USDC)
            txSig = await swapForToken(this.connection, USDC, mintBStr, deficit.toString());
        } else {
          // Try 1: swap USDC → tokenB (prefer external funding to preserve tokenA)
          if (mintBStr !== USDC) {
            txSig = await swapForToken(this.connection, USDC, mintBStr, deficit.toString());
          }

          // Try 2: swap tokenA → tokenB (last resort)
          if (!txSig && !ourBalanceA.isZero()) {
            logger.info(MODULE, 'Trying tokenA → tokenB (last resort)');
            txSig = await swapForToken(this.connection, mintAStr, mintBStr, deficit.toString());
            if (!txSig) {
              txSig = await swapViaByrealPool(
                this.chain,
                rawPoolInfo,
                mintA,
                mintB,
                deficit.toString(),
              );
            }
          }
        }

        if (!txSig) {
          logger.error(MODULE, 'All swap methods failed for tokenB, aborting');
          notifySwapFailed(mintBStr, lastSwapError || 'all methods failed');
          return null;
        }
        const addedB = await getActualSwapOutput(
          this.readConnection,
          txSig,
          mintBStr,
          userAddress.toBase58(),
        );
        if (addedB) {
          ourBalanceB = ourBalanceB.add(new BN(addedB));
        } else {
          logger.warn(MODULE, 'Could not parse swap TX, waiting 5s then re-reading balance');
          await new Promise((r) => setTimeout(r, 5000));
          ourBalanceB = await this.getTokenBalance(userAddress, mintB);
        }
        logger.info(
          MODULE,
          `tokenB after swap: ${ourBalanceB.toString()} (added ${addedB || 're-read'})`,
        );
      }

      logger.info(
        MODULE,
        `Our balances after swap: A=${ourBalanceA.toString()}, B=${ourBalanceB.toString()}`,
      );

      if (ourBalanceA.isZero() && ourBalanceB.isZero()) {
        logger.error(MODULE, 'No token balance for either side after swaps, cannot open position');
        return null;
      }

      // 3b. Build and send position TX (with retry on simulation failure)
      const MAX_OPEN_ATTEMPTS = 2;
      for (let openAttempt = 0; openAttempt < MAX_OPEN_ATTEMPTS; openAttempt++) {
        if (openAttempt > 0) {
          logger.info(
            MODULE,
            `Retrying open position (attempt ${openAttempt + 1}/${MAX_OPEN_ATTEMPTS}), re-reading balances...`,
          );
          await new Promise((r) => setTimeout(r, 2000));
          ourBalanceA = await this.getTokenBalance(userAddress, mintA);
          ourBalanceB = await this.getTokenBalance(userAddress, mintB);
          logger.info(
            MODULE,
            `Retry balances: A=${ourBalanceA.toString()}, B=${ourBalanceB.toString()}`,
          );
        }

        // Determine base token: use target's deposit amounts (scaled by ratio)
        // Only use our balance as cap — never deposit more than target did
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

        logger.info(MODULE, `Position params: ticks=[${tickLower}, ${tickUpper}], base=${base}`, {
          baseAmount: baseAmount.toString(),
          otherAmountMax: otherAmountMax.toString(),
        });

        try {
          // 4. Build instructions using SDK
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

          // Add Memo instruction for referer (copy tracking)
          if (refererPosition) {
            const memoIx = createMemoInstruction(`referer_position=${refererPosition}`, [
              userAddress,
            ]);
            instructions.push(memoIx);
          }

          // 5. Build, sign and send TX (all in one retry so blockhash stays fresh)
          const txSig = await this.retryOnTransient(async () => {
            const tx = await makeByrealZeroPriorityTransaction({
              connection: this.connection,
              payerPublicKey: userAddress,
              instructions,
              signers,
            });
            const signed = await signerCallback(tx);
            return this.connection.sendTransaction(signed, {
              skipPreflight: config.skipPreflight,
            });
          }, 'buildSignSend');

          // 6. Save mapping IMMEDIATELY after send (before confirm)
          //    Prevents orphaned positions if confirm times out but TX actually landed
          if (nftAddress) {
            this.positionMap.set(
              targetNftMint,
              nftAddress,
              poolLabel,
              targetWallet,
              tickLower,
              tickUpper,
            );
            this.positionMap.setLockedSol(targetNftMint, this.rentPerPosition);
            // Store target's liquidity at open time for proportional decrease tracking
            this.positionMap.setTargetLiquidity(
              targetNftMint,
              rawPositionInfo.liquidity.toString(),
            );
            this.poolIdToMints.set(poolId, poolLabel); // Cache for token cooldown lookups
            logger.info(
              MODULE,
              `Mapping saved: ${targetNftMint.slice(0, 8)} -> ${nftAddress.slice(0, 8)} (targetLiq=${rawPositionInfo.liquidity.toString()})`,
            );
          }

          // Track referer to dedup future opens from other targets copying same provider
          if (refererPosition) {
            this.addReferer(refererPosition, targetNftMint, nftAddress || '', targetWallet || '');
          }

          // Wait for confirmation (best-effort, mapping already saved)
          try {
            const latestBlockhash = await this.connection.getLatestBlockhash();
            await this.connection.confirmTransaction(
              {
                signature: txSig,
                ...latestBlockhash,
              },
              'confirmed',
            );
            logger.info(MODULE, `Position opened and confirmed: ${txSig}`);
          } catch (confirmErr: any) {
            logger.warn(
              MODULE,
              `TX sent but confirm failed (mapping saved): ${confirmErr.message}`,
              { txSig },
            );
          }

          // Extract actual locked SOL from TX (non-blocking)
          this.extractLockedSolFromTx(txSig)
            .then((actual) => {
              if (actual !== null) {
                this.positionMap.setLockedSol(targetNftMint, actual);
                logger.info(MODULE, `Locked SOL updated from TX: ${actual.toFixed(6)} SOL`);
              }
            })
            .catch(() => {});

          return txSig;
        } catch (openErr: any) {
          const msg = openErr.message || '';
          if (openAttempt < MAX_OPEN_ATTEMPTS - 1 && this.isRetryableSimError(openErr)) {
            logger.warn(
              MODULE,
              `Open attempt ${openAttempt + 1} failed (${msg.slice(0, 100)}), will retry...`,
            );
            continue;
          }
          throw openErr; // re-throw to outer catch
        }
      }

      return null; // should not reach here
    } catch (err: any) {
      logger.error(MODULE, `Open position failed: ${err.message}`);
      notifyOpenFailed(err, targetNftMint);
      if (/insufficient lamports/i.test(err.message)) {
        this.solPaused = true;
        this.solPausedAt = Date.now();
        logger.error(MODULE, 'SOL 不足，已暫停開倉/加倉。需手動重啟 bot 恢復。');
        notifySolInsufficient(this.cachedSolBalance ?? 0);
      }
      return null;
    } finally {
      this.release();
      // Refresh cached SOL balance after every open attempt
      this.getSolBalance()
        .then((b) => {
          this.cachedSolBalance = b;
        })
        .catch(() => {});
    }
  }

  /**
   * Copy a DecreaseLiquidity from target.
   * Compares target's current liquidity vs stored targetLiquidity:
   * - If target liquidity = 0 → full decrease (decreaseFullLiquidityInstructions)
   * - If target decreased partially → proportional partial decrease (decreaseLiquidityInstructions)
   * - If target liquidity >= stored (or no stored data) → fee collection only
   */
  async copyDecreaseLiquidity(
    targetNftMint: string,
  ): Promise<{ txSig: string; type: 'DECREASE' | 'COLLECT_FEE' } | null> {
    const myNftMint = this.positionMap.get(targetNftMint);
    if (!myNftMint) {
      logger.warn(MODULE, `No mapped position for target NFT: ${targetNftMint.slice(0, 8)}`);
      return null;
    }

    // Read target's current liquidity to determine: full decrease, partial decrease, or fee collection
    let targetCurrentLiq: BN | null = null;
    try {
      const targetPosition = await this.retryGetPosition(new PublicKey(targetNftMint));
      if (targetPosition) {
        targetCurrentLiq = targetPosition.rawPositionInfo.liquidity;
      }
    } catch {
      logger.warn(MODULE, `Cannot read target position, proceeding with full decrease for safety`);
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
            const myPosition = await this.retryGetPosition(new PublicKey(myNftMint));
            if (myPosition) {
              const myLiq = myPosition.rawPositionInfo.liquidity;
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
      if (config.dryRun) {
        logger.info(MODULE, '[DRY RUN] Would collect fees', { myNftMint });
        return { txSig: 'dry-run-collect-fee', type: 'COLLECT_FEE' };
      }

      if (!this.acquire('collectFees')) return null;

      try {
        const MAX_FEE_ATTEMPTS = 2;
        for (let attempt = 0; attempt < MAX_FEE_ATTEMPTS; attempt++) {
          if (attempt > 0) {
            logger.info(
              MODULE,
              `Retrying collect fees (attempt ${attempt + 1}/${MAX_FEE_ATTEMPTS})...`,
            );
            await new Promise((r) => setTimeout(r, 2000));
          }

          try {
            const txSig = await this.retryOnTransient(
              async () => {
                const result = await this.chain.collectFeesInstructions({
                  userAddress: getUserAddress(),
                  nftMint: new PublicKey(myNftMint),
                });
                const tx = await this.makeSdkTransactionWithoutPriorityFee(result);
                const signed = await signerCallback(tx);
                return this.connection.sendTransaction(signed, {
                  skipPreflight: config.skipPreflight,
                });
              },
              `collectFees(${myNftMint.slice(0, 8)})`,
            );

            logger.info(MODULE, `Fees collected for ${myNftMint.slice(0, 8)}: ${txSig}`);
            return { txSig, type: 'COLLECT_FEE' };
          } catch (feeErr: any) {
            if (attempt < MAX_FEE_ATTEMPTS - 1 && this.isRetryableSimError(feeErr)) {
              logger.warn(
                MODULE,
                `Collect fees attempt ${attempt + 1} failed (${(feeErr.message || '').slice(0, 100)}), will retry...`,
              );
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

    // Decrease liquidity (full or partial)
    const isPartial = decreaseAmount !== null;
    logger.info(
      MODULE,
      `${isPartial ? 'Partial' : 'Full'} decrease for our NFT: ${myNftMint.slice(0, 8)}...`,
    );

    if (config.dryRun) {
      logger.info(MODULE, `[DRY RUN] Would ${isPartial ? 'partial' : 'full'} decrease liquidity`, {
        myNftMint,
      });
      return { txSig: 'dry-run-decrease', type: 'DECREASE' };
    }

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
          let txSig: string;
          if (isPartial) {
            // Partial decrease — use decreaseLiquidityInstructions with exact amount
            txSig = await this.retryOnTransient(
              async () => {
                // Re-read our position to get latest liquidity (may have changed between retries)
                const myPos = await this.retryGetPosition(new PublicKey(myNftMint));
                const myLiq = myPos?.rawPositionInfo.liquidity ?? new BN(0);
                const liquidity = BN.min(decreaseAmount!, myLiq); // never exceed our actual liquidity
                if (liquidity.isZero()) {
                  throw new Error('Our position has zero liquidity, nothing to decrease');
                }

                const result = await this.chain.decreaseLiquidityInstructions({
                  userAddress: getUserAddress(),
                  nftMint: new PublicKey(myNftMint),
                  liquidity,
                });
                const tx = await this.makeSdkTransactionWithoutPriorityFee(result);
                const signed = await signerCallback(tx);
                return this.connection.sendTransaction(signed, {
                  skipPreflight: config.skipPreflight,
                });
              },
              `decreaseLiquidity-partial(${myNftMint.slice(0, 8)})`,
            );
          } else {
            // Full decrease — use decreaseFullLiquidityInstructions
            txSig = await this.retryOnTransient(
              async () => {
                const result = await this.chain.decreaseFullLiquidityInstructions({
                  userAddress: getUserAddress(),
                  nftMint: new PublicKey(myNftMint),
                  closePosition: false, // Don't close — wait for explicit CLOSE event
                });
                const tx = await this.makeSdkTransactionWithoutPriorityFee(result);
                const signed = await signerCallback(tx);
                return this.connection.sendTransaction(signed, {
                  skipPreflight: config.skipPreflight,
                });
              },
              `decreaseLiquidity-full(${myNftMint.slice(0, 8)})`,
            );
          }

          logger.info(
            MODULE,
            `Liquidity decreased${isPartial ? ' (partial)' : ''} (position kept open): ${txSig}`,
          );

          // Queue received tokens as pending swaps
          try {
            const received = await this.parseTxTokenChanges(txSig, getUserAddress());
            for (const { mint, amount } of received) {
              logger.info(
                MODULE,
                `Received from decrease: ${mint.toBase58().slice(0, 8)}... = ${amount.toString()}`,
              );
              this.addPendingSwap(mint, amount);
            }
          } catch (parseErr: any) {
            logger.warn(
              MODULE,
              `Could not parse decrease TX for pending swaps: ${parseErr.message}`,
            );
          }

          return { txSig, type: 'DECREASE' };
        } catch (decErr: any) {
          if (attempt < MAX_DECREASE_ATTEMPTS - 1 && this.isRetryableSimError(decErr)) {
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
      logger.error(MODULE, `Decrease liquidity failed: ${err.message}`);
      return null;
    } finally {
      this.release();
    }
  }

  /**
   * Copy an IncreaseLiquidity from target.
   * Read target's position to see current state, add liquidity proportionally using our balance.
   */
  async copyIncreaseLiquidity(
    targetNftMint: string,
    targetWallet?: string,
  ): Promise<string | null> {
    const myNftMint = this.positionMap.get(targetNftMint);
    if (!myNftMint) {
      logger.warn(MODULE, `No mapped position for target NFT: ${targetNftMint.slice(0, 8)}`);
      return null;
    }

    logger.info(MODULE, `Increasing liquidity for our NFT: ${myNftMint.slice(0, 8)}...`);

    if (config.dryRun) {
      logger.info(MODULE, '[DRY RUN] Would increase liquidity', { myNftMint, targetNftMint });
      return 'dry-run-increase';
    }

    if (!this.acquire('copyIncreaseLiquidity')) return null;

    try {
      // Read target's position to understand the pool and tick range
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
      const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

      // Pump token filter (same tri-state as copyOpenPosition)
      if (config.pumpFilterMode !== 'off') {
        const pumpMint = mintAStr.toLowerCase().includes('pump')
          ? mintAStr
          : mintBStr.toLowerCase().includes('pump')
            ? mintBStr
            : null;
        if (pumpMint && !isPumpApproved(pumpMint)) {
          logger.info(
            MODULE,
            `[INCREASE] Skipped — pump token ${config.pumpFilterMode === 'full' ? 'filtered' : 'not approved'} (${pumpMint})`,
          );
          return null;
        }
      }

      // Pool age filter (same as copyOpenPosition)
      if (
        config.minPoolAgeDays > 0 &&
        !isPoolAgeWhitelisted(mintAStr, mintBStr, config.poolAgeWhitelist)
      ) {
        const poolEntry = getPoolInfo(mintAStr);
        if (poolEntry && poolEntry.openTime > 0) {
          const ageSeconds = Math.floor(Date.now() / 1000) - poolEntry.openTime;
          if (ageSeconds < config.minPoolAgeDays * 86400) {
            const ageDays = (ageSeconds / 86400).toFixed(1);
            logger.info(
              MODULE,
              `[INCREASE] Skipped — pool too new (${ageDays}d < ${config.minPoolAgeDays}d) for ${mintAStr.slice(0, 8)}`,
            );
            return null;
          }
        }
      }

      // Pool TVL filter (same as copyOpenPosition)
      if (config.minPoolTvl > 0) {
        for (const [mint, label] of [
          [mintAStr, 'mintA'],
          [mintBStr, 'mintB'],
        ] as [string, string][]) {
          if (config.poolTvlWhitelist.has(mint)) continue;
          if (STABLE_MINTS.has(mint)) continue;
          const tvl = await checkTokenLiquidity(mint);
          if (tvl === null || tvl < config.minPoolTvl) {
            logger.info(
              MODULE,
              `[INCREASE] Skipped — ${label} ${mint.slice(0, 8)} TVL $${tvl !== null ? tvl.toFixed(0) : '?'} < $${config.minPoolTvl} (${config.tvlSource})`,
            );
            return null;
          }
        }
      }

      // Concentration filter (same as copyOpenPosition)
      const concSkipInc = this.checkConcentrationLimit(
        mintAStr,
        mintBStr,
        targetWallet,
        targetPosition.tokenA.uiAmount,
        targetPosition.tokenB.uiAmount,
        targetPosition.rawPoolInfo,
        'INCREASE',
      );
      if (concSkipInc) {
        logger.info(MODULE, `[INCREASE] Skipped — ${concSkipInc}`);
        return null;
      }

      const userAddress = getUserAddress();

      // Read target's current position amounts as reference (already BN from SDK)
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

      // Read our available token balances — swap if insufficient
      let ourBalanceA = await this.getTokenBalance(userAddress, mintA);
      let ourBalanceB = await this.getTokenBalance(userAddress, mintB);

      // Swap for tokenA if we don't have enough
      if (ourBalanceA.lt(targetA) && !targetA.isZero()) {
        const deficit = targetA.sub(ourBalanceA);
        logger.info(MODULE, `IncreaseLiq: need ${deficit.toString()} more of tokenA`);
        let txSig: string | null = null;

        if (mintA.equals(NATIVE_MINT)) {
          if (mintAStr !== USDC)
            txSig = await swapForToken(this.connection, USDC, mintAStr, deficit.toString());
        } else {
          if (!ourBalanceB.isZero()) {
            txSig = await swapForToken(this.connection, mintBStr, mintAStr, deficit.toString());
            if (!txSig) {
              txSig = await swapViaByrealPool(
                this.chain,
                rawPoolInfo,
                mintB,
                mintA,
                deficit.toString(),
              );
            }
          }

          if (!txSig && mintAStr !== USDC) {
            logger.info(MODULE, 'IncreaseLiq: trying USDC → tokenA');
            txSig = await swapForToken(this.connection, USDC, mintAStr, deficit.toString());
          }
        }

        if (!txSig) {
          logger.error(MODULE, 'IncreaseLiq: all swap methods failed for tokenA, aborting');
          return null;
        }
        const addedA = await getActualSwapOutput(
          this.readConnection,
          txSig,
          mintAStr,
          userAddress.toBase58(),
        );
        if (addedA) {
          ourBalanceA = ourBalanceA.add(new BN(addedA));
        } else {
          logger.warn(
            MODULE,
            'IncreaseLiq: could not parse swap TX, waiting 5s then re-reading balance',
          );
          await new Promise((r) => setTimeout(r, 5000));
          ourBalanceA = await this.getTokenBalance(userAddress, mintA);
        }
        logger.info(
          MODULE,
          `IncreaseLiq: tokenA after swap: ${ourBalanceA.toString()} (added ${addedA || 're-read'})`,
        );
      }

      // Swap for tokenB if we don't have enough
      if (ourBalanceB.lt(targetB) && !targetB.isZero()) {
        const deficit = targetB.sub(ourBalanceB);
        logger.info(MODULE, `IncreaseLiq: need ${deficit.toString()} more of tokenB`);
        let txSig: string | null = null;

        if (mintB.equals(NATIVE_MINT)) {
          if (mintBStr !== USDC)
            txSig = await swapForToken(this.connection, USDC, mintBStr, deficit.toString());
        } else {
          if (mintBStr !== USDC) {
            txSig = await swapForToken(this.connection, USDC, mintBStr, deficit.toString());
          }

          if (!txSig && !ourBalanceA.isZero()) {
            logger.info(MODULE, 'IncreaseLiq: trying tokenA → tokenB (last resort)');
            txSig = await swapForToken(this.connection, mintAStr, mintBStr, deficit.toString());
            if (!txSig) {
              txSig = await swapViaByrealPool(
                this.chain,
                rawPoolInfo,
                mintA,
                mintB,
                deficit.toString(),
              );
            }
          }
        }

        if (!txSig) {
          logger.error(MODULE, 'IncreaseLiq: all swap methods failed for tokenB, aborting');
          return null;
        }
        const addedB = await getActualSwapOutput(
          this.readConnection,
          txSig,
          mintBStr,
          userAddress.toBase58(),
        );
        if (addedB) {
          ourBalanceB = ourBalanceB.add(new BN(addedB));
        } else {
          logger.warn(
            MODULE,
            'IncreaseLiq: could not parse swap TX, waiting 5s then re-reading balance',
          );
          await new Promise((r) => setTimeout(r, 5000));
          ourBalanceB = await this.getTokenBalance(userAddress, mintB);
        }
        logger.info(
          MODULE,
          `IncreaseLiq: tokenB after swap: ${ourBalanceB.toString()} (added ${addedB || 're-read'})`,
        );
      }

      if (ourBalanceA.isZero() && ourBalanceB.isZero()) {
        logger.warn(
          MODULE,
          'No token balance for either side after swaps, cannot increase liquidity',
        );
        return null;
      }

      // Retry loop: re-read balances on simulation failure (swap slippage may cause slight deficit)
      const MAX_INCREASE_ATTEMPTS = 2;
      for (let attempt = 0; attempt < MAX_INCREASE_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          logger.info(
            MODULE,
            `Retrying increase (attempt ${attempt + 1}/${MAX_INCREASE_ATTEMPTS}), re-reading balances...`,
          );
          await new Promise((r) => setTimeout(r, 2000));
          ourBalanceA = await this.getTokenBalance(userAddress, mintA);
          ourBalanceB = await this.getTokenBalance(userAddress, mintB);
          logger.info(
            MODULE,
            `Retry balances: A=${ourBalanceA.toString()}, B=${ourBalanceB.toString()}`,
          );
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

        logger.info(MODULE, `AddLiquidity: base=${base}, amount=${baseAmount.toString()}`);

        try {
          const txSig = await this.retryOnTransient(
            async () => {
              const result = await this.chain.addLiquidityInstructions({
                userAddress,
                nftMint: new PublicKey(myNftMint),
                base,
                baseAmount,
                otherAmountMax,
              });
              const tx = await makeByrealZeroPriorityTransaction({
                connection: this.connection,
                payerPublicKey: userAddress,
                instructions: result.instructions,
                signers: result.signers ?? [],
              });
              const signed = await signerCallback(tx);
              return this.connection.sendTransaction(signed, {
                skipPreflight: config.skipPreflight,
              });
            },
            `addLiquidity(${myNftMint.slice(0, 8)})`,
          );

          logger.info(MODULE, `Liquidity increased: ${txSig}`);

          // Update stored target liquidity after increase (for proportional decrease tracking)
          try {
            const updatedTarget = await this.retryGetPosition(new PublicKey(targetNftMint));
            if (updatedTarget) {
              this.positionMap.setTargetLiquidity(
                targetNftMint,
                updatedTarget.rawPositionInfo.liquidity.toString(),
              );
              logger.info(
                MODULE,
                `Updated targetLiquidity after increase: ${updatedTarget.rawPositionInfo.liquidity.toString()}`,
              );
            }
          } catch {
            logger.warn(MODULE, `Could not update targetLiquidity after increase`);
          }

          return txSig;
        } catch (incErr: any) {
          if (attempt < MAX_INCREASE_ATTEMPTS - 1 && this.isRetryableSimError(incErr)) {
            logger.warn(
              MODULE,
              `Increase attempt ${attempt + 1} failed (${(incErr.message || '').slice(0, 100)}), will retry...`,
            );
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

  /**
   * Pending swaps: OUR received tokens from closing positions, waiting for bot's Jupiter swap signal.
   * Key = mint address, Value = OUR accumulated received amount.
   * Persisted to disk so they survive restarts.
   */
  // Pending swap state lives in src/state/pending-swaps-store.ts, shared with the
  // other DEX executors and written through to Postgres.

  /**
   * Copy a ClosePosition from target.
   * Records received tokens as pending swaps — actual swap happens when bot's Jupiter swap is detected.
   */
  async copyClosePosition(targetNftMint: string): Promise<string | null> {
    const myNftMint = this.positionMap.get(targetNftMint);
    if (!myNftMint) {
      logger.warn(MODULE, `No mapped position for target NFT: ${targetNftMint.slice(0, 8)}`);
      return null;
    }

    logger.info(MODULE, `Closing position for our NFT: ${myNftMint.slice(0, 8)}...`);

    if (config.dryRun) {
      logger.info(MODULE, '[DRY RUN] Would close position', { myNftMint });
      return 'dry-run-close';
    }

    if (!this.acquire('copyClosePosition')) return null;

    try {
      // 1. Close position (with retry for transient RPC errors, simulation failures, AND on-chain failures)
      const userAddress = getUserAddress();
      let txSig: string | null = null;

      const MAX_CLOSE_ATTEMPTS = 3;
      for (let attempt = 0; attempt < MAX_CLOSE_ATTEMPTS; attempt++) {
        if (attempt > 0) {
          logger.info(MODULE, `Retrying close (attempt ${attempt + 1}/${MAX_CLOSE_ATTEMPTS})...`);
          await new Promise((r) => setTimeout(r, 2000));
        }

        try {
          txSig = await this.retryOnTransient(
            async () => {
              const result = await this.chain.decreaseFullLiquidityInstructions({
                userAddress,
                nftMint: new PublicKey(myNftMint),
                closePosition: true,
              });
              const tx = await this.makeSdkTransactionWithoutPriorityFee(result);
              const signed = await signerCallback(tx);
              return this.connection.sendTransaction(signed, {
                skipPreflight: config.skipPreflight,
              });
            },
            `closePosition(${myNftMint.slice(0, 8)})`,
          );
        } catch (closeErr: any) {
          if (
            attempt < MAX_CLOSE_ATTEMPTS - 1 &&
            (this.isRetryableSimError(closeErr) || this.isTransientError(closeErr))
          ) {
            logger.warn(
              MODULE,
              `Close attempt ${attempt + 1} failed (${(closeErr.message || '').slice(0, 100)}), will retry...`,
            );
            continue;
          }
          throw closeErr;
        }

        if (!txSig) return null;

        // Verify TX actually succeeded on-chain (not just confirmed)
        const success = await this.verifyTxSuccess(txSig);
        if (success) break; // confirmed on-chain

        // On-chain failure — retry if attempts remain
        if (attempt < MAX_CLOSE_ATTEMPTS - 1) {
          logger.warn(
            MODULE,
            `Close TX failed on-chain: ${txSig.slice(0, 8)}, retrying (${attempt + 1}/${MAX_CLOSE_ATTEMPTS})...`,
          );
          txSig = null;
          continue;
        }
        logger.error(
          MODULE,
          `Close TX failed on-chain after ${MAX_CLOSE_ATTEMPTS} attempts: ${txSig.slice(0, 8)}, keeping mapping`,
        );
        notifyCloseFailed(myNftMint, 'on-chain failure after max attempts', MAX_CLOSE_ATTEMPTS);
        return null;
      }

      if (!txSig) return null;

      logger.info(MODULE, `Position closed: ${myNftMint.slice(0, 8)} TX: ${txSig}`);
      this.positionMap.delete(targetNftMint);
      this.removeReferer(targetNftMint);

      // 3. Parse TX to get actual received amounts (liquidity + fees)
      const received = await this.parseTxTokenChanges(txSig, userAddress);
      for (const { mint, amount } of received) {
        logger.info(
          MODULE,
          `Received from close: ${mint.toBase58().slice(0, 8)}... = ${amount.toString()}`,
        );
        this.addPendingSwap(mint, amount);
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

  /**
   * Add to pending swap map. Accumulates if same mint has multiple pending amounts.
   * Skips USDC and SOL (no need to swap).
   */
  private addPendingSwap(mint: PublicKey, amount: BN): void {
    const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const USDT_MINT = 'Es9vMFrzaCERmKfrE1SBVYuL9sSMdCL3DscMVPR1YnG5';
    const USDT_T22 = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
    const mintStr = mint.toBase58();

    if (
      mintStr === USDC_MINT ||
      mintStr === USDT_MINT ||
      mintStr === USDT_T22 ||
      mint.equals(NATIVE_MINT)
    )
      return;
    if (amount.lte(new BN(0))) return;

    const total = addPending(mintStr, amount);
    logger.info(
      MODULE,
      `Pending swap queued: ${mintStr.slice(0, 8)}... amount=${amount.toString()} (total=${total})`,
    );
  }

  /**
   * Record bot's received token amounts from close TX.
   * Called from handleEvent with data parsed from the close TX balance changes.
   */
  recordBotCloseReceived(receivedTokens: { mint: string; amount: string }[]): void {
    for (const { mint, amount } of receivedTokens) {
      const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
      const USDT_MINT = 'Es9vMFrzaCERmKfrE1SBVYuL9sSMdCL3DscMVPR1YnG5';
      const USDT_T22 = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
      if (
        mint === USDC_MINT ||
        mint === USDT_MINT ||
        mint === USDT_T22 ||
        mint === NATIVE_MINT.toBase58()
      )
        continue;

      const bn = new BN(amount);
      if (bn.lte(new BN(0))) continue;

      const total = addBotReceived(mint, bn);
      logger.info(
        MODULE,
        `Bot close received: ${mint.slice(0, 8)}... amount=${bn.toString()} (total=${total})`,
      );
    }
  }

  /**
   * Execute a pending swap when bot's Jupiter swap is detected.
   * Called from handleEvent when bot sells a token back to USDC.
   *
   * Calculates swap amount using percentage:
   *   ratio = botJupSwapAmount / botCloseReceivedAmount
   *   ourSwapAmount = ourPendingAmount × ratio
   *
   * This ensures we swap the same PROPORTION as the bot, regardless of absolute amounts.
   */
  async executePendingSwap(inputMint: string, botSwapAmount: string): Promise<string | null> {
    const entry = getPendingSwap(inputMint);
    const pendingAmount = entry ? new BN(entry.pending) : null;
    if (!entry || !pendingAmount || pendingAmount.lte(new BN(1000))) {
      logger.debug(MODULE, `No pending swap for ${inputMint.slice(0, 8)}... (or dust)`);
      return null;
    }

    // Calculate swap ratio from bot's amounts
    const botReceived = entry.botReceived ? new BN(entry.botReceived) : null;
    const botSwap = new BN(botSwapAmount);
    let swapAmount: BN;

    if (botReceived && !botReceived.isZero()) {
      // Percentage-based: ourSwapAmount = ourPending × (botSwap / botReceived)
      // Use BN math: (pendingAmount * botSwap) / botReceived
      swapAmount = pendingAmount.mul(botSwap).div(botReceived);
      const pct = botSwap.muln(10000).div(botReceived).toNumber() / 100;
      logger.info(
        MODULE,
        `Swap ratio: bot swapped ${botSwap.toString()} / received ${botReceived.toString()} = ${pct.toFixed(1)}%`,
      );
      logger.info(
        MODULE,
        `Our swap: ${pendingAmount.toString()} × ${pct.toFixed(1)}% = ${swapAmount.toString()}`,
      );
    } else {
      // Fallback: no bot received data, use actual wallet balance
      swapAmount = await this.getTokenBalance(getUserAddress(), new PublicKey(inputMint));
      logger.warn(
        MODULE,
        `No bot close data for ${inputMint.slice(0, 8)}, using actual balance: ${swapAmount.toString()}`,
      );
    }

    if (swapAmount.lte(new BN(1000))) {
      logger.info(
        MODULE,
        `Swap amount too small for ${inputMint.slice(0, 8)} (${swapAmount.toString()}), skipping`,
      );
      this.clearPending(inputMint);
      return null;
    }

    if (config.dryRun) {
      logger.info(MODULE, '[DRY RUN] Would swap to USDC', {
        inputMint,
        amount: swapAmount.toString(),
      });
      this.subtractPending(inputMint, swapAmount, botSwap);
      return 'dry-run-pending-swap';
    }

    if (!this.acquire('executePendingSwap')) return null;

    try {
      const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
      const sig = await jupSwapExactIn(
        this.connection,
        inputMint,
        USDC_MINT,
        swapAmount.toString(),
      );
      if (!sig) return null;

      logger.info(MODULE, `Pending swap done: ${inputMint.slice(0, 8)}... -> USDC: ${sig}`);
      this.subtractPending(inputMint, swapAmount, botSwap);
      return sig;
    } catch (err: any) {
      logger.warn(MODULE, `Pending swap failed for ${inputMint.slice(0, 8)}: ${err.message}`);
      return null;
    } finally {
      this.release();
    }
  }

  /**
   * Subtract swapped amounts from pending maps. Keeps remainder for potential second JUP swap.
   * Only fully deletes when remaining is dust (≤ 1000 raw units).
   */
  private subtractPending(inputMint: string, ourSwapped: BN, botSwapped: BN): void {
    const entry = getPendingSwap(inputMint);
    if (!entry) return;

    const remaining = new BN(entry.pending).sub(ourSwapped);
    if (remaining.lte(new BN(1000))) {
      deletePendingSwap(inputMint);
      return;
    }

    const botReceived = entry.botReceived ? new BN(entry.botReceived) : new BN(0);
    const botRemaining = botReceived.sub(botSwapped);
    setPendingSwap(inputMint, {
      ...entry,
      pending: remaining.toString(),
      botReceived: botRemaining.lte(new BN(0)) ? '0' : botRemaining.toString(),
    });
    logger.info(MODULE, `Pending remaining: ${inputMint.slice(0, 8)}... = ${remaining.toString()}`);
  }

  /** Fully clear all pending data for a mint. */
  private clearPending(inputMint: string): void {
    deletePendingSwap(inputMint);
  }

  // --- Token PnL file (persisted across restarts) ---

  /** Read PnL data from disk. */
  private readPnlFile(): Record<string, any> {
    try {
      const filePath = ByrealPositionExecutor.PNL_FILE;
      if (!fs.existsSync(filePath)) return {};
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return {};
    }
  }

  /** Write PnL data to disk. */
  private writePnlFile(data: Record<string, any>): void {
    try {
      const filePath = ByrealPositionExecutor.PNL_FILE;
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (err: any) {
      logger.error(MODULE, `Could not save PnL data: ${err.message}`);
    }
  }

  /** Get all persisted token PnL data (public for dashboard). */
  getTokenPnlData(): Record<string, any> {
    return this.readPnlFile();
  }

  // --- Referer dedup file (persisted across restarts) ---

  private readRefererFile(): Record<string, any> {
    try {
      const filePath = ByrealPositionExecutor.REFERER_FILE;
      if (!fs.existsSync(filePath)) return {};
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      return {};
    }
  }

  private writeRefererFile(data: Record<string, any>): void {
    try {
      const filePath = ByrealPositionExecutor.REFERER_FILE;
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (err: any) {
      logger.error(MODULE, `Could not save referer state: ${err.message}`);
    }
  }

  private addReferer(
    refererPosition: string,
    targetNft: string,
    ourNft: string,
    targetWallet: string,
  ): void {
    const data = this.readRefererFile();
    data[refererPosition] = { targetNft, ourNft, targetWallet, openedAt: Date.now() };
    this.writeRefererFile(data);
  }

  /** Remove referer entry when position is closed (allows re-opening if provider opens again). */
  private removeReferer(targetNftMint: string): void {
    const data = this.readRefererFile();
    for (const [referer, entry] of Object.entries(data)) {
      if ((entry as any).targetNft === targetNftMint) {
        delete data[referer];
        this.writeRefererFile(data);
        return;
      }
    }
  }

  /** Resolve token mint to symbol from token-names cache. */
  private getTokenSymbol(mint: string): string {
    try {
      const raw = fs.readFileSync('./data/token-names.json', 'utf-8');
      const cache = JSON.parse(raw);
      return cache[mint]?.symbol || mint;
    } catch {
      return mint;
    }
  }

  /** Log pending swap status and clean up zero-amount entries. */
  async logPendingStatus(): Promise<void> {
    for (const [mint, entry] of Object.entries(allPendingSwaps())) {
      const pending = new BN(entry.pending || '0');
      if (pending.isZero()) {
        deletePendingSwap(mint);
        continue;
      }
      let amount = entry.pending;
      // Sync pending amount with actual wallet balance
      try {
        const balance = await this.getTokenBalance(getUserAddress(), new PublicKey(mint));
        if (balance.lte(new BN(1000))) {
          logger.info(
            MODULE,
            `Pending ${this.getTokenSymbol(mint)} balance is dust, clearing (externally swapped?)`,
          );
          deletePendingSwap(mint);
          continue;
        }
        // Update pending to actual balance
        if (!balance.eq(pending)) {
          amount = balance.toString();
          setPendingSwap(mint, { ...entry, pending: amount });
        }
      } catch {
        /* ignore RPC errors */
      }
      const ageMin = entry.createdAt ? Math.floor((Date.now() - entry.createdAt) / 60000) : 0;
      logger.debug(MODULE, `Pending: ${this.getTokenSymbol(mint)} amount=${amount} (${ageMin}min)`);
    }
  }

  /**
   * Reconcile positions: detect orphans where target closed but we missed the event.
   * If target's NFT no longer exists on-chain, close our corresponding position.
   */
  async reconcilePositions(): Promise<void> {
    if (this.positionMap.size() === 0) return;

    logger.info(MODULE, `Reconciling ${this.positionMap.size()} position mappings...`);
    let orphans = 0;

    for (const [tgtNft, ourNft] of this.positionMap.entries()) {
      // Skip non-Byreal positions — other DEX SDKs handle their own reconciliation
      const dex = this.positionMap.getDex(tgtNft);
      if (dex && dex !== 'byreal') continue;

      let isOrphan = false;
      try {
        const targetPosition = await this.chain.getPositionInfoByNftMint(new PublicKey(tgtNft));
        isOrphan = classifyByrealReconcileTarget(targetPosition).isOrphan;
      } catch (err: any) {
        // Distinguish transient RPC errors from "account doesn't exist"
        if (this.isTransientError(err)) {
          logger.debug(
            MODULE,
            `Reconcile: RPC transient error for ${tgtNft.slice(0, 8)}, skipping`,
          );
        } else {
          // Non-transient error (account not found, parse error, etc.) = position is gone
          logger.info(
            MODULE,
            `Reconcile: target ${tgtNft.slice(0, 8)} lookup failed (${(err.message || '').slice(0, 80)}), treating as orphan`,
          );
          isOrphan = true;
        }
      }

      // Before treating as orphan, check if it's an Orca position (Byreal SDK can't read those)
      if (isOrphan && this.isOrcaPositionChecker) {
        try {
          const isOrca = await this.isOrcaPositionChecker(tgtNft);
          if (isOrca) {
            logger.info(
              MODULE,
              `Reconcile: ${tgtNft.slice(0, 8)} is Orca position, backfilling dex='orca' and skipping`,
            );
            this.positionMap.setDex(tgtNft, 'orca');
            isOrphan = false;
          }
        } catch {
          /* ignore */
        }
      }
      // Also check if it's a Meteora position
      if (isOrphan && this.isMeteoraPositionChecker) {
        try {
          const isMeteora = await this.isMeteoraPositionChecker(tgtNft);
          if (isMeteora) {
            logger.info(
              MODULE,
              `Reconcile: ${tgtNft.slice(0, 8)} is Meteora position, backfilling dex='meteora' and skipping`,
            );
            this.positionMap.setDex(tgtNft, 'meteora');
            isOrphan = false;
          }
        } catch {
          /* ignore */
        }
      }
      // Also check if it's a PancakeSwap position
      if (isOrphan && this.isPcsPositionChecker) {
        try {
          const isPcs = await this.isPcsPositionChecker(tgtNft);
          if (isPcs) {
            logger.info(
              MODULE,
              `Reconcile: ${tgtNft.slice(0, 8)} is PCS position, backfilling dex='pancakeswap' and skipping`,
            );
            this.positionMap.setDex(tgtNft, 'pancakeswap');
            isOrphan = false;
          }
        } catch {
          /* ignore */
        }
      }

      if (isOrphan) {
        orphans++;
        logger.warn(
          MODULE,
          `Orphan detected: target NFT ${tgtNft.slice(0, 8)} gone, our NFT ${ourNft.slice(0, 8)} still mapped`,
        );

        if (config.dryRun) {
          logger.info(MODULE, `[DRY RUN] Would close orphan: ${ourNft.slice(0, 8)}`);
          continue;
        }

        if (!this.acquire('reconcileOrphan')) continue;
        try {
          const orphanTx = await this.retryOnTransient(
            async () => {
              const result = await this.chain.decreaseFullLiquidityInstructions({
                userAddress: getUserAddress(),
                nftMint: new PublicKey(ourNft),
                closePosition: true,
              });
              const tx = await this.makeSdkTransactionWithoutPriorityFee(result);
              const signed = await signerCallback(tx);
              return this.connection.sendTransaction(signed, {
                skipPreflight: config.skipPreflight,
              });
            },
            `orphanClose(${ourNft.slice(0, 8)})`,
          );
          const orphanOk = await this.verifyTxSuccess(orphanTx);
          if (!orphanOk) {
            logger.error(
              MODULE,
              `Orphan close TX failed on-chain: ${ourNft.slice(0, 8)}, keeping mapping`,
            );
            continue;
          }
          this.positionMap.delete(tgtNft);
          this.removeReferer(tgtNft);
          logger.info(MODULE, `Orphan closed: ${ourNft.slice(0, 8)}`);
        } catch (err: any) {
          const msg = err.message || '';
          if (/not found/i.test(msg)) {
            // Our position is already gone — clean up mapping
            this.positionMap.delete(tgtNft);
            this.removeReferer(tgtNft);
            logger.info(MODULE, `Orphan already gone, mapping removed: ${ourNft.slice(0, 8)}`);
          } else {
            logger.warn(MODULE, `Orphan close failed for ${ourNft.slice(0, 8)}: ${msg}`);
          }
        } finally {
          this.release();
        }
      }

      // Rate limit: don't spam RPC
      await new Promise((r) => setTimeout(r, 500));
    }

    if (orphans === 0) {
      logger.info(MODULE, 'Reconciliation complete: no orphans');
    }
  }

  /**
   * Enqueue reconciliation: Phase 1 scans for orphans (read-only, no queue needed),
   * Phase 2 enqueues each orphan close as NORMAL priority.
   */
  enqueueReconcile(queue: OperationQueue): void {
    if (this.positionMap.size() === 0) return;

    // Phase 1: scan for orphans (read-only RPC, doesn't need queue)
    (async () => {
      logger.info(MODULE, `Reconciling ${this.positionMap.size()} position mappings...`);
      const orphans: { tgtNft: string; ourNft: string }[] = [];
      const waitRateLimit = () => new Promise((r) => setTimeout(r, 500));

      for (const [tgtNft, ourNft] of this.positionMap.entries()) {
        // Skip non-Byreal positions — other DEX SDKs handle their own reconciliation
        const entryDex = this.positionMap.getDex(tgtNft);
        if (entryDex && entryDex !== 'byreal') continue;

        let isOrphan: boolean;
        try {
          const targetPosition = await this.chain.getPositionInfoByNftMint(new PublicKey(tgtNft));
          isOrphan = classifyByrealReconcileTarget(targetPosition).isOrphan;
        } catch (err: any) {
          if (this.isTransientError(err)) {
            logger.debug(
              MODULE,
              `Reconcile: RPC transient error for ${tgtNft.slice(0, 8)}, skipping`,
            );
            await waitRateLimit();
            continue;
          } else if (isPositionGoneError(err)) {
            logger.info(
              MODULE,
              `Reconcile: target ${tgtNft.slice(0, 8)} lookup failed (${(err.message || '').slice(0, 80)}), treating as orphan`,
            );
            isOrphan = true;
          } else {
            logger.warn(
              MODULE,
              `Reconcile: target ${tgtNft.slice(0, 8)} lookup failed (${(err.message || '').slice(0, 80)}), keeping mapping`,
            );
            await waitRateLimit();
            continue;
          }
        }
        // Before treating as orphan, check if it's an Orca position
        if (isOrphan && this.isOrcaPositionChecker) {
          try {
            const isOrca = await this.isOrcaPositionChecker(tgtNft);
            if (isOrca) {
              logger.info(
                MODULE,
                `Reconcile: ${tgtNft.slice(0, 8)} is Orca position, backfilling dex='orca' and skipping`,
              );
              this.positionMap.setDex(tgtNft, 'orca');
              isOrphan = false;
            }
          } catch {
            /* ignore */
          }
        }
        // Also check if it's a Meteora position
        if (isOrphan && this.isMeteoraPositionChecker) {
          try {
            const isMeteora = await this.isMeteoraPositionChecker(tgtNft);
            if (isMeteora) {
              logger.info(
                MODULE,
                `Reconcile: ${tgtNft.slice(0, 8)} is Meteora position, backfilling dex='meteora' and skipping`,
              );
              this.positionMap.setDex(tgtNft, 'meteora');
              isOrphan = false;
            }
          } catch {
            /* ignore */
          }
        }
        // Also check if it's a PancakeSwap position
        if (isOrphan && this.isPcsPositionChecker) {
          try {
            const isPcs = await this.isPcsPositionChecker(tgtNft);
            if (isPcs) {
              logger.info(
                MODULE,
                `Reconcile: ${tgtNft.slice(0, 8)} is PCS position, backfilling dex='pancakeswap' and skipping`,
              );
              this.positionMap.setDex(tgtNft, 'pancakeswap');
              isOrphan = false;
            }
          } catch {
            /* ignore */
          }
        }
        if (isOrphan) {
          let shouldEnqueueClose = true;
          try {
            const ourPosition = await this.chain.getPositionInfoByNftMint(new PublicKey(ourNft));
            const ourStatus = classifyByrealReconcilePosition(ourPosition, 'our');
            if (ourStatus.isOrphan) {
              this.positionMap.delete(tgtNft);
              this.removeReferer(tgtNft);
              logger.info(
                MODULE,
                `Reconcile: target ${tgtNft.slice(0, 8)} gone and our NFT ${ourNft.slice(0, 8)} already gone (${ourStatus.detail}), mapping removed`,
              );
              shouldEnqueueClose = false;
            }
          } catch (err: any) {
            if (this.isTransientError(err)) {
              logger.debug(
                MODULE,
                `Reconcile: our NFT ${ourNft.slice(0, 8)} lookup transient error (${(err.message || '').slice(0, 80)}), keeping mapping`,
              );
              shouldEnqueueClose = false;
            } else if (isPositionGoneError(err)) {
              this.positionMap.delete(tgtNft);
              this.removeReferer(tgtNft);
              logger.info(
                MODULE,
                `Reconcile: target ${tgtNft.slice(0, 8)} gone and our NFT ${ourNft.slice(0, 8)} lookup says gone, mapping removed`,
              );
              shouldEnqueueClose = false;
            } else {
              logger.warn(
                MODULE,
                `Reconcile: our NFT ${ourNft.slice(0, 8)} lookup failed (${(err.message || '').slice(0, 80)}), keeping mapping`,
              );
              shouldEnqueueClose = false;
            }
          }
          if (shouldEnqueueClose) orphans.push({ tgtNft, ourNft });
        }
        await waitRateLimit(); // Rate limit
      }

      if (orphans.length === 0) {
        logger.info(MODULE, 'Reconciliation complete: no orphans');
        return;
      }

      logger.warn(MODULE, `Found ${orphans.length} orphans, enqueuing closes...`);

      // Phase 2: enqueue each orphan close
      for (const { tgtNft, ourNft } of orphans) {
        queue.enqueue(`orphan-close(${ourNft.slice(0, 8)})`, 'NORMAL', async () => {
          await this.closeOrphan(tgtNft, ourNft);
        });
      }
    })().catch((err) => {
      logger.error(MODULE, `Reconcile scan error: ${err.message}`);
    });
  }

  /** Close a single orphan position. */
  private async closeOrphan(tgtNft: string, ourNft: string): Promise<void> {
    if (config.dryRun) {
      logger.info(MODULE, `[DRY RUN] Would close orphan: ${ourNft.slice(0, 8)}`);
      return;
    }

    try {
      const orphanTx = await this.retryOnTransient(
        async () => {
          const result = await this.chain.decreaseFullLiquidityInstructions({
            userAddress: getUserAddress(),
            nftMint: new PublicKey(ourNft),
            closePosition: true,
          });
          const tx = await this.makeSdkTransactionWithoutPriorityFee(result);
          const signed = await signerCallback(tx);
          return this.connection.sendTransaction(signed, { skipPreflight: config.skipPreflight });
        },
        `orphanClose(${ourNft.slice(0, 8)})`,
      );
      const orphanOk = await this.verifyTxSuccess(orphanTx);
      if (!orphanOk) {
        logger.error(
          MODULE,
          `Orphan close TX failed on-chain: ${ourNft.slice(0, 8)}, keeping mapping`,
        );
        return;
      }
      this.positionMap.delete(tgtNft);
      this.removeReferer(tgtNft);
      logger.info(MODULE, `Orphan closed: ${ourNft.slice(0, 8)}`);
    } catch (err: any) {
      const msg = err.message || '';
      if (/not found/i.test(msg)) {
        this.positionMap.delete(tgtNft);
        this.removeReferer(tgtNft);
        logger.info(MODULE, `Orphan already gone, mapping removed: ${ourNft.slice(0, 8)}`);
      } else {
        logger.warn(MODULE, `Orphan close failed for ${ourNft.slice(0, 8)}: ${msg}`);
      }
    }
  }

  /**
   * Check if an error is transient (RPC hiccup, rate limit, etc.) and worth retrying.
   */
  private isTransientError(err: any): boolean {
    const msg = err?.message || '';
    return /502|503|504|429|ECONNRESET|ETIMEDOUT|ENOTFOUND|timeout|Too Many Requests|Internal server error|Blockhash not found|block height exceeded|has expired|PriceSlippageCheck|0x1785/i.test(
      msg,
    );
  }

  /**
   * Check if a simulation error is retryable (e.g., insufficient funds after swap slippage).
   * Excludes "insufficient lamports" (SOL too low — not recoverable by retry).
   */
  private isRetryableSimError(err: any): boolean {
    const msg = err?.message || '';
    return /simulation failed|insufficient funds/i.test(msg) && !/insufficient lamports/i.test(msg);
  }

  /**
   * Retry wrapper for any async operation that may fail due to transient RPC errors.
   * Retries up to maxRetries times with exponential backoff (2s, 4s, 6s).
   */
  /** Round-robin selector for free RPC Chain instances */
  private nextFreeChain(): Chain {
    const chain = this.freechains[this.freechainIdx % this.freechains.length];
    this.freechainIdx++;
    return chain;
  }

  private async retryOnTransient<T>(
    fn: () => Promise<T>,
    label: string,
    maxRetries = 3,
  ): Promise<T> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        if (attempt < maxRetries - 1 && this.isTransientError(err)) {
          const delay = 2000 * (attempt + 1);
          logger.warn(
            MODULE,
            `${label}: transient error (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms`,
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
    throw new Error('unreachable');
  }

  /**
   * Retry wrapper for getPositionInfoByNftMint (handles RPC lag after TX).
   */
  private async retryGetPosition(
    nftMint: PublicKey,
  ): Promise<IGetPositionInfoByNftMintReturn | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const info = await this.chain.getPositionInfoByNftMint(nftMint);
        if (info) return info;
      } catch {
        // RPC lag, retry
      }
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
    return null;
  }

  /**
   * Verify a TX succeeded on-chain (meta.err === null).
   * Returns true if successful, false if failed or not found.
   */
  private async verifyTxSuccess(txSig: string): Promise<boolean> {
    // Retry up to 3 times with delay — RPC may not have indexed the TX yet
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 3000 * attempt));
        }
        const tx = await this.readConnection.getParsedTransaction(txSig, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        });
        if (!tx?.meta) {
          if (attempt < 2) {
            logger.debug(
              MODULE,
              `verifyTxSuccess: TX not found yet ${txSig.slice(0, 8)}, retry ${attempt + 1}/3`,
            );
            continue;
          }
          logger.warn(MODULE, `verifyTxSuccess: TX not found after retries ${txSig.slice(0, 8)}`);
          return false;
        }
        if (tx.meta.err) {
          logger.error(
            MODULE,
            `TX failed on-chain: ${txSig.slice(0, 8)} err=${JSON.stringify(tx.meta.err)}`,
          );
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
  private async parseTxTokenChanges(
    txSig: string,
    owner: PublicKey,
  ): Promise<{ mint: PublicKey; amount: BN }[]> {
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

  /** Get bot wallet SOL balance in SOL (not lamports). */
  async getSolBalance(): Promise<number> {
    try {
      const lamports = await this.readConnection.getBalance(getUserAddress());
      return lamports / 1e9;
    } catch {
      return 0;
    }
  }

  queueImportedByrealAuditCloses(
    result: ByrealNftAuditResult,
    queue: OperationQueue,
  ): ByrealNftAuditResult {
    result.closeQueued ??= [];
    result.enqueueFailed ??= [];

    for (const nft of result.importedToMapping) {
      try {
        queue.enqueue(`audit-close(${nft.slice(0, 8)})`, 'NORMAL', async () => {
          await this.manualClosePosition(nft);
        });
        result.closeQueued.push(nft);
      } catch (err: any) {
        result.enqueueFailed.push({ nft, message: err?.message || String(err) });
      }
    }

    return result;
  }

  async auditByrealNftsOnChainAndQueueClose(queue: OperationQueue): Promise<ByrealNftAuditResult> {
    const result = await this.auditByrealNftsOnChain();
    return this.queueImportedByrealAuditCloses(result, queue);
  }

  async auditByrealNftsOnChain(): Promise<ByrealNftAuditResult> {
    const owner = getUserAddress();
    const candidates = new Set<string>();

    for (const programId of [TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID]) {
      try {
        const accounts = await this.readConnection.getParsedTokenAccountsByOwner(owner, {
          programId,
        });
        for (const { account } of accounts.value) {
          const info = account.data.parsed?.info;
          const tokenAmount = info?.tokenAmount;
          if (!info?.mint || !tokenAmount) continue;
          if (tokenAmount.decimals === 0 && tokenAmount.amount === '1') {
            candidates.add(info.mint);
          }
        }
      } catch (err: any) {
        logger.warn(
          MODULE,
          `[NftAudit] Token account scan failed for ${programId.toBase58()}: ${(err.message || '').slice(0, 100)}`,
        );
      }
    }

    logger.info(
      MODULE,
      `[NftAudit] Found ${candidates.size} NFT candidates in wallet, filtering Byreal positions...`,
    );

    const onChainByrealNfts: string[] = [];
    const byrealInfo = new Map<string, IGetPositionInfoByNftMintReturn>();
    let scanned = 0;
    for (const nft of candidates) {
      scanned++;
      try {
        const info = await this.chain.getPositionInfoByNftMint(new PublicKey(nft));
        if (info) {
          onChainByrealNfts.push(nft);
          byrealInfo.set(nft, info);
        }
      } catch {
        // Not a Byreal position NFT, or stale token account; ignore for audit.
      }
      if (scanned % 50 === 0 || scanned === candidates.size) {
        logger.info(
          MODULE,
          `[NftAudit] scanned=${scanned}/${candidates.size}, byreal=${onChainByrealNfts.length}`,
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    const result = diffByrealNftAudit(this.positionMap.getByrealNfts(), onChainByrealNfts);
    for (const nft of result.unmappedOnChain) {
      const info = byrealInfo.get(nft);
      if (!info) continue;
      const pool = `${info.rawPoolInfo.mintA.toBase58()}/${info.rawPoolInfo.mintB.toBase58()}`;
      const tickLower = info.rawPositionInfo.tickLower;
      const tickUpper = info.rawPositionInfo.tickUpper;
      this.positionMap.set(nft, nft, pool, 'ONCHAIN_AUDIT', tickLower, tickUpper, 'byreal');
      this.positionMap.setTargetLiquidity(nft, info.rawPositionInfo.liquidity.toString());
      result.importedToMapping.push(nft);
      logger.warn(
        MODULE,
        `[NftAudit] imported on-chain Byreal NFT into mapping: ${nft.slice(0, 8)} (${pool})`,
      );
    }
    logger.info(
      MODULE,
      `[NftAudit] complete: mapped=${result.mappedCount}, onChain=${result.onChainCount}, ` +
        `unmappedOnChain=${result.unmappedOnChain.length}, mappedMissingOnChain=${result.mappedMissingOnChain.length}, ` +
        `imported=${result.importedToMapping.length}`,
    );
    for (const nft of result.unmappedOnChain) {
      logger.warn(MODULE, `[NftAudit] unmapped on-chain Byreal NFT: ${nft}`);
    }
    for (const nft of result.mappedMissingOnChain) {
      logger.warn(MODULE, `[NftAudit] mapped NFT missing on-chain: ${nft}`);
    }

    return result;
  }

  /** Estimate how many positions can be opened with given SOL balance. */
  estimateOpenSlots(solBalance: number): number {
    // rent (dynamic) + ~0.005 TX fee per position
    const costPerPosition = this.rentPerPosition + 0.005;
    const reserve = 0.01; // keep minimum reserve
    return Math.max(0, Math.floor((solBalance - reserve) / costPerPosition));
  }

  /**
   * Get our token balance for a specific mint.
   * Returns raw amount (not UI amount).
   * Handles wSOL/native SOL and Token2022 tokens.
   */
  private async getTokenBalance(owner: PublicKey, mint: PublicKey): Promise<BN> {
    const conn = this.readConnection; // Use Alchemy for balance reads
    const isWsol = mint.equals(NATIVE_MINT);

    // Try both TOKEN_PROGRAM_ID and TOKEN_2022_PROGRAM_ID
    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      try {
        const ata = getAssociatedTokenAddressSync(mint, owner, false, programId);
        const balance = await conn.getTokenAccountBalance(ata);
        const amount = new BN(balance.value.amount);

        if (isWsol) {
          const nativeLamports = await conn.getBalance(owner);
          const availableLamports = Math.max(0, nativeLamports - 50_000_000);
          return amount.add(new BN(availableLamports));
        }

        return amount;
      } catch {
        continue; // Try next program ID
      }
    }

    // Both failed — check native SOL as fallback
    if (isWsol) {
      try {
        const nativeLamports = await conn.getBalance(owner);
        const availableLamports = Math.max(0, nativeLamports - 50_000_000);
        return new BN(availableLamports);
      } catch {
        return new BN(0);
      }
    }
    return new BN(0);
  }

  // --- LP Position Assets ---
  private _lpAssetsCache: {
    items: Array<{
      mint: string;
      balance: number;
      decimals: number;
      pairedStable: Record<string, number>;
      liquidityUsd: number;
    }>;
    ts: number;
  } | null = null;
  private static LP_ASSETS_TTL = 5 * 60 * 1000; // 5 min — synced with asset-trend interval

  /**
   * Aggregate token amounts across ALL LP positions for our wallet
   * via Byreal REST API + local CLMM math (zero RPC calls).
   * Fetches position/list with pageSize=100, decodes base64 account data,
   * computes exact tokenA/tokenB amounts using SDK LiquidityMath.
   * Cached for 5 min.
   */
  public async getPositionAssets(): Promise<
    Array<{
      mint: string;
      balance: number;
      decimals: number;
      pairedStable: Record<string, number>;
      liquidityUsd: number;
    }>
  > {
    if (
      this._lpAssetsCache &&
      Date.now() - this._lpAssetsCache.ts < ByrealPositionExecutor.LP_ASSETS_TTL
    ) {
      return this._lpAssetsCache.items;
    }
    const userAddress = getUserAddress();
    const baseUrl = `https://api2.byreal.io/byreal/api/dex/v2/position/list?userAddress=${userAddress.toBase58()}&tab=current&pageSize=100`;

    // Fetch all active positions (paginate until we see liquidityUsd=0)
    // NOTE: Byreal indexer 對已關倉 position 偶爾仍回報 liquidityUsd > 0 但 positionAccountBase64: null
    type ApiPosition = {
      poolAddress: string;
      positionAddress?: string;
      positionAccountBase64: string | null;
      lowerTick: number;
      upperTick: number;
      liquidityUsd: string;
    };
    type ApiPoolMap = Record<
      string,
      {
        accountBase64: string | null;
        mintA: { address: string; decimals: number };
        mintB: { address: string; decimals: number };
      }
    >;
    const allPositions: ApiPosition[] = [];
    let poolMap: ApiPoolMap = {};

    for (let page = 1; page <= 30; page++) {
      try {
        const res = await fetch(`${baseUrl}&page=${page}`);
        if (!res.ok) {
          logger.warn(MODULE, `[LPAssets] Byreal API page ${page}: HTTP ${res.status}`);
          break;
        }
        const json = (await res.json()) as any;
        const positions: ApiPosition[] = json?.result?.data?.positions ?? [];
        if (positions.length === 0) break;

        // Merge poolMap from each page
        const pm = json?.result?.data?.poolMap ?? {};
        poolMap = { ...poolMap, ...pm };

        const active = positions.filter((p) => parseFloat(p.liquidityUsd) > 0);
        allPositions.push(...active);

        // If this page has closed positions, we've passed all active ones
        if (active.length < positions.length) break;
      } catch (err: any) {
        logger.error(
          MODULE,
          `[LPAssets] Byreal API page ${page} error: ${(err.message || '').slice(0, 120)}`,
        );
        break;
      }
    }

    if (allPositions.length === 0) {
      logger.warn(MODULE, `[LPAssets] No active positions from Byreal API`);
      return this._lpAssetsCache?.items ?? [];
    }

    logger.info(
      MODULE,
      `[LPAssets] Fetched ${allPositions.length} active positions via Byreal API`,
    );

    const totals = new Map<
      string,
      {
        balance: number;
        decimals: number;
        pairedStable: Record<string, number>;
        liquidityUsd: number;
      }
    >();

    // Byreal API 偶發 stale data：見下方 guard；counter 分三類便於觀測
    let skippedNullPositionBase64 = 0;
    let skippedNullPoolBase64 = 0;
    let skippedMissingPoolMap = 0;

    for (const pos of allPositions) {
      try {
        const pool = poolMap[pos.poolAddress];
        if (!pool) {
          skippedMissingPoolMap++;
          continue;
        }

        if (typeof pool.accountBase64 !== 'string' || pool.accountBase64.length === 0) {
          skippedNullPoolBase64++;
          continue;
        }

        if (
          typeof pos.positionAccountBase64 !== 'string' ||
          pos.positionAccountBase64.length === 0
        ) {
          skippedNullPositionBase64++;
          continue;
        }

        // Decode position account → liquidity (u128 at offset 81)
        const posBuf = Buffer.from(pos.positionAccountBase64, 'base64');
        const posDecoded = PersonalPositionLayout.decode(posBuf);
        const liquidity: BN = posDecoded.liquidity;
        if (liquidity.isZero()) continue;

        // Decode pool account → sqrtPriceX64, mint decimals
        const poolBuf = Buffer.from(pool.accountBase64, 'base64');
        const poolDecoded = PoolLayout.decode(poolBuf);
        const sqrtPriceX64: BN = poolDecoded.sqrtPriceX64;
        const decA: number = poolDecoded.mintDecimalsA;
        const decB: number = poolDecoded.mintDecimalsB;

        // Compute token amounts via SDK CLMM math
        const sqrtPriceLower = SqrtPriceMath.getSqrtPriceX64FromTick(pos.lowerTick);
        const sqrtPriceUpper = SqrtPriceMath.getSqrtPriceX64FromTick(pos.upperTick);
        const { amountA, amountB } = LiquidityMath.getAmountsFromLiquidity(
          sqrtPriceX64,
          sqrtPriceLower,
          sqrtPriceUpper,
          liquidity,
          false,
        );

        const mintA = pool.mintA.address;
        const mintB = pool.mintB.address;
        const uiA = parseFloat(amountA.toString()) / Math.pow(10, decA);
        const uiB = parseFloat(amountB.toString()) / Math.pow(10, decB);

        // Aggregate per-mint totals
        const prevA = totals.get(mintA);
        totals.set(mintA, {
          balance: (prevA?.balance ?? 0) + uiA,
          decimals: decA,
          pairedStable: prevA?.pairedStable ?? {},
          liquidityUsd: prevA?.liquidityUsd ?? 0,
        });
        const prevB = totals.get(mintB);
        totals.set(mintB, {
          balance: (prevB?.balance ?? 0) + uiB,
          decimals: decB,
          pairedStable: prevB?.pairedStable ?? {},
          liquidityUsd: prevB?.liquidityUsd ?? 0,
        });

        // Track paired stablecoins + attribute liquidityUsd to the non-stable side
        const mintAIsStable = STABLE_MINTS.has(mintA);
        const mintBIsStable = STABLE_MINTS.has(mintB);
        const posLiqUsd = parseFloat(pos.liquidityUsd || '0');
        if (!mintAIsStable && mintBIsStable) {
          // mintA is non-stable: attribute full position liquidityUsd + paired stable
          const e = totals.get(mintA)!;
          e.liquidityUsd += posLiqUsd;
          if (uiB > 0) e.pairedStable[mintB] = (e.pairedStable[mintB] ?? 0) + uiB;
        } else if (mintAIsStable && !mintBIsStable) {
          // mintB is non-stable: attribute full position liquidityUsd + paired stable
          const e = totals.get(mintB)!;
          e.liquidityUsd += posLiqUsd;
          if (uiA > 0) e.pairedStable[mintA] = (e.pairedStable[mintA] ?? 0) + uiA;
        } else if (!mintAIsStable && !mintBIsStable) {
          // Both non-stable: attribute to mintA (base token)
          totals.get(mintA)!.liquidityUsd += posLiqUsd;
        }
      } catch (err: any) {
        logger.warn(
          MODULE,
          `[LPAssets] decode error for pool=${pos.poolAddress} pos=${pos.positionAddress ?? '?'}: ${(err.message || '').slice(0, 100)}`,
        );
      }
    }

    if (skippedNullPositionBase64 > 0) {
      logger.warn(
        MODULE,
        `[LPAssets] Byreal indexer stale: skipped ${skippedNullPositionBase64} positions with null positionAccountBase64 (likely closed on-chain but still indexed as active)`,
      );
    }
    if (skippedNullPoolBase64 > 0) {
      logger.warn(
        MODULE,
        `[LPAssets] Byreal API inconsistent: skipped ${skippedNullPoolBase64} positions with null/empty pool.accountBase64 (partial poolMap payload)`,
      );
    }
    if (skippedMissingPoolMap > 0) {
      logger.warn(
        MODULE,
        `[LPAssets] Byreal API inconsistent: skipped ${skippedMissingPoolMap} positions with missing poolMap entry`,
      );
    }

    const items = [...totals.entries()].map(([mint, d]) => ({
      mint,
      balance: d.balance,
      decimals: d.decimals,
      pairedStable: d.pairedStable,
      liquidityUsd: d.liquidityUsd,
    }));
    this._lpAssetsCache = { items, ts: Date.now() };
    return items;
  }

  /** Invalidate all asset caches (call after OPEN/CLOSE/INCREASE/DECREASE). */
  public invalidateAssetCaches(): void {
    this._lpAssetsCache = null;
    this._walletBalancesCache = null;
  }

  /**
   * Check if opening/increasing a position would breach the concentration limit for the
   * non-stable token in the pair.
   * Returns a skip-reason string if the check fails, or null if OK to proceed.
   *
   * New position USD is computed exactly from sqrtPriceX64:
   *   price(A in B) = (sqrtPriceX64 / 2^64)² × 10^decA / 10^decB
   *   totalUsd = (amtA × priceAinB + amtB) × ratio   (when B is stable)
   *           = (amtA + amtB / priceAinB) × ratio     (when A is stable)
   * Falls back to 0 when neither token is a stable coin.
   */
  private checkConcentrationLimit(
    mintAStr: string,
    mintBStr: string,
    targetWallet: string | undefined,
    posAUiAmount: string | undefined,
    posBUiAmount: string | undefined,
    poolInfo: { sqrtPriceX64: BN; mintDecimalsA: number; mintDecimalsB: number } | undefined,
    tag: string,
  ): string | null {
    // Identify the non-stable side of the pair
    const mintToCheck = !STABLE_MINTS.has(mintAStr)
      ? mintAStr
      : !STABLE_MINTS.has(mintBStr)
        ? mintBStr
        : null;
    if (!mintToCheck) return null; // both stable — skip check

    const override = config.coinConcentrationOverrides.get(mintToCheck);
    const limitUsd = override?.usd ?? config.maxCoinConcentrationUsd;
    const limitPct = override?.pct ?? config.maxCoinConcentrationPct;
    if (limitUsd <= 0 && limitPct <= 0) return null; // disabled

    const existingLiqUsd =
      this._lpAssetsCache?.items.find((i) => i.mint === mintToCheck)?.liquidityUsd ?? 0;

    // Derive current pool price from sqrtPriceX64 (fixed-point Q64.64)
    // priceAinB = (sqrtPriceX64 / 2^64)² × 10^decA / 10^decB
    const ratio = getAmountRatio(targetWallet);
    let newPositionUsd = 0;
    if (poolInfo) {
      const TWO_POW_64 = new BN('18446744073709551616');
      const SCALE = 1_000_000;
      const sqrtScaled = poolInfo.sqrtPriceX64.mul(new BN(SCALE)).div(TWO_POW_64).toNumber();
      const sqrtPrice = sqrtScaled / SCALE;
      const priceAinB =
        (sqrtPrice * sqrtPrice * Math.pow(10, poolInfo.mintDecimalsA)) /
        Math.pow(10, poolInfo.mintDecimalsB);

      const amtA = parseFloat(posAUiAmount || '0');
      const amtB = parseFloat(posBUiAmount || '0');

      if (!STABLE_MINTS.has(mintAStr) && STABLE_MINTS.has(mintBStr)) {
        // B is stable: usdA = amtA × price, usdB = amtB
        newPositionUsd = (amtA * priceAinB + amtB) * ratio;
      } else if (STABLE_MINTS.has(mintAStr) && !STABLE_MINTS.has(mintBStr)) {
        // A is stable: usdA = amtA, usdB = amtB / priceAinB  (priceAinB = stablePerToken)
        newPositionUsd = priceAinB > 0 ? (amtA + amtB / priceAinB) * ratio : 0;
      }
      // both non-stable: leave newPositionUsd = 0 (no USD anchor without external price)
    }

    const totalProjected = existingLiqUsd + newPositionUsd;

    if (limitUsd > 0 && totalProjected > limitUsd) {
      return `集中度超限 [${tag}] $${totalProjected.toFixed(0)} > $${limitUsd} (${mintToCheck.slice(0, 8)})`;
    }
    if (limitPct > 0) {
      const totalPortfolioUsd = getLatestTotalUsd();
      if (totalPortfolioUsd > 0) {
        const projectedPct = (totalProjected / totalPortfolioUsd) * 100;
        if (projectedPct > limitPct) {
          return `集中度超限 [${tag}] ${projectedPct.toFixed(1)}% > ${limitPct}% (${mintToCheck.slice(0, 8)})`;
        }
      }
    }
    return null;
  }
}

function createMemoInstruction(data: string, signers: PublicKey[] = []): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: signers.map((pubkey) => ({ pubkey, isSigner: true, isWritable: false })),
    data: Buffer.from(data, 'utf-8'),
  });
}
