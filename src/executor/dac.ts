/**
 * DAC — Daily Auto-Convert
 * - Every day at dacExecuteHour:dacExecuteMinute (Asia/Taipei), check yesterday's profit
 * - If profit >= dacAmountUsd * dacThresholdMultiplier, swap USDC to the selected BTC token and transfer out
 * - History persisted to ./data/dac-history.json (max 365 records)
 */

import fs from 'fs';
import path from 'path';
import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from '@solana/spl-token';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getUserAddress, signLegacy } from '../utils/wallet';
import { jupSwapExactIn } from './jupiter-swap';
import { forceSnapshot, getAssetTrend } from '../dashboard/asset-trend';

const MODULE = 'DAC';
const DAC_HISTORY_FILE = path.resolve('./data/dac-history.json');
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DacRecord {
  ts: number;
  profitUsd: number;
  dacAmountUsd: number;
  cbbtcReceived: string;
  tokenReceived?: string;
  tokenSymbol?: string;
  tokenMint?: string;
  swapSig: string | null;
  transferSig: string | null;
  transferTo: string;
  status: 'success' | 'skipped' | 'swap_failed' | 'transfer_failed';
  reason?: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let schedulerTimer: ReturnType<typeof setTimeout> | null = null;
let dacHistory: DacRecord[] = [];
let nextScheduledTime = 0;
let dacRunning = false;

// ---------------------------------------------------------------------------
// History persistence
// ---------------------------------------------------------------------------

function loadDacHistory(): void {
  try {
    if (fs.existsSync(DAC_HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(DAC_HISTORY_FILE, 'utf-8'));
      if (Array.isArray(data)) dacHistory = data;
    }
  } catch {
    /* start fresh */
  }
}

function saveDacHistory(): void {
  try {
    const dir = path.dirname(DAC_HISTORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    while (dacHistory.length > 365) dacHistory.shift();
    fs.writeFileSync(DAC_HISTORY_FILE, JSON.stringify(dacHistory, null, 2));
  } catch (err: any) {
    logger.warn(MODULE, `Could not save DAC history: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Scheduling (setTimeout pattern — same as auto-claim.ts)
// ---------------------------------------------------------------------------

/**
 * Calculate ms until next dacExecuteHour:dacExecuteMinute in Asia/Taipei (UTC+8).
 */
function msUntilNextDac(): number {
  const now = new Date();

  // Target UTC hour = dacExecuteHour - 8 (Asia/Taipei = UTC+8)
  const targetUtcHour = (config.dacExecuteHour - 8 + 24) % 24;
  const targetUtcMinute = config.dacExecuteMinute || 0;

  const target = new Date(now);
  target.setUTCHours(targetUtcHour, targetUtcMinute, 0, 0);

  // If target is in the past or now, schedule for tomorrow
  if (target.getTime() <= now.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }

  return target.getTime() - now.getTime();
}

function scheduleNextDac(connection: Connection): void {
  if (!config.dacEnabled) return;

  const ms = msUntilNextDac();
  const hours = (ms / 3600000).toFixed(1);
  nextScheduledTime = Date.now() + ms;
  const targetDate = new Date(nextScheduledTime);
  logger.info(MODULE, `Next DAC: ${targetDate.toISOString()} (${hours} hours)`);

  schedulerTimer = setTimeout(async () => {
    try {
      await triggerDac(connection);
    } catch (err: any) {
      logger.error(MODULE, `DAC scheduler error: ${err.message}`);
    }
    scheduleNextDac(connection);
  }, ms);
}

// ---------------------------------------------------------------------------
// Profit calculation
// ---------------------------------------------------------------------------

async function calculateProfit(): Promise<number> {
  // Force a fresh snapshot and wait for it to settle
  const preRawLen = getAssetTrend().raw.length;
  forceSnapshot();
  await new Promise((resolve) => setTimeout(resolve, 15_000));

  const trendData = getAssetTrend();
  if (trendData.raw.length <= preRawLen) {
    logger.warn(
      MODULE,
      'forceSnapshot did not produce a new snapshot (may have been in progress), using latest available',
    );
  }

  // Find yesterday's daily snapshot — must be from a PREVIOUS calendar day (Asia/Taipei)
  // Daily snapshots have ts near UTC midnight (~07:56 Taipei), so on the same Taipei day
  // as DAC execution. We need the one from the previous Taipei calendar day.
  const now = Date.now();
  const taipeiOffsetMs = 8 * 60 * 60 * 1000; // UTC+8
  const todayTaipeiMidnight = new Date(now + taipeiOffsetMs);
  todayTaipeiMidnight.setUTCHours(0, 0, 0, 0);
  const todayMidnightUtc = todayTaipeiMidnight.getTime() - taipeiOffsetMs; // midnight Taipei in UTC ms

  let yesterday = null;
  for (let i = trendData.daily.length - 1; i >= 0; i--) {
    if (trendData.daily[i].ts < todayMidnightUtc) {
      yesterday = trendData.daily[i];
      break;
    }
  }

  if (!yesterday) {
    logger.warn(
      MODULE,
      `No daily snapshot before today (Taipei) found (daily entries: ${trendData.daily.length})`,
    );
    return 0;
  }

  // Current snapshot = latest raw entry
  if (trendData.raw.length === 0) {
    logger.warn(MODULE, 'No raw snapshots available for profit calculation');
    return 0;
  }

  const today = trendData.raw[trendData.raw.length - 1];

  // Exclude SOL: same formula as Dashboard "排除 SOL" = totalUsd - solBalanceUsd - lockedSolUsd
  const yesterdayExclSol =
    yesterday.totalUsd - (yesterday.solBalanceUsd || 0) - (yesterday.lockedSolUsd || 0);
  const todayExclSol = today.totalUsd - (today.solBalanceUsd || 0) - (today.lockedSolUsd || 0);
  const profit = todayExclSol - yesterdayExclSol;

  const yesterdayDate = new Date(yesterday.ts).toISOString().slice(0, 10);
  logger.info(
    MODULE,
    `Profit calc: baseline=${yesterdayDate} $${yesterdayExclSol.toFixed(2)} today=$${todayExclSol.toFixed(2)} profit=$${profit.toFixed(2)}`,
  );
  return profit;
}

// ---------------------------------------------------------------------------
// Discord notification (uses same pattern as notify.ts postNotification)
// ---------------------------------------------------------------------------

async function sendDacNotification(record: DacRecord): Promise<void> {
  const url = config.discordNotifyUrl;
  if (!url) return;

  const statusLabel: Record<string, string> = {
    success: '成功',
    skipped: '跳過',
    swap_failed: '兌換失敗',
    transfer_failed: '轉帳失敗',
  };

  const fields: { name: string; value: string }[] = [
    { name: '狀態', value: statusLabel[record.status] || record.status },
    { name: '昨日獲利', value: `$${record.profitUsd.toFixed(2)}` },
    { name: '購買金額', value: `$${record.dacAmountUsd}` },
  ];

  const tokenSymbol = record.tokenSymbol || 'cbBTC';
  const tokenReceived = record.tokenReceived || record.cbbtcReceived;

  if (tokenReceived) {
    fields.push({ name: `收到 ${tokenSymbol}`, value: tokenReceived });
  }
  if (record.swapSig) {
    fields.push({ name: '兌換交易', value: record.swapSig });
  }
  if (record.transferSig) {
    fields.push({ name: '轉帳交易', value: record.transferSig });
  }
  if (record.transferTo) {
    fields.push({ name: '轉帳地址', value: record.transferTo });
  }
  if (record.reason) {
    fields.push({ name: '原因', value: record.reason });
  }

  const d = new Date(record.ts);
  const utcStr = d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const twTime = d.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) + ' (UTC+8)';
  fields.push({ name: '時間', value: `${twTime}\n${utcStr}` });

  const pkg = require('../../package.json');

  const payload = {
    wallet: getUserAddress().toBase58(),
    apiKey: config.discordApiKey || '',
    type: 'dac',
    title: `DAC ${statusLabel[record.status] || record.status}`,
    description:
      record.status === 'success'
        ? `每日定投：$${record.dacAmountUsd} USDC → ${tokenReceived} ${tokenSymbol}`
        : record.reason || record.status,
    timestamp: new Date(record.ts).toISOString(),
    fields,
    version: pkg.version,
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      logger.warn(MODULE, `Discord notify ${res.status}: ${await res.text().catch(() => '')}`);
    }
  } catch (err: any) {
    logger.warn(MODULE, `Discord notify failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Core DAC execution
// ---------------------------------------------------------------------------

async function executeDacSwapAndTransfer(
  connection: Connection,
  record: DacRecord,
  dacAmountUsd: number,
  thresholdMultiplier: number,
  transferTo: string,
  targetMint: string,
  targetSymbol: string,
  skipProfitCheck: boolean,
): Promise<void> {
  // Step 1: Calculate profit
  const profit = await calculateProfit();
  record.profitUsd = +profit.toFixed(2);

  // Step 2: Check threshold
  const threshold = dacAmountUsd * thresholdMultiplier;
  if (!skipProfitCheck && profit < threshold) {
    record.reason = `profit $${profit.toFixed(2)} below threshold $${threshold.toFixed(2)}`;
    logger.info(MODULE, record.reason);
    return;
  }

  // Step 3: Record pre-swap target token balance (to transfer only the delta)
  const targetMintPubkey = new PublicKey(targetMint);
  const senderAta = getAssociatedTokenAddressSync(targetMintPubkey, getUserAddress());
  let preSwapBalance = 0n;
  try {
    const preBalInfo = await connection.getTokenAccountBalance(senderAta);
    preSwapBalance = BigInt(preBalInfo.value.amount);
  } catch {
    /* ATA may not exist yet — balance is 0 */
  }

  // Step 4: Swap USDC to selected BTC token
  const rawAmount = Math.floor(dacAmountUsd * 1e6); // USDC has 6 decimals
  logger.info(MODULE, `Swapping ${dacAmountUsd} USDC -> ${targetSymbol} (raw=${rawAmount})`);

  const swapSig = await jupSwapExactIn(connection, USDC_MINT, targetMint, rawAmount.toString());
  record.swapSig = swapSig;

  if (!swapSig) {
    record.status = 'swap_failed';
    record.reason = 'Jupiter swap returned null';
    logger.error(MODULE, 'Swap failed: no signature returned');
    return;
  }

  logger.info(MODULE, `Swap succeeded: ${swapSig}`);

  // Step 5: Transfer selected BTC token to target wallet
  if (transferTo) {
    try {
      const destPubkey = new PublicKey(transferTo);
      const destAta = getAssociatedTokenAddressSync(targetMintPubkey, destPubkey);

      // Wait a moment for the swap TX to be indexed
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Get post-swap balance, transfer only the delta from this swap
      const balInfo = await connection.getTokenAccountBalance(senderAta);
      const postSwapBalance = BigInt(balInfo.value.amount);
      const decimals = balInfo.value.decimals;
      const transferAmount = postSwapBalance - preSwapBalance;

      record.cbbtcReceived = (Number(transferAmount) / 10 ** decimals).toFixed(decimals);
      record.tokenReceived = record.cbbtcReceived;

      if (transferAmount <= 0n) {
        record.status = 'transfer_failed';
        record.reason = `${targetSymbol} delta is 0 after swap`;
        logger.error(MODULE, record.reason);
        return;
      }

      logger.info(MODULE, `Transferring ${record.tokenReceived} ${targetSymbol} to ${transferTo}`);

      const tx = new Transaction();
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          getUserAddress(),
          destAta,
          destPubkey,
          targetMintPubkey,
        ),
      );
      tx.add(
        createTransferCheckedInstruction(
          senderAta,
          targetMintPubkey,
          destAta,
          getUserAddress(),
          transferAmount,
          decimals,
        ),
      );

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = getUserAddress();
      const signedTx = await signLegacy(tx);

      const sig = await connection.sendRawTransaction(signedTx.serialize());
      await connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        'confirmed',
      );

      record.transferSig = sig;
      record.status = 'success';
      logger.info(MODULE, `Transfer succeeded: ${sig}`);
    } catch (err: any) {
      record.status = 'transfer_failed';
      record.reason = `Transfer failed: ${err.message}`;
      logger.error(MODULE, record.reason);
    }
  } else {
    // No transfer target — just the swap is enough
    record.status = 'success';

    // Still try to read target token balance for the record
    try {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const balInfo = await connection.getTokenAccountBalance(senderAta);
      const postBalance = BigInt(balInfo.value.amount);
      const delta = postBalance - preSwapBalance;
      const decimals = balInfo.value.decimals;
      record.cbbtcReceived = (Number(delta) / 10 ** decimals).toFixed(decimals);
      record.tokenReceived = record.cbbtcReceived;
    } catch {
      /* non-critical */
    }
  }
}

export async function triggerDac(
  connection: Connection,
  skipProfitCheck = false,
): Promise<DacRecord> {
  // Concurrency guard — prevent double-swap if scheduler + manual trigger overlap
  if (dacRunning) {
    logger.warn(MODULE, 'DAC already running, skipping');
    return {
      ts: Date.now(),
      profitUsd: 0,
      dacAmountUsd: config.dacAmountUsd || 0,
      cbbtcReceived: '',
      tokenReceived: '',
      tokenSymbol: config.dacTargetSymbol,
      tokenMint: config.dacTargetMint,
      swapSig: null,
      transferSig: null,
      transferTo: config.dacTransferTo || '',
      status: 'skipped',
      reason: 'Another DAC run already in progress',
    };
  }
  dacRunning = true;

  // Same-day guard: skip if DAC already succeeded today (Asia/Taipei)
  if (!skipProfitCheck) {
    const taipeiOffset = 8 * 60 * 60 * 1000;
    const todayTaipei = new Date(Date.now() + taipeiOffset);
    todayTaipei.setUTCHours(0, 0, 0, 0);
    const todayStartUtc = todayTaipei.getTime() - taipeiOffset;
    const alreadyRanToday = dacHistory.some((r) => r.status === 'success' && r.ts >= todayStartUtc);
    if (alreadyRanToday) {
      dacRunning = false;
      logger.info(MODULE, 'DAC already succeeded today (Taipei), skipping');
      return {
        ts: Date.now(),
        profitUsd: 0,
        dacAmountUsd: config.dacAmountUsd || 0,
        cbbtcReceived: '',
        tokenReceived: '',
        tokenSymbol: config.dacTargetSymbol,
        tokenMint: config.dacTargetMint,
        swapSig: null,
        transferSig: null,
        transferTo: config.dacTransferTo || '',
        status: 'skipped',
        reason: 'Already ran successfully today',
      };
    }
  }

  logger.info(MODULE, `=== DAC triggered (skipProfitCheck=${skipProfitCheck}) ===`);

  const dacAmountUsd = config.dacAmountUsd || 0;
  const thresholdMultiplier = config.dacThresholdMultiplier || 1;
  const transferTo = config.dacTransferTo || '';
  const targetMint = config.dacTargetMint || '';
  const targetSymbol = config.dacTargetSymbol || 'BTC';

  const record: DacRecord = {
    ts: Date.now(),
    profitUsd: 0,
    dacAmountUsd,
    cbbtcReceived: '',
    tokenReceived: '',
    tokenSymbol: targetSymbol,
    tokenMint: targetMint,
    swapSig: null,
    transferSig: null,
    transferTo,
    status: 'skipped',
  };

  try {
    // Guard: dacAmountUsd must be positive
    if (dacAmountUsd <= 0) {
      record.reason = 'dacAmountUsd is 0 or negative, skipping';
      logger.warn(MODULE, record.reason);
    } else {
      await executeDacSwapAndTransfer(
        connection,
        record,
        dacAmountUsd,
        thresholdMultiplier,
        transferTo,
        targetMint,
        targetSymbol,
        skipProfitCheck,
      );
    }
  } catch (err: any) {
    record.status = 'swap_failed';
    record.reason = `Unexpected error: ${err.message}`;
    logger.error(MODULE, record.reason);
  } finally {
    dacRunning = false;
  }

  // Save and notify
  dacHistory.push(record);
  saveDacHistory();
  await sendDacNotification(record);

  logger.info(MODULE, `=== DAC complete: ${record.status} ===`);
  return record;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function startDacScheduler(connection: Connection): void {
  loadDacHistory();
  if (!config.dacEnabled) {
    logger.info(MODULE, 'DAC disabled (DAC_ENABLED != true)');
    return;
  }
  logger.info(
    MODULE,
    `DAC scheduler started (daily at ${config.dacExecuteHour}:${String(config.dacExecuteMinute || 0).padStart(2, '0')} Asia/Taipei)`,
  );
  if (dacHistory.length > 0) {
    const last = dacHistory[dacHistory.length - 1];
    logger.info(MODULE, `Last DAC: ${new Date(last.ts).toISOString()} status=${last.status}`);
  }
  scheduleNextDac(connection);
}

export function stopDacScheduler(): void {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
}

export function getDacHistory(): DacRecord[] {
  return dacHistory;
}

export function getDacNextScheduledTime(): number {
  return nextScheduledTime;
}
