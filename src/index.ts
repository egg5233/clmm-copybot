import fs from 'fs';
import path from 'path';
import { computeSwapCapRaw } from './utils/ratio';
import { Connection, PublicKey } from '@solana/web3.js';
import { config, requireDatabaseUrl } from './config';
import { logger } from './utils/logger';
import { getUserAddress } from './utils/wallet';
import { WebSocketMonitor } from './monitor/websocket';
import { parseTransaction, ParsedEvent } from './monitor/parser';
import { ByrealPositionExecutor } from './executor/byreal-position';
import { OrcaPositionExecutor } from './executor/orca-position';
import { MeteoraPositionExecutor } from './executor/meteora-position';
import { PcsPositionExecutor } from './executor/pancakeswap-position';
import { DammV2PositionExecutor } from './executor/dammv2-position';
import { PositionMap } from './state/position-map';
import {
  backfillEventPools,
  flushActivityLog,
  getEventLog,
  getSwapHistory,
  initActivityLog,
  pushEvent,
  pushSwap,
} from './state/activity-log';
import { flushPendingSwaps, initPendingSwaps } from './state/pending-swaps-store';
import { flushTokenPnl, initTokenPnl } from './state/token-pnl-store';
import { flushOpenedReferers, initOpenedReferers } from './state/opened-referers-store';
import { flushAuthLog, startDashboard, refreshSolPrice } from './dashboard/server';
import {
  flushAssetTrend,
  startAssetTrendCollector,
  stopAssetTrendCollector,
  setSnapshotCallback,
  setRentPerPosition,
  setOrcaRentPerPosition,
  setOrcaLpFetcher,
  setMeteoraRentPerPosition,
  setMeteoraLpFetcher,
  setPcsRentPerPosition,
  setPcsLpFetcher,
  setDammV2RentPerPosition,
  setDammV2LpFetcher,
} from './dashboard/asset-trend';
import { startPoolTvlCollector, stopPoolTvlCollector } from './monitor/pool-tvl';
import {
  flushClaimHistory,
  startAutoClaimScheduler,
  stopAutoClaimScheduler,
} from './executor/auto-claim';
import { flushDacHistory, startDacScheduler, stopDacScheduler } from './executor/dac';
import { BotContext, EventLogEntry, SwapHistoryEntry } from './dashboard/context';
import { OperationQueue } from './executor/queue';
import { notifyDrawdownPause, notifyCrash, flushAllPending } from './discord/notify';
import { flushPumpPending, initPumpPending, setPumpPollerWallet } from './state/pump-pending';

const MODULE = 'Main';
const LOCK_FILE = path.resolve('./data/bot.lock');

/** Prevent multiple instances — duplicate WebSocket = duplicate trades */
function acquireLock(): void {
  const dir = path.dirname(LOCK_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(LOCK_FILE)) {
    const oldPid = fs.readFileSync(LOCK_FILE, 'utf-8').trim();
    // Check if the old process is still alive
    try {
      process.kill(parseInt(oldPid, 10), 0); // signal 0 = check existence
      logger.error(MODULE, `Another instance is running (PID ${oldPid}). Exiting.`);
      process.exit(1);
    } catch {
      // Old process is dead, stale lock file — remove it
      logger.warn(MODULE, `Stale lock file found (PID ${oldPid}), removing`);
    }
  }

  fs.writeFileSync(LOCK_FILE, process.pid.toString());
}

function releaseLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
  } catch {
    /* ignore */
  }
}

/**
 * Bring the Postgres-backed stores up before anything can mutate them.
 *
 * Each store loads what survived the restart into memory and starts persisting
 * mutations from that point; call sites keep reading them synchronously. This
 * has to finish before the WebSocket monitor starts, or an event could be
 * handled against an empty position map.
 */
async function initState(positionMap: PositionMap): Promise<void> {
  requireDatabaseUrl();
  await Promise.all([
    positionMap.init(),
    initActivityLog(),
    initPendingSwaps(),
    initTokenPnl(),
    initOpenedReferers(),
    initPumpPending(),
  ]);
}

async function main() {
  acquireLock();
  const pkg = require('../package.json');
  logger.info(MODULE, `=== Byreal Copy Bot v${pkg.version} Starting ===`);
  logger.info(MODULE, `Mode: ${config.dryRun ? 'DRY RUN' : 'LIVE'}`);
  logger.info(MODULE, `Our wallet: ${getUserAddress().toBase58()}`);
  logger.info(MODULE, `Targets: ${config.targetWallets.length} wallets`);
  for (const w of config.targetWallets) {
    const addr = w.toBase58();
    const tag = config.closeOnlyWallets.has(addr) ? ' [CLOSE-ONLY]' : '';
    logger.info(MODULE, `  -> ${addr}${tag}`);
  }
  // Log close-only wallets not in targetWallets
  for (const addr of config.closeOnlyWallets) {
    if (!config.targetWallets.some((t) => t.toBase58() === addr)) {
      logger.info(MODULE, `  -> ${addr} [CLOSE-ONLY]`);
    }
  }
  if (config.orcaEnabled) {
    logger.info(MODULE, `Orca targets: ${config.orcaTargetWallets.length} wallets`);
    for (const w of config.orcaTargetWallets) {
      const addr = w.toBase58();
      const tag = config.orcaCloseOnlyWallets.has(addr) ? ' [CLOSE-ONLY]' : '';
      logger.info(MODULE, `  [ORCA] ${addr}${tag}`);
    }
  }
  if (config.meteoraEnabled) {
    logger.info(MODULE, `Meteora targets: ${config.meteoraTargetWallets.length} wallets`);
    for (const w of config.meteoraTargetWallets) {
      const addr = w.toBase58();
      const tag = config.meteoraCloseOnlyWallets.has(addr) ? ' [CLOSE-ONLY]' : '';
      logger.info(MODULE, `  [METEORA] ${addr}${tag}`);
    }
  }
  if (config.pcsEnabled) {
    logger.info(MODULE, `PCS targets: ${config.pcsTargetWallets.length} wallets`);
    for (const w of config.pcsTargetWallets) {
      const addr = w.toBase58();
      const tag = config.pcsCloseOnlyWallets.has(addr) ? ' [CLOSE-ONLY]' : '';
      logger.info(MODULE, `  [PCS] ${addr}${tag}`);
    }
  }
  if (config.dammv2Enabled) {
    logger.info(MODULE, `DAMM v2 targets: ${config.dammv2TargetWallets.length} wallets`);
    for (const w of config.dammv2TargetWallets) {
      const addr = w.toBase58();
      const tag = config.dammv2CloseOnlyWallets.has(addr) ? ' [CLOSE-ONLY]' : '';
      logger.info(MODULE, `  [DAMMV2] ${addr}${tag}`);
    }
  }
  logger.info(MODULE, `Amount ratio: ${config.amountRatio} (global default)`);
  if (config.walletAmountRatios.size > 0) {
    for (const [addr, ratio] of config.walletAmountRatios) {
      logger.info(MODULE, `  -> ${addr}: ratio=${ratio}`);
    }
  }
  logger.info(
    MODULE,
    `RPC send: Helius | RPC read: ${config.readRpcUrl ? 'Alchemy' : 'Helius (same)'}`,
  );

  // Initialize components
  const monitor = new WebSocketMonitor();
  let connection = monitor.getConnection();
  const readConnection = config.readRpcUrl
    ? new Connection(config.readRpcUrl, { commitment: 'confirmed' })
    : connection;
  const positionMap = new PositionMap();
  await initState(positionMap);

  const byrealExecutor = new ByrealPositionExecutor(connection, positionMap);
  const orcaExecutor = config.orcaEnabled
    ? new OrcaPositionExecutor(connection, positionMap)
    : null;
  if (orcaExecutor) {
    logger.info(
      MODULE,
      `Orca Whirlpool enabled: ${config.orcaTargetWallets.length} target wallets`,
    );
    // Wire up Orca position checker for reconcile backfill
    byrealExecutor.isOrcaPositionChecker = (nft) => orcaExecutor.isOrcaPosition(nft);
  }

  const meteoraExecutor = config.meteoraEnabled
    ? new MeteoraPositionExecutor(connection, positionMap)
    : null;
  if (meteoraExecutor) {
    logger.info(
      MODULE,
      `Meteora DLMM enabled: ${config.meteoraTargetWallets.length} target wallets`,
    );
    byrealExecutor.isMeteoraPositionChecker = (pos) => meteoraExecutor.isMeteoraPosition(pos);
  }

  const pcsExecutor = config.pcsEnabled ? new PcsPositionExecutor(connection, positionMap) : null;
  if (pcsExecutor) {
    logger.info(
      MODULE,
      `PancakeSwap CLMM enabled: ${config.pcsTargetWallets.length} target wallets`,
    );
    byrealExecutor.isPcsPositionChecker = (nft) => pcsExecutor.isPcsPosition(nft);
  }

  const dammv2Executor = config.dammv2Enabled
    ? new DammV2PositionExecutor(connection, positionMap)
    : null;
  if (dammv2Executor) {
    logger.info(
      MODULE,
      `Meteora DAMM v2 enabled: ${config.dammv2TargetWallets.length} target wallets`,
    );
  }

  // When WebSocket reconnects with a new Connection, propagate to all components
  monitor.onConnectionChange((newConn) => {
    connection = newConn;
    byrealExecutor.updateConnection(newConn);
    if (orcaExecutor) orcaExecutor.updateConnection(newConn);
    if (meteoraExecutor) meteoraExecutor.updateConnection(newConn);
    if (pcsExecutor) pcsExecutor.updateConnection(newConn);
    if (dammv2Executor) dammv2Executor.updateConnection(newConn);
    logger.info(MODULE, 'All components updated with new connection');
  });

  logger.info(MODULE, `Loaded ${positionMap.size()} existing position mappings`);

  const processedSignatures = new Set<string>(); // Dedup WebSocket duplicates
  const eventLog: EventLogEntry[] = getEventLog();
  const swapHistory: SwapHistoryEntry[] = getSwapHistory();
  logger.info(
    MODULE,
    `Loaded ${eventLog.length} events and ${swapHistory.length} swap records from Postgres`,
  );

  // Backfill pool info: seed the nft→pool lookup from the position map, then label
  // events that were stored before their pool was known.
  const positionPools: Record<string, string> = {};
  for (const [targetNft, entry] of Object.entries(positionMap.toJSON())) {
    if (entry.pool) positionPools[targetNft] = entry.pool;
  }
  const { backfilled, poolCount } = backfillEventPools(positionPools);
  if (backfilled > 0) {
    logger.info(
      MODULE,
      `Backfilled pool info for ${backfilled} events (poolMap: ${poolCount} entries)`,
    );
  }

  const opQueue = new OperationQueue();

  // Start WebSocket monitoring
  await monitor.start(async (signature: string, logs: string[], targetWallet: PublicKey) => {
    if (processedSignatures.has(signature)) {
      logger.debug(MODULE, `Duplicate TX skipped: ${signature}`);
      return;
    }
    processedSignatures.add(signature);
    if (processedSignatures.size > 1000) {
      const first = processedSignatures.values().next().value;
      if (first) processedSignatures.delete(first);
    }

    const botLabel = targetWallet.toBase58().slice(0, 8);
    logger.info(MODULE, `[${botLabel}] TX detected: ${signature}`);

    // Pre-enqueue spam filter: skip mass SOL-transfer TXs that don't involve any DEX
    const involvesDex = logs.some(
      (l) =>
        l.includes(config.byrealProgramId.toBase58()) ||
        l.includes(config.orcaProgramId.toBase58()) ||
        l.includes(config.meteoraProgramId.toBase58()) ||
        (config.pcsEnabled && l.includes(config.pcsProgramId.toBase58())) ||
        l.includes('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG'), // DAMMV2
    );
    if (!involvesDex) {
      const SYS_SUCCESS = 'Program 11111111111111111111111111111111 success';
      const sysCount = logs.filter((l) => l === SYS_SUCCESS).length;
      const hasCB = logs.some((l) => l.includes('ComputeBudget111111111111111111111111111111'));
      if (sysCount >= 5 && !hasCB) {
        logger.debug(
          MODULE,
          `[${botLabel}] Spam TX filtered pre-queue (${sysCount}x sys): ${signature.slice(0, 8)}`,
        );
        return;
      }
    }

    opQueue.enqueue(`TX:${botLabel}:${signature.slice(0, 8)}`, 'HIGH', async () => {
      try {
        const events = await parseTransaction(readConnection, signature, logs, targetWallet);
        for (const event of events) {
          await handleEvent(
            byrealExecutor,
            orcaExecutor,
            meteoraExecutor,
            pcsExecutor,
            dammv2Executor,
            event,
            signature,
            botLabel,
            targetWallet,
            positionMap,
          );
        }
      } catch (err: any) {
        logger.error(MODULE, `Error processing TX ${signature}: ${err.message}`);
      }
    });
  });

  // Start Dashboard
  const botContext: BotContext = {
    monitor,
    executor: byrealExecutor,
    orcaExecutor,
    meteoraExecutor,
    pcsExecutor,
    dammv2Executor,
    positionMap,
    getConnection: () => connection,
    opQueue,
    eventLog,
    swapHistory,
    startedAt: Date.now(),
  };
  await startDashboard(botContext);

  // Init dynamic rent per position from RPC, then propagate to asset-trend + backfill position map
  byrealExecutor
    .initRentPerPosition()
    .then(() => {
      setRentPerPosition(byrealExecutor.rentPerPosition);
      byrealExecutor.backfillLockedSol();
    })
    .catch((err) => {
      logger.warn(MODULE, `Rent init error (using fallback): ${err.message}`);
    });

  if (orcaExecutor) {
    orcaExecutor
      .initRentPerPosition()
      .then(() => {
        setOrcaRentPerPosition(orcaExecutor!.rentPerPosition);
        orcaExecutor!.backfillLockedSol();
      })
      .catch((err) => {
        logger.warn(MODULE, `Orca rent init error (using fallback): ${err.message}`);
      });
    setOrcaLpFetcher(() => orcaExecutor!.getOrcaLpValueUsd());
  }

  if (meteoraExecutor) {
    meteoraExecutor
      .initRentPerPosition()
      .then(() => {
        setMeteoraRentPerPosition(meteoraExecutor!.rentPerPosition);
        meteoraExecutor!.backfillLockedSol();
      })
      .catch((err) => {
        logger.warn(MODULE, `Meteora rent init error (using fallback): ${err.message}`);
      });
    setMeteoraLpFetcher(() => meteoraExecutor!.getMeteoraLpDetails());
  }

  if (pcsExecutor) {
    pcsExecutor
      .initRentPerPosition()
      .then(() => {
        setPcsRentPerPosition(pcsExecutor!.rentPerPosition);
        pcsExecutor!.backfillLockedSol();
      })
      .catch((err) => {
        logger.warn(MODULE, `PCS rent init error (using fallback): ${err.message}`);
      });
    setPcsLpFetcher(() => pcsExecutor!.getPcsLpDetails());
  }

  if (dammv2Executor) {
    dammv2Executor
      .initRentPerPosition()
      .then(() => {
        setDammV2RentPerPosition(dammv2Executor!.rentPerPosition);
        dammv2Executor!.backfillLockedSol();
      })
      .catch((err) => {
        logger.warn(MODULE, `DAMM v2 rent init error (using fallback): ${err.message}`);
      });
    setDammV2LpFetcher(async () => {
      const d = await dammv2Executor!.getDammV2LpDetails();
      // getDammV2LpDetails returns { positions, totalUsd }; we need { lpUsd, feeUsd, count }
      // totalUsd already includes both LP + fees in USD
      return { lpUsd: d.totalUsd, feeUsd: 0, count: d.positions.length };
    });
  }
  await startAssetTrendCollector(() => byrealExecutor.invalidateAssetCaches());
  startPoolTvlCollector(config.poolTvlRefreshMinutes);
  await startAutoClaimScheduler();
  await startDacScheduler(connection);

  // Pump approval poller (only when discord mode is active)
  if (config.pumpFilterMode === 'discord') {
    setPumpPollerWallet(getUserAddress().toBase58());
  }

  // Drawdown protection: record initial asset value, check on every 5-min snapshot
  setSnapshotCallback((totalUsd: number) => {
    if (byrealExecutor.startAssetUsd === null) {
      byrealExecutor.startAssetUsd = totalUsd;
      logger.info(MODULE, `[RiskMgmt] 初始資產: $${totalUsd.toFixed(2)}`);
      return;
    }
    if (byrealExecutor.drawdownPaused) return; // Already paused
    if (config.drawdownThresholdPct <= 0) return; // Disabled
    const drawdown =
      ((byrealExecutor.startAssetUsd - totalUsd) / byrealExecutor.startAssetUsd) * 100;
    if (drawdown >= config.drawdownThresholdPct) {
      if (!byrealExecutor.drawdownWarning) {
        // First detection — warn and wait for next snapshot to confirm
        byrealExecutor.drawdownWarning = true;
        logger.warn(
          MODULE,
          `[RiskMgmt] 資產跌幅 ${drawdown.toFixed(1)}% 超過門檻 ${config.drawdownThresholdPct}%，等待下次快照確認...`,
        );
      } else {
        // Second consecutive detection — confirmed, pause
        byrealExecutor.drawdownPaused = true;
        byrealExecutor.drawdownPausedAt = Date.now();
        if (orcaExecutor) {
          orcaExecutor.drawdownPaused = true;
          orcaExecutor.drawdownPausedAt = Date.now();
        }
        if (meteoraExecutor) {
          meteoraExecutor.drawdownPaused = true;
          meteoraExecutor.drawdownPausedAt = Date.now();
        }
        if (pcsExecutor) {
          pcsExecutor.drawdownPaused = true;
          pcsExecutor.drawdownPausedAt = Date.now();
        }
        if (dammv2Executor) {
          dammv2Executor.drawdownPaused = true;
          dammv2Executor.drawdownPausedAt = Date.now();
        }
        logger.error(
          MODULE,
          `[RiskMgmt] 資產跌幅 ${drawdown.toFixed(1)}% 連續確認，已暫停所有開倉（需手動重啟）`,
        );
        notifyDrawdownPause(drawdown, byrealExecutor.startAssetUsd!, totalUsd);
      }
    } else {
      // Recovered — reset warning
      if (byrealExecutor.drawdownWarning) {
        logger.info(MODULE, `[RiskMgmt] 資產跌幅 ${drawdown.toFixed(1)}% 回到門檻內，取消警告`);
        byrealExecutor.drawdownWarning = false;
      }
    }
  });

  const reconcileIntervalMs = Math.max(1, config.reconcileIntervalMinutes) * 60 * 1000;

  // Periodic maintenance: log pending status (every 10 min) + reconcile orphans (default every 6 hours)
  const maintenanceTimer = setInterval(
    () => {
      byrealExecutor.logPendingStatus().catch((err) => {
        logger.error(MODULE, `Pending status check error: ${err.message}`);
      });
    },
    10 * 60 * 1000,
  );

  // Stagger reconcile timers to avoid Alchemy 429 burst (v1.24.8)
  // Each DEX reconciler fires 15s apart, starting 60s after the interval
  // to avoid collision with asset-trend snapshot (every 5 min)
  const reconcileTimer = setInterval(() => {
    setTimeout(() => byrealExecutor.enqueueReconcile(opQueue), 60_000);
    if (orcaExecutor) {
      setTimeout(
        () =>
          orcaExecutor.reconcileOrcaPositions(opQueue).catch((err) => {
            logger.error(MODULE, `Orca reconcile error: ${err.message}`);
          }),
        75_000,
      );
    }
    if (meteoraExecutor) {
      setTimeout(
        () =>
          meteoraExecutor.reconcileMeteoraPositions(opQueue).catch((err) => {
            logger.error(MODULE, `Meteora reconcile error: ${err.message}`);
          }),
        90_000,
      );
    }
    if (pcsExecutor) {
      setTimeout(
        () =>
          pcsExecutor.reconcilePcsPositions(opQueue).catch((err) => {
            logger.error(MODULE, `PCS reconcile error: ${err.message}`);
          }),
        105_000,
      );
    }
    if (dammv2Executor) {
      setTimeout(
        () =>
          dammv2Executor.reconcileDammV2Positions(opQueue).catch((err) => {
            logger.error(MODULE, `DAMM v2 reconcile error: ${err.message}`);
          }),
        120_000,
      );
    }
  }, reconcileIntervalMs);

  // Graceful shutdown
  const shutdown = async () => {
    logger.info(MODULE, 'Shutting down...');
    stopAutoClaimScheduler();
    stopDacScheduler();
    stopAssetTrendCollector();
    stopPoolTvlCollector();
    clearInterval(maintenanceTimer);
    clearInterval(reconcileTimer);
    await monitor.stop();
    // Let the queued state writes reach Postgres before the process goes away.
    await Promise.all([
      positionMap.flush(),
      flushActivityLog(),
      flushPendingSwaps(),
      flushTokenPnl(),
      flushOpenedReferers(),
      flushPumpPending(),
      flushAssetTrend(),
      flushAuthLog(),
      flushClaimHistory(),
      flushDacHistory(),
    ]);
    await flushAllPending();
    releaseLock();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  process.on('uncaughtException', async (err) => {
    logger.error(MODULE, `Uncaught exception: ${err.message}`);
    await notifyCrash(err).catch(() => {});
    releaseLock();
    process.exit(1);
  });

  process.on('unhandledRejection', (reason: any) => {
    logger.error(MODULE, `Unhandled rejection: ${reason?.message || reason}`);
    notifyCrash(reason instanceof Error ? reason : new Error(String(reason))).catch(() => {});
  });

  logger.info(MODULE, '=== Bot running. Waiting for target activity... ===');

  // Backfill pool info for positions opened before v1.3.8 (non-blocking)
  byrealExecutor.backfillPoolInfo().catch((err) => {
    logger.warn(MODULE, `Pool backfill error: ${err.message}`);
  });
}

/** Fetch PnL for a closed position from Byreal API (for token cooldown tracking) */
async function fetchPositionPnl(
  executor: ByrealPositionExecutor,
  pool: string,
  ourNft: string,
): Promise<void> {
  // Wait for API to update after close
  await new Promise((r) => setTimeout(r, 5000));

  const address = getUserAddress().toBase58();
  const res = await fetch(
    `https://api2.byreal.io/byreal/api/dex/v2/position/list?userAddress=${address}&page=1&pageSize=20&status=1`,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json',
        Referer: 'https://www.byreal.io/',
      },
    },
  );
  if (!res.ok) return;
  const data = (await res.json()) as any;
  const positions = data?.result?.data?.positions;
  if (!Array.isArray(positions)) return;

  const match = positions.find((p: any) => p.nftMintAddress === ourNft);
  if (match && match.pnlUsd !== undefined) {
    // Total PnL = position P&L + earned fees + bonus (copy rewards)
    const positionPnl = parseFloat(match.pnlUsd || '0');
    const earnedFees = parseFloat(match.earnedUsd || '0');
    const bonus = parseFloat(match.bonusUsd || '0');
    const totalPnl = positionPnl + earnedFees + bonus;
    logger.info(
      'RiskMgmt',
      `CLOSE PnL for ${pool.split('/')[0]?.slice(0, 8)}…: position=$${positionPnl.toFixed(4)} fees=$${earnedFees.toFixed(4)} bonus=$${bonus.toFixed(4)} → total=$${totalPnl.toFixed(4)}`,
    );
    executor.recordTokenPnl(pool, totalPnl);
  }
}

async function handleEvent(
  byrealExecutor: ByrealPositionExecutor,
  orcaExecutor: OrcaPositionExecutor | null,
  meteoraExecutor: MeteoraPositionExecutor | null,
  pcsExecutor: PcsPositionExecutor | null,
  dammv2Executor: DammV2PositionExecutor | null,
  event: ParsedEvent,
  txSig: string,
  botLabel: string,
  targetWallet: PublicKey,
  positionMap: PositionMap,
) {
  const isCloseOnly = config.closeOnlyWallets.has(targetWallet.toBase58());

  // Derive DEX from event type for event log tagging
  const eventDex: string | undefined = event.type.startsWith('DAMMV2_')
    ? 'dammv2'
    : event.type.startsWith('ORCA_')
      ? 'orca'
      : event.type.startsWith('METEORA_')
        ? 'meteora'
        : event.type.startsWith('PCS_')
          ? 'pancakeswap'
          : event.type === 'JUPITER_SWAP'
            ? undefined
            : event.type === 'UNKNOWN'
              ? undefined
              : 'byreal';

  // Local pushEvent wrapper that auto-tags dex
  const push = (entry: EventLogEntry) => pushEvent(entry, eventDex);

  switch (event.type) {
    case 'JUPITER_SWAP': {
      const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
      logger.info(
        MODULE,
        `[${botLabel}][JUPITER SWAP] ${event.inputMint.slice(0, 8)} -> ${event.outputMint.slice(0, 8)}`,
        {
          inputAmount: event.inputAmount,
          outputAmount: event.outputAmount,
        },
      );

      // Target selling token → USDC: swap targetAmount × walletRatio, capped at bot balance
      if (event.outputMint === USDC_MINT) {
        // Determine the effective ratio for this target wallet (check all DEX ratio maps)
        const targetAddr = targetWallet.toBase58();
        const walletRatio =
          config.orcaWalletAmountRatios.get(targetAddr) ??
          config.meteoraWalletAmountRatios.get(targetAddr) ??
          config.pcsWalletAmountRatios.get(targetAddr) ??
          config.dammv2WalletAmountRatios.get(targetAddr) ??
          config.walletAmountRatios.get(targetAddr) ??
          config.amountRatio;
        // Scale target's swap amount by ratio. A cap we cannot compute as a
        // positive amount (missing parsed amount, or a ratio that rounds the
        // scaled value to zero) must SKIP the swap — passing undefined here
        // would tell swapTokenToUSDC to sell the entire wallet balance of the
        // token, turning a dust-sized target swap into a full liquidation.
        // Manual full-balance swaps remain available via the dashboard.
        const maxAmountRaw = computeSwapCapRaw(event.inputAmountRaw, walletRatio);
        if (maxAmountRaw === null) {
          logger.warn(
            MODULE,
            `[${botLabel}][JUPITER SWAP] Skipping ${event.inputMint.slice(0, 8)}: target amount ${event.inputAmountRaw || '(unknown)'} × ratio=${walletRatio} scales to zero — not swapping (use dashboard force-swap for a full-balance sell)`,
          );
          return;
        }
        logger.info(
          MODULE,
          `[${botLabel}][JUPITER SWAP] Target swapped ${event.inputAmountRaw} × ratio=${walletRatio} → max=${maxAmountRaw}`,
        );
        const result = await byrealExecutor.swapTokenToUSDC(event.inputMint, maxAmountRaw);
        if (result) {
          push({
            ts: Date.now(),
            type: 'SWAP',
            targetWallet: targetWallet.toBase58(),
            txSig: result.sig,
            success: true,
            pool: `${event.inputMint}/${USDC_MINT}`,
          });
          pushSwap({
            ts: Date.now(),
            inputMint: event.inputMint,
            txSig: result.sig,
            inputAmountRaw: result.amountRaw,
            outputAmountRaw: result.outputRaw,
          });
          logger.info(MODULE, `[${botLabel}][JUPITER SWAP] Our swap TX: ${result.sig}`);
          byrealExecutor.invalidateAssetCaches();
        }
        // null = no balance or stablecoin — don't log as failure
      }
      break;
    }

    case 'BYREAL_OPEN_POSITION': {
      if (byrealExecutor.solPaused) {
        logger.warn(MODULE, `[${botLabel}][OPEN] Skipped (SOL 不足暫停中)`);
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: 'SOL 不足',
        });
        break;
      }
      if (byrealExecutor.drawdownPaused) {
        logger.warn(MODULE, `[${botLabel}][OPEN] Skipped (資產跌幅暫停)`);
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: '資產跌幅暫停',
        });
        break;
      }
      if (isCloseOnly) {
        logger.info(MODULE, `[${botLabel}][OPEN] Skipped (close-only target)`);
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: 'close-only',
        });
        break;
      }

      // Resolve pool mints (cache or from TX parser)
      let openPoolMints = byrealExecutor.poolIdToMints.get(event.poolId);
      if (!openPoolMints && event.poolMints) {
        openPoolMints = event.poolMints;
        byrealExecutor.poolIdToMints.set(event.poolId, openPoolMints);
      }

      // Token cooldown check
      if (openPoolMints && byrealExecutor.isTokenCoolingDown(openPoolMints)) {
        logger.warn(MODULE, `[${botLabel}][OPEN] Skipped (代幣冷靜期: ${openPoolMints})`);
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: '代幣冷靜期',
          pool: openPoolMints,
        });
        break;
      }

      // Token blacklist check
      if (openPoolMints && byrealExecutor.isTokenBlacklisted(openPoolMints)) {
        logger.warn(MODULE, `[${botLabel}][OPEN] Skipped (黑名單代幣: ${openPoolMints})`);
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: '黑名單代幣',
          pool: openPoolMints,
        });
        break;
      }

      logger.info(MODULE, `[${botLabel}][OPEN POSITION] pool=${event.poolId.slice(0, 8)}`, {
        ticks: `[${event.tickLower}, ${event.tickUpper}]`,
        referer: event.refererPosition?.slice(0, 8) || 'none',
        nft: event.positionNftMint.slice(0, 8),
      });

      // Pre-check: skip if duplicate (not a failure)
      if (byrealExecutor.hasMapping(event.positionNftMint)) {
        logger.info(
          MODULE,
          `[${botLabel}][OPEN] Already mapped ${event.positionNftMint.slice(0, 8)}, skipping`,
        );
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: '重複目標',
        });
        break;
      }
      if (byrealExecutor.isRefererDuplicate(event.refererPosition, targetWallet.toBase58())) {
        logger.info(
          MODULE,
          `[${botLabel}][OPEN] Duplicate referer ${event.refererPosition?.slice(0, 8)}, skipping`,
        );
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: '重複來源',
        });
        break;
      }

      const ourSig = await byrealExecutor.copyOpenPosition(
        event.positionNftMint,
        event.poolId,
        event.refererPosition,
        targetWallet.toBase58(),
      );

      // copyOpenPosition sets lastSkipReason when it returns null due to an intentional skip
      const skipReason = byrealExecutor.lastSkipReason;
      byrealExecutor.lastSkipReason = null;

      if (ourSig === null && skipReason) {
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: skipReason,
          pool: positionMap.getPool(event.positionNftMint),
        });
        break;
      }

      push({
        ts: Date.now(),
        type: 'OPEN',
        targetWallet: targetWallet.toBase58(),
        targetNft: event.positionNftMint,
        txSig: ourSig || undefined,
        success: !!ourSig,
        pool: positionMap.getPool(event.positionNftMint),
      });

      if (ourSig) {
        logger.info(MODULE, `[${botLabel}][OPEN POSITION] Our TX: ${ourSig}`);
        refreshSolPrice().catch(() => {});
        byrealExecutor.invalidateAssetCaches();
      }
      break;
    }

    case 'BYREAL_INCREASE_LIQUIDITY': {
      if (byrealExecutor.solPaused) {
        logger.warn(MODULE, `[${botLabel}][INCREASE] Skipped (SOL 不足暫停中)`);
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: 'SOL 不足',
        });
        break;
      }
      if (byrealExecutor.drawdownPaused) {
        logger.warn(MODULE, `[${botLabel}][INCREASE] Skipped (資產跌幅暫停)`);
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: '資產跌幅暫停',
        });
        break;
      }
      if (isCloseOnly) {
        logger.info(MODULE, `[${botLabel}][INCREASE] Skipped (close-only target)`);
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: 'close-only',
        });
        break;
      }
      // Token blacklist check for INCREASE
      const increasePool = positionMap.getPool(event.positionNftMint);
      if (increasePool && byrealExecutor.isTokenBlacklisted(increasePool)) {
        logger.warn(MODULE, `[${botLabel}][INCREASE] Skipped (黑名單代幣: ${increasePool})`);
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: '黑名單代幣',
          pool: increasePool,
        });
        break;
      }
      logger.info(MODULE, `[${botLabel}][INCREASE] nft=${event.positionNftMint.slice(0, 8)}`);

      if (!byrealExecutor.hasMapping(event.positionNftMint)) {
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: '無映射',
        });
        break;
      }

      const ourSig = await byrealExecutor.copyIncreaseLiquidity(
        event.positionNftMint,
        targetWallet.toBase58(),
      );
      push({
        ts: Date.now(),
        type: 'INCREASE',
        targetWallet: targetWallet.toBase58(),
        targetNft: event.positionNftMint,
        txSig: ourSig || undefined,
        success: !!ourSig,
      });
      if (ourSig) {
        logger.info(MODULE, `[${botLabel}][INCREASE] Our TX: ${ourSig}`);
        byrealExecutor.invalidateAssetCaches();
      }
      break;
    }

    case 'BYREAL_DECREASE_LIQUIDITY': {
      logger.info(MODULE, `[${botLabel}][DECREASE] nft=${event.positionNftMint.slice(0, 8)}`);

      if (!byrealExecutor.hasMapping(event.positionNftMint)) {
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: '無映射',
        });
        break;
      }

      const result = await byrealExecutor.copyDecreaseLiquidity(event.positionNftMint);
      const evtType = result?.type || 'DECREASE';
      push({
        ts: Date.now(),
        type: evtType,
        targetWallet: targetWallet.toBase58(),
        targetNft: event.positionNftMint,
        txSig: result?.txSig || undefined,
        success: !!result,
      });
      if (result) {
        logger.info(MODULE, `[${botLabel}][${evtType}] Our TX: ${result.txSig}`);
        byrealExecutor.invalidateAssetCaches();
      }
      break;
    }

    case 'BYREAL_CLOSE_POSITION': {
      logger.info(MODULE, `[${botLabel}][CLOSE] nft=${event.positionNftMint.slice(0, 8)}`);

      // Record bot's received token amounts (for pending swap tracking)
      byrealExecutor.recordBotCloseReceived(event.receivedTokens);

      if (!byrealExecutor.hasMapping(event.positionNftMint)) {
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: '無映射',
        });
        break;
      }

      // Save pool + ourNft BEFORE close (close deletes the mapping)
      const closePool = positionMap.getPool(event.positionNftMint);
      const closeOurNft = positionMap.get(event.positionNftMint);
      const ourSig = await byrealExecutor.copyClosePosition(event.positionNftMint);
      push({
        ts: Date.now(),
        type: 'CLOSE',
        targetWallet: targetWallet.toBase58(),
        targetNft: event.positionNftMint,
        txSig: ourSig || undefined,
        success: !!ourSig,
        pool: closePool,
      });
      if (ourSig) {
        logger.info(MODULE, `[${botLabel}][CLOSE] Our TX: ${ourSig}`);
        refreshSolPrice().catch(() => {});
        byrealExecutor.invalidateAssetCaches();
        // Async PnL check for token cooldown (non-blocking)
        if (closePool && closeOurNft) {
          fetchPositionPnl(byrealExecutor, closePool, closeOurNft).catch((err) => {
            logger.debug(MODULE, `PnL check failed: ${err.message}`);
          });
        }
      }
      break;
    }

    // ===== Orca Whirlpool Events =====

    case 'ORCA_OPEN_POSITION': {
      if (!orcaExecutor) {
        logger.debug(MODULE, `[${botLabel}][ORCA OPEN] Orca not enabled, ignoring`);
        break;
      }
      if (orcaExecutor.drawdownPaused || orcaExecutor.solPaused) {
        const reason = orcaExecutor.solPaused ? 'SOL 不足' : '資產跌幅暫停';
        logger.warn(MODULE, `[${botLabel}][ORCA OPEN] Skipped (${reason})`);
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: `Orca: ${reason}`,
        });
        break;
      }
      if (config.orcaCloseOnlyWallets.has(targetWallet.toBase58())) {
        logger.info(MODULE, `[${botLabel}][ORCA OPEN] Skipped (close-only target)`);
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: 'Orca close-only',
        });
        break;
      }

      logger.info(
        MODULE,
        `[${botLabel}][ORCA OPEN] pool=${event.poolAddress.slice(0, 8)} ticks=[${event.tickLower},${event.tickUpper}] nft=${event.positionNftMint.slice(0, 8)}`,
      );

      if (orcaExecutor.hasMapping(event.positionNftMint)) {
        logger.info(MODULE, `[${botLabel}][ORCA OPEN] Already mapped, skipping`);
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: 'Orca 重複目標',
        });
        break;
      }

      const ourSig = await orcaExecutor.copyOpenPosition(
        event.positionNftMint,
        event.poolAddress,
        targetWallet.toBase58(),
      );

      const skipReason = orcaExecutor.lastSkipReason;
      orcaExecutor.lastSkipReason = null;

      if (ourSig === null && skipReason) {
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: `Orca: ${skipReason}`,
          pool: event.poolMints,
        });
        break;
      }

      push({
        ts: Date.now(),
        type: 'OPEN',
        targetWallet: targetWallet.toBase58(),
        targetNft: event.positionNftMint,
        txSig: ourSig || undefined,
        success: !!ourSig,
        pool: event.poolMints || positionMap.getPool(event.positionNftMint),
      });
      if (ourSig) {
        logger.info(MODULE, `[${botLabel}][ORCA OPEN] Our TX: ${ourSig}`);
        refreshSolPrice().catch(() => {});
        byrealExecutor.invalidateAssetCaches();
      }
      break;
    }

    case 'ORCA_INCREASE_LIQUIDITY': {
      if (!orcaExecutor) break;
      if (orcaExecutor.solPaused || orcaExecutor.drawdownPaused) {
        logger.warn(MODULE, `[${botLabel}][ORCA INCREASE] Skipped (paused)`);
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: 'Orca paused',
        });
        break;
      }
      if (config.orcaCloseOnlyWallets.has(targetWallet.toBase58())) {
        logger.info(MODULE, `[${botLabel}][ORCA INCREASE] Skipped (close-only)`);
        break;
      }
      logger.info(MODULE, `[${botLabel}][ORCA INCREASE] nft=${event.positionNftMint.slice(0, 8)}`);

      if (!orcaExecutor.hasMapping(event.positionNftMint)) {
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: 'Orca 無映射',
        });
        break;
      }

      const ourSig = await orcaExecutor.copyIncreaseLiquidity(
        event.positionNftMint,
        targetWallet.toBase58(),
      );
      push({
        ts: Date.now(),
        type: 'INCREASE',
        targetWallet: targetWallet.toBase58(),
        targetNft: event.positionNftMint,
        txSig: ourSig || undefined,
        success: !!ourSig,
      });
      if (ourSig) {
        logger.info(MODULE, `[${botLabel}][ORCA INCREASE] Our TX: ${ourSig}`);
        byrealExecutor.invalidateAssetCaches();
      }
      break;
    }

    case 'ORCA_DECREASE_LIQUIDITY': {
      if (!orcaExecutor) break;
      logger.info(MODULE, `[${botLabel}][ORCA DECREASE] nft=${event.positionNftMint.slice(0, 8)}`);

      if (!orcaExecutor.hasMapping(event.positionNftMint)) {
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: 'Orca 無映射',
        });
        break;
      }

      const result = await orcaExecutor.copyDecreaseLiquidity(event.positionNftMint);
      const evtType = result?.type || 'DECREASE';
      push({
        ts: Date.now(),
        type: evtType,
        targetWallet: targetWallet.toBase58(),
        targetNft: event.positionNftMint,
        txSig: result?.txSig || undefined,
        success: !!result,
      });
      if (result) {
        logger.info(MODULE, `[${botLabel}][ORCA ${evtType}] Our TX: ${result.txSig}`);
        byrealExecutor.invalidateAssetCaches();
      }
      break;
    }

    case 'ORCA_CLOSE_POSITION': {
      if (!orcaExecutor) break;
      logger.info(MODULE, `[${botLabel}][ORCA CLOSE] nft=${event.positionNftMint.slice(0, 8)}`);

      byrealExecutor.recordBotCloseReceived(event.receivedTokens);

      if (!orcaExecutor.hasMapping(event.positionNftMint)) {
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: 'Orca 無映射',
        });
        break;
      }

      const closePool = positionMap.getPool(event.positionNftMint);
      const ourSig = await orcaExecutor.copyClosePosition(event.positionNftMint);
      push({
        ts: Date.now(),
        type: 'CLOSE',
        targetWallet: targetWallet.toBase58(),
        targetNft: event.positionNftMint,
        txSig: ourSig || undefined,
        success: !!ourSig,
        pool: closePool,
      });
      if (ourSig) {
        logger.info(MODULE, `[${botLabel}][ORCA CLOSE] Our TX: ${ourSig}`);
        refreshSolPrice().catch(() => {});
        byrealExecutor.invalidateAssetCaches();
      }
      break;
    }

    // ===== Meteora DLMM Events =====

    case 'METEORA_OPEN_POSITION': {
      if (!meteoraExecutor) {
        logger.debug(MODULE, `[${botLabel}][METEORA OPEN] Meteora not enabled, ignoring`);
        break;
      }
      if (meteoraExecutor.drawdownPaused || meteoraExecutor.solPaused) {
        const reason = meteoraExecutor.solPaused ? 'SOL 不足' : '資產跌幅暫停';
        logger.warn(MODULE, `[${botLabel}][METEORA OPEN] Skipped (${reason})`);
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionAddress,
          success: true,
          error: `Meteora: ${reason}`,
        });
        break;
      }
      if (config.meteoraCloseOnlyWallets.has(targetWallet.toBase58())) {
        logger.info(MODULE, `[${botLabel}][METEORA OPEN] Skipped (close-only target)`);
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionAddress,
          success: true,
          error: 'Meteora close-only',
        });
        break;
      }

      logger.info(
        MODULE,
        `[${botLabel}][METEORA OPEN] pool=${event.poolAddress.slice(0, 8)} bins=[${event.lowerBinId},${event.lowerBinId + event.width}] pos=${event.positionAddress.slice(0, 8)}`,
      );

      if (meteoraExecutor.hasMapping(event.positionAddress)) {
        logger.info(MODULE, `[${botLabel}][METEORA OPEN] Already mapped, skipping`);
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionAddress,
          success: true,
          error: 'Meteora 重複目標',
        });
        break;
      }

      const ourSig = await meteoraExecutor.copyOpenPosition(
        event.positionAddress,
        event.poolAddress,
        targetWallet.toBase58(),
      );

      const skipReason = meteoraExecutor.lastSkipReason;
      meteoraExecutor.lastSkipReason = null;

      if (ourSig === null && skipReason) {
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionAddress,
          success: true,
          error: `Meteora: ${skipReason}`,
        });
        break;
      }

      push({
        ts: Date.now(),
        type: 'OPEN',
        targetWallet: targetWallet.toBase58(),
        targetNft: event.positionAddress,
        txSig: ourSig || undefined,
        success: !!ourSig,
        pool: positionMap.getPool(event.positionAddress),
      });
      if (ourSig) {
        logger.info(MODULE, `[${botLabel}][METEORA OPEN] Our TX: ${ourSig}`);
        refreshSolPrice().catch(() => {});
        byrealExecutor.invalidateAssetCaches();
      }
      break;
    }

    case 'METEORA_ADD_LIQUIDITY': {
      if (!meteoraExecutor) break;
      if (meteoraExecutor.solPaused || meteoraExecutor.drawdownPaused) {
        logger.warn(MODULE, `[${botLabel}][METEORA ADD] Skipped (paused)`);
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionAddress,
          success: true,
          error: 'Meteora paused',
        });
        break;
      }
      if (config.meteoraCloseOnlyWallets.has(targetWallet.toBase58())) {
        logger.info(MODULE, `[${botLabel}][METEORA ADD] Skipped (close-only)`);
        break;
      }
      logger.info(MODULE, `[${botLabel}][METEORA ADD] pos=${event.positionAddress.slice(0, 8)}`);

      if (!meteoraExecutor.hasMapping(event.positionAddress)) {
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionAddress,
          success: true,
          error: 'Meteora 無映射',
        });
        break;
      }

      const ourSig = await meteoraExecutor.copyAddLiquidity(
        event.positionAddress,
        targetWallet.toBase58(),
      );
      push({
        ts: Date.now(),
        type: 'INCREASE',
        targetWallet: targetWallet.toBase58(),
        targetNft: event.positionAddress,
        txSig: ourSig || undefined,
        success: !!ourSig,
      });
      if (ourSig) {
        logger.info(MODULE, `[${botLabel}][METEORA ADD] Our TX: ${ourSig}`);
        byrealExecutor.invalidateAssetCaches();
      }
      break;
    }

    case 'METEORA_REMOVE_LIQUIDITY': {
      if (!meteoraExecutor) break;
      logger.info(MODULE, `[${botLabel}][METEORA REMOVE] pos=${event.positionAddress.slice(0, 8)}`);

      if (!meteoraExecutor.hasMapping(event.positionAddress)) {
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionAddress,
          success: true,
          error: 'Meteora 無映射',
        });
        break;
      }

      const result = await meteoraExecutor.copyRemoveLiquidity(event.positionAddress);
      const evtType = result?.type || 'DECREASE';
      push({
        ts: Date.now(),
        type: evtType,
        targetWallet: targetWallet.toBase58(),
        targetNft: event.positionAddress,
        txSig: result?.txSig || undefined,
        success: !!result,
      });
      if (result) {
        logger.info(MODULE, `[${botLabel}][METEORA ${evtType}] Our TX: ${result.txSig}`);
        byrealExecutor.invalidateAssetCaches();
      }
      break;
    }

    case 'METEORA_CLOSE_POSITION': {
      if (!meteoraExecutor) break;
      logger.info(MODULE, `[${botLabel}][METEORA CLOSE] pos=${event.positionAddress.slice(0, 8)}`);

      byrealExecutor.recordBotCloseReceived(event.receivedTokens);

      if (!meteoraExecutor.hasMapping(event.positionAddress)) {
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionAddress,
          success: true,
          error: 'Meteora 無映射',
        });
        break;
      }

      const closePool = positionMap.getPool(event.positionAddress);
      const ourSig = await meteoraExecutor.copyClosePosition(event.positionAddress);

      const skipReason = meteoraExecutor.lastSkipReason;
      meteoraExecutor.lastSkipReason = null;

      if (ourSig === null && skipReason) {
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionAddress,
          success: true,
          error: `Meteora: ${skipReason}`,
        });
        break;
      }

      push({
        ts: Date.now(),
        type: 'CLOSE',
        targetWallet: targetWallet.toBase58(),
        targetNft: event.positionAddress,
        txSig: ourSig || undefined,
        success: !!ourSig,
        pool: closePool,
      });
      if (ourSig) {
        logger.info(MODULE, `[${botLabel}][METEORA CLOSE] Our TX: ${ourSig}`);
        refreshSolPrice().catch(() => {});
        byrealExecutor.invalidateAssetCaches();
      }
      break;
    }

    // ===== PancakeSwap CLMM Events =====

    case 'PCS_OPEN_POSITION': {
      if (!pcsExecutor) {
        logger.debug(MODULE, `[${botLabel}][PCS OPEN] PCS not enabled, ignoring`);
        break;
      }
      if (pcsExecutor.drawdownPaused || pcsExecutor.solPaused) {
        const reason = pcsExecutor.solPaused ? 'SOL 不足' : '資產跌幅暫停';
        logger.warn(MODULE, `[${botLabel}][PCS OPEN] Skipped (${reason})`);
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: `PCS: ${reason}`,
        });
        break;
      }
      if (config.pcsCloseOnlyWallets.has(targetWallet.toBase58())) {
        logger.info(MODULE, `[${botLabel}][PCS OPEN] Skipped (close-only target)`);
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: 'PCS close-only',
        });
        break;
      }

      // Pool mints cache
      let openPoolMints = pcsExecutor.poolIdToMints.get(event.poolId);
      if (!openPoolMints && event.poolMints) {
        openPoolMints = event.poolMints;
        pcsExecutor.poolIdToMints.set(event.poolId, openPoolMints);
      }

      // Token blacklist check
      if (openPoolMints && pcsExecutor.isTokenBlacklisted(openPoolMints)) {
        logger.warn(MODULE, `[${botLabel}][PCS OPEN] Skipped (黑名單代幣)`);
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: 'PCS 黑名單代幣',
          pool: openPoolMints,
        });
        break;
      }

      // Token cooldown (shared with Byreal)
      if (openPoolMints && byrealExecutor.isTokenCoolingDown(openPoolMints)) {
        logger.warn(MODULE, `[${botLabel}][PCS OPEN] Skipped (代幣冷靜期)`);
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: 'PCS 代幣冷靜期',
          pool: openPoolMints,
        });
        break;
      }

      logger.info(
        MODULE,
        `[${botLabel}][PCS OPEN] pool=${event.poolId.slice(0, 8)} nft=${event.positionNftMint.slice(0, 8)}`,
      );

      if (pcsExecutor.hasMapping(event.positionNftMint)) {
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: 'PCS 重複目標',
        });
        break;
      }

      const ourSig = await pcsExecutor.copyOpenPosition(
        event.positionNftMint,
        event.poolId,
        event.refererPosition,
        targetWallet.toBase58(),
      );

      const skipReason = pcsExecutor.lastSkipReason;
      pcsExecutor.lastSkipReason = null;

      if (ourSig === null && skipReason) {
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: `PCS: ${skipReason}`,
          pool: positionMap.getPool(event.positionNftMint),
        });
        break;
      }

      push({
        ts: Date.now(),
        type: 'OPEN',
        targetWallet: targetWallet.toBase58(),
        targetNft: event.positionNftMint,
        txSig: ourSig || undefined,
        success: !!ourSig,
        pool: positionMap.getPool(event.positionNftMint),
      });
      if (ourSig) {
        logger.info(MODULE, `[${botLabel}][PCS OPEN] Our TX: ${ourSig}`);
        refreshSolPrice().catch(() => {});
        byrealExecutor.invalidateAssetCaches();
      }
      break;
    }

    case 'PCS_INCREASE_LIQUIDITY': {
      if (!pcsExecutor) break;
      if (pcsExecutor.solPaused || pcsExecutor.drawdownPaused) {
        logger.warn(MODULE, `[${botLabel}][PCS INCREASE] Skipped (paused)`);
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: 'PCS paused',
        });
        break;
      }
      if (config.pcsCloseOnlyWallets.has(targetWallet.toBase58())) {
        logger.info(MODULE, `[${botLabel}][PCS INCREASE] Skipped (close-only)`);
        break;
      }
      logger.info(MODULE, `[${botLabel}][PCS INCREASE] nft=${event.positionNftMint.slice(0, 8)}`);

      if (!pcsExecutor.hasMapping(event.positionNftMint)) {
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: 'PCS 無映射',
        });
        break;
      }

      const ourSig = await pcsExecutor.copyIncreaseLiquidity(
        event.positionNftMint,
        targetWallet.toBase58(),
      );
      push({
        ts: Date.now(),
        type: 'INCREASE',
        targetWallet: targetWallet.toBase58(),
        targetNft: event.positionNftMint,
        txSig: ourSig || undefined,
        success: !!ourSig,
      });
      if (ourSig) {
        logger.info(MODULE, `[${botLabel}][PCS INCREASE] Our TX: ${ourSig}`);
        byrealExecutor.invalidateAssetCaches();
      }
      break;
    }

    case 'PCS_DECREASE_LIQUIDITY': {
      if (!pcsExecutor) break;
      logger.info(MODULE, `[${botLabel}][PCS DECREASE] nft=${event.positionNftMint.slice(0, 8)}`);

      if (!pcsExecutor.hasMapping(event.positionNftMint)) {
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: 'PCS 無映射',
        });
        break;
      }

      const result = await pcsExecutor.copyDecreaseLiquidity(event.positionNftMint);
      const evtType = result?.type || 'DECREASE';
      push({
        ts: Date.now(),
        type: evtType,
        targetWallet: targetWallet.toBase58(),
        targetNft: event.positionNftMint,
        txSig: result?.txSig || undefined,
        success: !!result,
      });
      if (result) {
        logger.info(MODULE, `[${botLabel}][PCS ${evtType}] Our TX: ${result.txSig}`);
        byrealExecutor.invalidateAssetCaches();
      }
      break;
    }

    case 'PCS_CLOSE_POSITION': {
      if (!pcsExecutor) break;
      logger.info(MODULE, `[${botLabel}][PCS CLOSE] nft=${event.positionNftMint.slice(0, 8)}`);

      byrealExecutor.recordBotCloseReceived(event.receivedTokens);

      if (!pcsExecutor.hasMapping(event.positionNftMint)) {
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: 'PCS 無映射',
        });
        break;
      }

      const closePool = positionMap.getPool(event.positionNftMint);
      const ourSig = await pcsExecutor.copyClosePosition(event.positionNftMint);
      push({
        ts: Date.now(),
        type: 'CLOSE',
        targetWallet: targetWallet.toBase58(),
        targetNft: event.positionNftMint,
        txSig: ourSig || undefined,
        success: !!ourSig,
        pool: closePool,
      });
      if (ourSig) {
        logger.info(MODULE, `[${botLabel}][PCS CLOSE] Our TX: ${ourSig}`);
        refreshSolPrice().catch(() => {});
        byrealExecutor.invalidateAssetCaches();
      }
      break;
    }

    case 'PCS_COLLECT_FEES': {
      // Fees handled via our own collector, ignore
      logger.debug(MODULE, `[${botLabel}][PCS FEES] Ignored (our collector handles this)`);
      break;
    }

    // ===== Meteora DAMM v2 Events =====

    case 'DAMMV2_OPEN_POSITION': {
      if (!dammv2Executor) {
        logger.debug(MODULE, `[${botLabel}][DAMMV2 OPEN] DAMM v2 not enabled, ignoring`);
        break;
      }
      if (dammv2Executor.drawdownPaused || dammv2Executor.solPaused) {
        const reason = dammv2Executor.solPaused ? 'SOL 不足' : '資產跌幅暫停';
        logger.warn(MODULE, `[${botLabel}][DAMMV2 OPEN] Skipped (${reason})`);
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: `DAMMV2: ${reason}`,
        });
        break;
      }
      if (config.dammv2CloseOnlyWallets.has(targetWallet.toBase58())) {
        logger.info(MODULE, `[${botLabel}][DAMMV2 OPEN] Skipped (close-only target)`);
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: 'DAMMV2 close-only',
        });
        break;
      }

      logger.info(
        MODULE,
        `[${botLabel}][DAMMV2 OPEN] pool=${event.poolAddress.slice(0, 8)} nft=${event.positionNftMint.slice(0, 8)}`,
      );

      if (dammv2Executor.hasMapping(event.positionNftMint)) {
        logger.info(MODULE, `[${botLabel}][DAMMV2 OPEN] Already mapped, skipping`);
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: 'DAMMV2 重複目標',
        });
        break;
      }

      const ourSig = await dammv2Executor.copyOpenPosition(
        event.positionNftMint,
        event.poolAddress,
        targetWallet.toBase58(),
      );

      const skipReason = dammv2Executor.lastSkipReason;
      dammv2Executor.lastSkipReason = null;

      if (ourSig === null && skipReason) {
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: `DAMMV2: ${skipReason}`,
        });
        break;
      }

      push({
        ts: Date.now(),
        type: 'OPEN',
        targetWallet: targetWallet.toBase58(),
        targetNft: event.positionNftMint,
        txSig: ourSig || undefined,
        success: !!ourSig,
        pool: positionMap.getPool(event.positionNftMint),
      });
      if (ourSig) {
        logger.info(MODULE, `[${botLabel}][DAMMV2 OPEN] Our TX: ${ourSig}`);
        refreshSolPrice().catch(() => {});
        byrealExecutor.invalidateAssetCaches();
      }
      break;
    }

    case 'DAMMV2_ADD_LIQUIDITY': {
      if (!dammv2Executor) break;
      if (dammv2Executor.solPaused || dammv2Executor.drawdownPaused) {
        logger.warn(MODULE, `[${botLabel}][DAMMV2 ADD] Skipped (paused)`);
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: 'DAMMV2 paused',
        });
        break;
      }
      if (config.dammv2CloseOnlyWallets.has(targetWallet.toBase58())) {
        logger.info(MODULE, `[${botLabel}][DAMMV2 ADD] Skipped (close-only)`);
        break;
      }
      logger.info(MODULE, `[${botLabel}][DAMMV2 ADD] nft=${event.positionNftMint.slice(0, 8)}`);

      if (!dammv2Executor.hasMapping(event.positionNftMint)) {
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: 'DAMMV2 無映射',
        });
        break;
      }

      const ourSig = await dammv2Executor.copyAddLiquidity(
        event.positionNftMint,
        targetWallet.toBase58(),
      );
      push({
        ts: Date.now(),
        type: 'INCREASE',
        targetWallet: targetWallet.toBase58(),
        targetNft: event.positionNftMint,
        txSig: ourSig || undefined,
        success: !!ourSig,
      });
      if (ourSig) {
        logger.info(MODULE, `[${botLabel}][DAMMV2 ADD] Our TX: ${ourSig}`);
        byrealExecutor.invalidateAssetCaches();
      }
      break;
    }

    case 'DAMMV2_REMOVE_LIQUIDITY': {
      if (!dammv2Executor) break;
      logger.info(MODULE, `[${botLabel}][DAMMV2 REMOVE] nft=${event.positionNftMint.slice(0, 8)}`);

      if (!dammv2Executor.hasMapping(event.positionNftMint)) {
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: 'DAMMV2 無映射',
        });
        break;
      }

      const result = await dammv2Executor.copyRemoveLiquidity(event.positionNftMint);
      const evtType = result?.type || 'DECREASE';
      push({
        ts: Date.now(),
        type: evtType,
        targetWallet: targetWallet.toBase58(),
        targetNft: event.positionNftMint,
        txSig: result?.txSig || undefined,
        success: !!result,
      });
      if (result) {
        logger.info(MODULE, `[${botLabel}][DAMMV2 ${evtType}] Our TX: ${result.txSig}`);
        byrealExecutor.invalidateAssetCaches();
      }
      break;
    }

    case 'DAMMV2_CLOSE_POSITION': {
      if (!dammv2Executor) break;
      logger.info(MODULE, `[${botLabel}][DAMMV2 CLOSE] nft=${event.positionNftMint.slice(0, 8)}`);

      byrealExecutor.recordBotCloseReceived(event.receivedTokens);

      if (!dammv2Executor.hasMapping(event.positionNftMint)) {
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: 'DAMMV2 無映射',
        });
        break;
      }

      const closePool = positionMap.getPool(event.positionNftMint);
      const ourSig = await dammv2Executor.copyClosePosition(event.positionNftMint);
      push({
        ts: Date.now(),
        type: 'CLOSE',
        targetWallet: targetWallet.toBase58(),
        targetNft: event.positionNftMint,
        txSig: ourSig || undefined,
        success: !!ourSig,
        pool: closePool,
      });
      if (ourSig) {
        logger.info(MODULE, `[${botLabel}][DAMMV2 CLOSE] Our TX: ${ourSig}`);
        refreshSolPrice().catch(() => {});
        byrealExecutor.invalidateAssetCaches();
      }
      break;
    }

    case 'DAMMV2_CLAIM_FEE': {
      if (!dammv2Executor) break;
      logger.info(MODULE, `[${botLabel}][DAMMV2 CLAIM] nft=${event.positionNftMint.slice(0, 8)}`);

      if (!dammv2Executor.hasMapping(event.positionNftMint)) {
        push({
          ts: Date.now(),
          type: 'SKIP',
          targetWallet: targetWallet.toBase58(),
          targetNft: event.positionNftMint,
          success: true,
          error: 'DAMMV2 無映射',
        });
        break;
      }

      const ourSig = await dammv2Executor.copyClaimFee(event.positionNftMint);
      if (ourSig) {
        logger.info(MODULE, `[${botLabel}][DAMMV2 CLAIM] Our TX: ${ourSig}`);
        byrealExecutor.invalidateAssetCaches();
      }
      break;
    }

    case 'UNKNOWN': {
      logger.debug(MODULE, `[${botLabel}] Unknown event in TX: ${txSig}`);
      break;
    }
  }
}

main().catch((err) => {
  logger.error(MODULE, `Fatal error: ${err.message}`);
  releaseLock();
  process.exit(1);
});
