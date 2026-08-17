/**
 * Auto-Claim Copy Bonus (type=2)
 * - 每週二 16:30 台灣時間 setTimeout 觸發
 * - 流程跟 byreal-cli 一致：encode-v2 → sign all → order-v2 → done
 * - 歷史記錄持久化至 ./data/claim-history.json
 */

import fs from 'fs';
import path from 'path';
import { Connection, VersionedTransaction } from '@solana/web3.js';
import { config } from '../config';
import { logger } from '../utils/logger';
import { getUserAddress, signVersioned } from '../utils/wallet';

const MODULE = 'AutoClaim';
const BYREAL_API = 'https://api2.byreal.io/byreal/api/dex/v2';
const CLAIM_HISTORY_FILE = path.resolve('./data/claim-history.json');

interface ClaimHistoryEntry {
  ts: number;
  snapshotTs?: number;
  week: string;
  totalPools: number;
  totalBonusUsd: number;
  txSignatures: string[];
  error?: string;
}

let schedulerTimer: ReturnType<typeof setTimeout> | null = null;
let lastClaimWeek = '';
let claimHistory: ClaimHistoryEntry[] = [];

function formatClaimResult(entry: { ts: number; snapshotTs?: number; totalPools: number; totalBonusUsd?: number; error?: string }): string {
  if (entry.error && entry.totalPools === 0) return `失敗: ${entry.error}`;

  const d = new Date(entry.snapshotTs || entry.ts);
  const twHour = String((d.getUTCHours() + 8) % 24).padStart(2, '0');
  const twMin = String(d.getUTCMinutes()).padStart(2, '0');
  const snap = `快照 ${twHour}:${twMin}`;
  const usd = entry.totalBonusUsd ?? 0;

  return `領取成功，${usd.toFixed(2)} USD（${snap}）`;
}

// Expose for dashboard
export let lastClaimTs = 0;
export let lastClaimResult = '';

function getISOWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function loadClaimHistory(): void {
  try {
    if (fs.existsSync(CLAIM_HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(CLAIM_HISTORY_FILE, 'utf-8'));
      if (Array.isArray(data)) {
        claimHistory = data;
        for (let i = data.length - 1; i >= 0; i--) {
          if (!data[i].error) {
            lastClaimWeek = data[i].week;
            lastClaimTs = data[i].ts;
            lastClaimResult = formatClaimResult(data[i]);
            break;
          }
        }
      }
    }
  } catch { /* start fresh */ }
}

function saveClaimHistory(): void {
  try {
    const dir = path.dirname(CLAIM_HISTORY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    while (claimHistory.length > 52) claimHistory.shift();
    fs.writeFileSync(CLAIM_HISTORY_FILE, JSON.stringify(claimHistory, null, 2));
  } catch (err: any) {
    logger.warn(MODULE, `Could not save claim history: ${err.message}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

type ByrealHttpMethod = 'GET' | 'POST';

async function parseByrealJsonResponse(method: ByrealHttpMethod, apiPath: string, res: Response): Promise<any> {
  const text = await res.text();
  const preview = text.slice(0, 160);
  if (!res.ok) {
    throw new Error(`${method} ${apiPath} ${res.status} ${res.statusText}: ${preview}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${method} ${apiPath} returned non-JSON: ${preview}`);
  }
}

export const parseByrealJsonResponseForTest = parseByrealJsonResponse;

async function apiPost(apiPath: string, body: any): Promise<any> {
  const res = await fetch(`${BYREAL_API}/${apiPath}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Referer': 'https://www.byreal.io/',
    },
    body: JSON.stringify(body),
  });
  return parseByrealJsonResponse('POST', apiPath, res);
}

async function apiGet(apiPath: string): Promise<any> {
  const res = await fetch(`${BYREAL_API}/${apiPath}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Referer': 'https://www.byreal.io/',
    },
  });
  return parseByrealJsonResponse('GET', apiPath, res);
}

type CopyBonusDeps = {
  apiGet: (apiPath: string) => Promise<any>;
  apiPost: (apiPath: string, body: any) => Promise<any>;
  getWalletAddress: () => string;
  signRewardPayload: (txPayload: string) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
};

function isCopyBonusTransientError(err: any): boolean {
  const message = String(err?.message || err || '');
  return /\b(429|502|503|504)\b|Gateway Time-out|timeout|timed out|ECONNRESET|ETIMEDOUT/i.test(message);
}

async function copyBonusPostWithRetry(deps: CopyBonusDeps, apiPath: string, body: any, context: string): Promise<any> {
  const delays = [5000, 10000];
  let lastErr: any;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await deps.apiPost(apiPath, body);
    } catch (err: any) {
      lastErr = err;
      if (attempt >= 3 || !isCopyBonusTransientError(err)) throw err;
      const delay = delays[attempt - 1];
      logger.warn(MODULE, `${context} transient failure attempt ${attempt}/3, retrying in ${delay}ms: ${err.message || err}`);
      await deps.sleep(delay);
    }
  }
  throw lastErr;
}

const COPY_BONUS_ROUND_DELAY_MS = 5000;

/**
 * 領取 type=2 複製獎勵 — 跟 byreal-cli 一致的流程：
 * 重複 encode-v2 → sign → order-v2 直到沒有東西可領
 */
export async function claimCopyBonusWithDepsForTest(deps: CopyBonusDeps, nowMs = Date.now()): Promise<ClaimHistoryEntry> {
  const walletAddress = deps.getWalletAddress();
  const currentWeek = getISOWeek(new Date(nowMs));

  logger.info(MODULE, `=== ????銴ˊ? (type=2) ===`);
  logger.info(MODULE, `Wallet: ${walletAddress}, Week: ${currentWeek}`);

  const entry: ClaimHistoryEntry = {
    ts: nowMs,
    snapshotTs: nowMs,
    week: currentWeek,
    totalPools: 0,
    totalBonusUsd: 0,
    txSignatures: [],
  };

  const seenOrderCodes = new Set<string>();
  const seenRewardKeys = new Set<string>();

  const stopOrError = (message: string): boolean => {
    if (entry.totalPools > 0) {
      logger.info(MODULE, message);
      return true;
    }
    entry.error = message;
    return true;
  };

  for (let round = 1; ; round++) {
    let epochRes: any;
    try {
      epochRes = await deps.apiGet(`copyfarmer/epoch-bonus?walletAddress=${encodeURIComponent(walletAddress)}&type=-1`);
    } catch (err: any) {
      if (entry.totalPools > 0) {
        logger.warn(MODULE, `epoch-bonus unavailable after successful round: ${err.message || err}`);
        break;
      }
      entry.error = `epoch-bonus unavailable: ${err.message || err}`;
      logger.warn(MODULE, entry.error);
      return entry;
    }

    const epochs = getResponseData(epochRes) || {};
    const claimableEpoch = epochs['3'];
    if (!claimableEpoch) {
      stopOrError('no rewards available');
      break;
    }

    const totalBonusUsd = Number(claimableEpoch.totalBonusUsd);
    const claimTime = Number(claimableEpoch.claimTime);
    const endTime = Number(claimableEpoch.endTime);
    if (!Number.isFinite(totalBonusUsd) || !Number.isFinite(claimTime) || !Number.isFinite(endTime)) {
      stopOrError('malformed epoch bonus data');
      break;
    }

    logger.info(MODULE, `Pre-claim snapshot: ${totalBonusUsd.toFixed(2)} USD`);

    if (totalBonusUsd <= 0) {
      stopOrError('no rewards available');
      break;
    }
    if (nowMs < claimTime) {
      stopOrError(`bonus not claimable until ${new Date(claimTime).toISOString()}`);
      break;
    }
    if (nowMs >= endTime) {
      stopOrError('bonus claim window ended');
      break;
    }

    try {
      logger.info(MODULE, `[Round ${round}] Calling encode-v2...`);
      const encodeRes = await copyBonusPostWithRetry(deps, 'incentive/encode-v2', {
        walletAddress,
        positionAddresses: [],
        type: 2,
      }, 'copy-bonus encode-v2');

      const encoded = getResponseData(encodeRes) || {};
      const items = encoded.rewardEncodeItems || [];
      const orderCode = encoded.orderCode;
      logger.info(MODULE, `[Round ${round}] encode-v2: ${items.length} pools, orderCode=${orderCode}`);

      if (items.length === 0) {
        stopOrError('no rewards available');
        break;
      }

      const duplicateOrder = orderCode && seenOrderCodes.has(orderCode);
      const duplicateReward = items.some((item: any) => {
        const key = item.txCode || item.poolAddress;
        return key && seenRewardKeys.has(key);
      });
      if (duplicateOrder || duplicateReward) {
        logger.warn(MODULE, `[Round ${round}] duplicate copy bonus batch detected, stopping before order-v2`);
        break;
      }

      logger.info(MODULE, `[Round ${round}] Signing ${items.length} pools...`);
      const signedTxPayload: { txCode: string; poolAddress: string; signedTx: string }[] = [];
      for (const item of items) {
        try {
          signedTxPayload.push({
            txCode: item.txCode,
            poolAddress: item.poolAddress,
            signedTx: await deps.signRewardPayload(item.txPayload),
          });
        } catch (err: any) {
          logger.error(MODULE, `Sign failed for ${item.poolAddress}: ${err.message || err}`);
        }
      }

      if (signedTxPayload.length === 0) {
        entry.error = 'all signatures failed';
        return entry;
      }

      const orderBody = { orderCode, walletAddress, signedTxPayload };
      logger.info(MODULE, `[Round ${round}] Calling order-v2 (orderCode=${orderCode})...`);
      const orderRes = await copyBonusPostWithRetry(deps, 'incentive/order-v2', orderBody, 'copy-bonus order-v2');

      const orderData = getResponseData(orderRes) || {};
      const txList = Array.isArray(orderData.txList) ? orderData.txList : [];
      const claimTokenList = Array.isArray(orderData.claimTokenList) ? orderData.claimTokenList : [];

      for (const tx of txList) {
        if (tx.txSignature) entry.txSignatures.push(tx.txSignature);
        logger.info(MODULE, `  ${tx.poolAddress} ??${tx.txSignature} (${tx.status})`);
      }
      for (const t of claimTokenList) {
        logger.info(MODULE, `  Claimed: ${t.tokenSymbol} ${t.tokenAmount}`);
      }

      entry.totalBonusUsd += totalBonusUsd;
      entry.totalPools += items.length;
      if (orderCode) seenOrderCodes.add(orderCode);
      for (const item of items) {
        const key = item.txCode || item.poolAddress;
        if (key) seenRewardKeys.add(key);
      }

      logger.info(MODULE, `[Round ${round}] order-v2 done: txList=${txList.length}, claimTokenList=${claimTokenList.length}`);
      await deps.sleep(COPY_BONUS_ROUND_DELAY_MS);
    } catch (err: any) {
      entry.error = err.message || String(err);
      logger.error(MODULE, `??憭望?: ${entry.error}`);
      return entry;
    }
  }

  return entry;
}

export async function claimCopyBonus(): Promise<ClaimHistoryEntry> {
  const entry = await claimCopyBonusWithDepsForTest({
    apiGet,
    apiPost,
    getWalletAddress: () => getUserAddress().toBase58(),
    signRewardPayload,
    sleep,
  });
  finalize(entry, entry.week);
  return entry;
}

async function legacyClaimCopyBonusDisabled(): Promise<ClaimHistoryEntry> {
  const walletAddress = getUserAddress().toBase58();
  const currentWeek = getISOWeek(new Date());

  logger.info(MODULE, `=== 開始領取複製獎勵 (type=2) ===`);
  logger.info(MODULE, `Wallet: ${walletAddress}, Week: ${currentWeek}`);

  // Snapshot bonus before claiming
  let totalBonusUsd = 0;
  const snapshotTs = Date.now();
  try {
    const epochRes = await apiGet(`copyfarmer/epoch-bonus?walletAddress=${walletAddress}&type=2`);
    totalBonusUsd = parseFloat(epochRes?.result?.data?.['2']?.totalBonusUsd || '0');
    logger.info(MODULE, `Pre-claim snapshot: ${totalBonusUsd.toFixed(2)} USD`);
  } catch (err: any) {
    logger.warn(MODULE, `epoch-bonus query failed: ${err.message}`);
  }

  const entry: ClaimHistoryEntry = {
    ts: Date.now(),
    snapshotTs,
    week: currentWeek,
    totalPools: 0,
    totalBonusUsd,
    txSignatures: [],
  };

  try {
    for (let round = 1; ; round++) {
      // ── encode-v2 ──
      logger.info(MODULE, `[Round ${round}] Calling encode-v2...`);
      const encodeRes = await apiPost('incentive/encode-v2', {
        walletAddress,
        positionAddresses: [],
        type: 2,
      });

      const items = encodeRes?.result?.data?.rewardEncodeItems || [];
      const orderCode = encodeRes?.result?.data?.orderCode;
      logger.info(MODULE, `[Round ${round}] encode-v2: ${items.length} pools, orderCode=${orderCode}`);

      if (items.length === 0) {
        if (round === 1) {
          logger.info(MODULE, `沒有可領取的獎勵`);
          entry.error = 'no rewards available';
        } else {
          logger.info(MODULE, `全部領完 (${round - 1} rounds)`);
        }
        break;
      }

      entry.totalPools += items.length;

      // ── sign all ──
      logger.info(MODULE, `[Round ${round}] Signing ${items.length} pools...`);
      const signedPayloads: { txCode: string; poolAddress: string; signedTx: string }[] = [];
      for (const item of items) {
        try {
          const tx = VersionedTransaction.deserialize(Buffer.from(item.txPayload, 'base64'));
          const signedTx = await signVersioned(tx);
          signedPayloads.push({
            txCode: item.txCode,
            poolAddress: item.poolAddress,
            signedTx: Buffer.from(signedTx.serialize()).toString('base64'),
          });
        } catch (err: any) {
          logger.error(MODULE, `Sign failed for ${item.poolAddress}: ${err.message}`);
        }
      }

      if (signedPayloads.length === 0) {
        entry.error = 'all signatures failed';
        break;
      }

      logger.info(MODULE, `[Round ${round}] Signed ${signedPayloads.length}/${items.length} pools`);

      // ── order-v2 ──
      logger.info(MODULE, `[Round ${round}] Calling order-v2 (orderCode=${orderCode})...`);
      const orderRes = await apiPost('incentive/order-v2', {
        orderCode,
        walletAddress,
        signedTxPayload: signedPayloads,
      });

      const data = orderRes?.result?.data;
      const txList = data?.txList || [];
      const claimTokenList = data?.claimTokenList || [];

      for (const tx of txList) {
        if (tx.txSignature) entry.txSignatures.push(tx.txSignature);
        logger.info(MODULE, `  ${tx.poolAddress} → ${tx.txSignature} (${tx.status})`);
      }
      for (const t of claimTokenList) {
        logger.info(MODULE, `  Claimed: ${t.tokenSymbol} ${t.tokenAmount}`);
      }

      logger.info(MODULE, `[Round ${round}] order-v2 done: txList=${txList.length}, claimTokenList=${claimTokenList.length}`);

      // Wait before next round to let server process
      await sleep(5000);
    }
  } catch (err: any) {
    logger.error(MODULE, `領取失敗: ${err.message}`);
    entry.error = err.message;
  }

  finalize(entry, currentWeek);
  return entry;
}

export interface LpFeeClaimResult {
  encodeV3Rounds?: number;
  encodeFeeRounds?: number;
  rewardRounds?: number;
  feeRounds?: number;
  totalItems: number;
  txSignatures: string[];
  failures: Array<{
    phase:
      | 'encode-v3'
      | 'encode-fee'
      | 'reward-query'
      | 'reward-encode'
      | 'reward-sign'
      | 'reward-order'
      | 'fee-list'
      | 'fee-encode'
      | 'fee-sign'
      | 'fee-send'
      | 'fee-confirm'
      | 'fatal';
    ref: string;
    error: string;
  }>;
  claimedTokens: Array<{ symbol: string; amount: number; decimals: number }>;
}

/**
 * Claim all unclaimed LP fees + offchain rewards via Byreal's backend API.
 * Mirrors the webpage's "領取全部" flow:
 *   Phase 1: encode-v3 (type=1, 2-sig offchain-reward TXs) → sign → order-v3
 *            (Byreal backend co-signs with authority key and broadcasts)
 *   Phase 2: encode-fee (1-sig per-position fee TXs) → sign → legacy backend send
 *            (Byreal backend broadcasts; 1 sig is enough)
 * Returns on-chain sigs reported by Byreal after broadcast.
 */
async function legacyClaimLpFeesOffchainDisabled(_connection: Connection): Promise<LpFeeClaimResult> {
  const walletAddress = getUserAddress().toBase58();
  logger.info(MODULE, `=== 開始領取全部手續費 (offchain) wallet=${walletAddress.slice(0, 8)} ===`);

  const result: LpFeeClaimResult = {
    encodeV3Rounds: 0,
    encodeFeeRounds: 0,
    totalItems: 0,
    txSignatures: [],
    failures: [],
    claimedTokens: [],
  };
  const tokenTotals = new Map<string, { amount: number; decimals: number }>();
  const bumpTokens = (tokens: Array<{ tokenSymbol: string; tokenAmount: number; tokenDecimals: number }>) => {
    for (const t of tokens) {
      const existing = tokenTotals.get(t.tokenSymbol) || { amount: 0, decimals: t.tokenDecimals };
      existing.amount += t.tokenAmount;
      tokenTotals.set(t.tokenSymbol, existing);
    }
  };

  const signOne = async (txPayloadB64: string): Promise<string | null> => {
    try {
      const tx = VersionedTransaction.deserialize(Buffer.from(txPayloadB64, 'base64'));
      const signed = await signVersioned(tx);
      return Buffer.from(signed.serialize()).toString('base64');
    } catch (err: any) {
      return null;
    }
  };

  try {
    // ── Phase 1: encode-v3 → order-v3 (offchain LP rewards) ──
    for (let round = 1; round <= 100; round++) {
      logger.info(MODULE, `[encode-v3] round ${round}: querying...`);
      const encRes = await apiPost('incentive/' + 'encode-v3', {
        positionAddresses: [],
        walletAddress,
        type: 1,
      });
      const items = encRes?.result?.data?.rewardEncodeItems || [];
      const orderCode = encRes?.result?.data?.orderCode;
      logger.info(MODULE, `[encode-v3] round ${round}: ${items.length} items, orderCode=${orderCode}`);
      if (items.length === 0) break;
      result.encodeV3Rounds = round;

      const signedTxPayload: Array<{ poolAddress: string; signedTx: string; txCode: string }> = [];
      for (const item of items) {
        const signedTx = await signOne(item.txPayload);
        if (!signedTx) {
          result.failures.push({ phase: 'encode-v3', ref: item.txCode || item.poolAddress, error: 'sign failed' });
          logger.error(MODULE, `[encode-v3] sign failed for ${(item.txCode || '').slice(0, 8)}`);
          continue;
        }
        signedTxPayload.push({ poolAddress: item.poolAddress, signedTx, txCode: item.txCode });
        bumpTokens(item.rewardClaimInfo || []);
      }
      if (signedTxPayload.length === 0) { await sleep(3000); continue; }

      try {
        const orderRes = await apiPost('incentive/' + 'order-v3', {
          orderCode,
          walletAddress,
          signedTxPayload,
        });
        const data = orderRes?.result?.data;
        const txList = data?.txList || data || [];
        const sigs: string[] = [];
        if (Array.isArray(txList)) {
          for (const entry of txList) {
            const sig = typeof entry === 'string' ? entry : entry?.txSignature;
            if (sig) sigs.push(sig);
          }
        }
        result.txSignatures.push(...sigs);
        result.totalItems += sigs.length;
        logger.info(MODULE, `[order-v3] round ${round}: ${sigs.length} txs submitted`);
      } catch (err: any) {
        logger.error(MODULE, `[order-v3] round ${round} failed: ${err.message || err}`);
        result.failures.push({ phase: 'encode-v3', ref: `order-v3-round-${round}`, error: err.message || String(err) });
      }
      await sleep(5000);
    }

    // ── Phase 2: encode-fee → legacy backend send (per-position accrued fees) ──
    for (let round = 1; round <= 100; round++) {
      logger.info(MODULE, `[encode-fee] round ${round}: querying...`);
      const encRes = await apiPost('incentive/encode-fee', {
        walletAddress,
        positionAddresses: [],
      });
      const items = encRes?.result?.data || [];
      logger.info(MODULE, `[encode-fee] round ${round}: ${items.length} items`);
      if (items.length === 0) break;
      result.encodeFeeRounds = round;

      const signedBatch: string[] = [];
      const refOrder: string[] = [];
      for (const item of items) {
        const signedTx = await signOne(item.txPayload);
        if (!signedTx) {
          result.failures.push({ phase: 'encode-fee', ref: item.positionAddress, error: 'sign failed' });
          logger.error(MODULE, `[encode-fee] sign failed for ${item.positionAddress.slice(0, 8)}`);
          continue;
        }
        signedBatch.push(signedTx);
        refOrder.push(item.positionAddress);
        bumpTokens(item.tokens || []);
      }
      if (signedBatch.length === 0) { await sleep(3000); continue; }

      try {
        const sendRes = await apiPost('liquidity/' + 'send', { data: signedBatch });
        const sigs: string[] = (sendRes?.result?.data || []).filter((s: any) => typeof s === 'string');
        result.txSignatures.push(...sigs);
        result.totalItems += sigs.length;
        logger.info(MODULE, `[legacy backend send disabled] round ${round}: ${sigs.length}/${signedBatch.length} sigs returned`);
      } catch (err: any) {
        logger.error(MODULE, `[legacy backend send disabled] round ${round} failed: ${err.message || err}`);
        result.failures.push({ phase: 'encode-fee', ref: `send-round-${round}`, error: err.message || String(err) });
      }
      await sleep(5000);
    }
  } catch (err: any) {
    logger.error(MODULE, `claimLpFeesOffchain fatal: ${err.message || err}`);
    result.failures.push({ phase: 'encode-v3', ref: 'FATAL', error: err.message || String(err) });
  }

  for (const [symbol, { amount, decimals }] of tokenTotals) {
    result.claimedTokens.push({ symbol, amount, decimals });
  }
  logger.info(
    MODULE,
    `=== 領取完畢: ${result.totalItems} txs, ${result.failures.length} failures, ${result.claimedTokens.length} token types ===`,
  );
  return result;
}

type ClaimTokenLike = {
  tokenSymbol?: string;
  symbol?: string;
  tokenAmount?: string | number;
  amount?: string | number;
  tokenDecimals?: number;
  decimals?: number;
};

type FeeClaimEntry = {
  positionAddress: string;
  txPayload: string;
  tokens?: ClaimTokenLike[];
};

type ClaimDeps = {
  apiGet: (apiPath: string) => Promise<any>;
  apiPost: (apiPath: string, body: any) => Promise<any>;
  getWalletAddress: () => string;
  signRewardPayload: (txPayload: string) => Promise<string>;
  sendFeePayload: (connection: Connection, entry: FeeClaimEntry) => Promise<string>;
};

function createLpFeeClaimResult(): LpFeeClaimResult {
  return { rewardRounds: 0, feeRounds: 0, totalItems: 0, txSignatures: [], failures: [], claimedTokens: [] };
}

function getResponseData(res: any): any {
  return res?.result?.data ?? res?.data ?? res;
}

function extractSignature(entry: any): string | null {
  if (typeof entry === 'string') return entry;
  return entry?.txSignature || entry?.signature || null;
}

function addUniqueSignature(result: LpFeeClaimResult, seen: Set<string>, sig: string | null): void {
  if (!sig || seen.has(sig)) return;
  seen.add(sig);
  result.txSignatures.push(sig);
  result.totalItems = result.txSignatures.length;
}

function addTokenTotals(totals: Map<string, { amount: number; decimals: number }>, tokens: ClaimTokenLike[] = []): void {
  for (const token of tokens) {
    const symbol = token.tokenSymbol || token.symbol;
    if (!symbol) continue;
    const amount = Number(token.tokenAmount ?? token.amount ?? 0);
    const decimals = Number(token.tokenDecimals ?? token.decimals ?? 0);
    if (!Number.isFinite(amount)) continue;
    const existing = totals.get(symbol) || { amount: 0, decimals };
    existing.amount += amount;
    existing.decimals = decimals;
    totals.set(symbol, existing);
  }
}

function hasPositiveUnclaimedReward(item: any): boolean {
  const synced = Number(item?.syncedTokenAmount || 0);
  const locked = Number(item?.lockedTokenAmount || 0);
  const claimed = Number(item?.claimedTokenAmount || 0);
  return synced - locked - claimed > 0;
}

async function listActivePositionAddresses(walletAddress: string, deps: ClaimDeps): Promise<string[]> {
  const positions: string[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= 100; page++) {
    const res = await deps.apiGet(`position/list?userAddress=${encodeURIComponent(walletAddress)}&page=${page}&pageSize=100&status=0`);
    const data = getResponseData(res) || {};
    const rows = Array.isArray(data.positions) ? data.positions : (Array.isArray(data.records) ? data.records : []);
    if (rows.length === 0) break;
    for (const row of rows) {
      const positionAddress = row?.positionAddress;
      if (positionAddress && !seen.has(positionAddress)) {
        seen.add(positionAddress);
        positions.push(positionAddress);
      }
    }
    const total = Number(data.total || 0);
    if (total > 0 && positions.length >= total) break;
  }
  return positions;
}

export async function claimLpFeesCliParityForTest(connection: Connection, deps: ClaimDeps): Promise<LpFeeClaimResult> {
  const walletAddress = deps.getWalletAddress();
  const result = createLpFeeClaimResult();
  const tokenTotals = new Map<string, { amount: number; decimals: number }>();
  const seenSignatures = new Set<string>();
  const processedRewardPositions = new Set<string>();

  try {
    for (let round = 1; round <= 100; round++) {
      let unclaimedRes: any;
      try {
        unclaimedRes = await deps.apiGet(`position/unclaimed-data?userAddress=${encodeURIComponent(walletAddress)}`);
      } catch (err: any) {
        result.failures.push({ phase: 'reward-query', ref: `round-${round}`, error: err.message || String(err) });
        break;
      }
      const data = getResponseData(unclaimedRes) || {};
      const rewards = [
        ...(Array.isArray(data.unclaimedOpenIncentives) ? data.unclaimedOpenIncentives : []),
        ...(Array.isArray(data.unclaimedClosedIncentives) ? data.unclaimedClosedIncentives : []),
      ];
      const positionAddresses = [...new Set(rewards
        .filter(hasPositiveUnclaimedReward)
        .map((item: any) => item.positionAddress)
        .filter((addr: string) => addr && !processedRewardPositions.has(addr)))];
      if (positionAddresses.length === 0) break;

      let encodeRes: any;
      try {
        encodeRes = await deps.apiPost('incentive/encode-v2', { walletAddress, positionAddresses, type: 1 });
      } catch (err: any) {
        result.failures.push({ phase: 'reward-encode', ref: `round-${round}`, error: err.message || String(err) });
        break;
      }
      const encoded = getResponseData(encodeRes) || {};
      const items = encoded.rewardEncodeItems || [];
      const orderCode = encoded.orderCode;
      if (items.length === 0) break;
      result.rewardRounds = round;

      const signedTxPayload: Array<{ poolAddress: string; signedTx: string; txCode: string }> = [];
      for (const item of items) {
        try {
          signedTxPayload.push({
            poolAddress: item.poolAddress,
            txCode: item.txCode,
            signedTx: await deps.signRewardPayload(item.txPayload),
          });
        } catch (err: any) {
          result.failures.push({ phase: 'reward-sign', ref: item.txCode || item.poolAddress || `round-${round}`, error: err.message || String(err) });
        }
      }
      if (signedTxPayload.length === 0) break;

      try {
        const orderRes = await deps.apiPost('incentive/order-v2', { orderCode, walletAddress, signedTxPayload });
        const orderData = getResponseData(orderRes) || {};
        for (const tx of (Array.isArray(orderData.txList) ? orderData.txList : [])) {
          addUniqueSignature(result, seenSignatures, extractSignature(tx));
        }
        const claimTokenList = Array.isArray(orderData.claimTokenList) ? orderData.claimTokenList : [];
        if (claimTokenList.length > 0) {
          addTokenTotals(tokenTotals, claimTokenList);
        } else {
          for (const item of items) addTokenTotals(tokenTotals, item.rewardClaimInfo || []);
        }
        for (const address of positionAddresses) processedRewardPositions.add(address);
      } catch (err: any) {
        result.failures.push({ phase: 'reward-order', ref: orderCode || `round-${round}`, error: err.message || String(err) });
        break;
      }
    }

    let positionAddresses: string[] = [];
    try {
      positionAddresses = await listActivePositionAddresses(walletAddress, deps);
    } catch (err: any) {
      result.failures.push({ phase: 'fee-list', ref: walletAddress, error: err.message || String(err) });
    }

    if (positionAddresses.length > 0) {
      let feeEntries: FeeClaimEntry[] = [];
      try {
        const feeRes = await deps.apiPost('incentive/encode-fee', { walletAddress, positionAddresses });
        feeEntries = getResponseData(feeRes) || [];
      } catch (err: any) {
        result.failures.push({ phase: 'fee-encode', ref: walletAddress, error: err.message || String(err) });
      }
      if (feeEntries.length > 0) result.feeRounds = 1;
      const sentPositions = new Set<string>();
      for (const entry of feeEntries) {
        if (!entry.positionAddress || sentPositions.has(entry.positionAddress)) continue;
        sentPositions.add(entry.positionAddress);
        try {
          const sig = await deps.sendFeePayload(connection, entry);
          addUniqueSignature(result, seenSignatures, sig);
          addTokenTotals(tokenTotals, entry.tokens || []);
        } catch (err: any) {
          result.failures.push({ phase: 'fee-send', ref: entry.positionAddress, error: err.message || String(err) });
        }
      }
    }
  } catch (err: any) {
    result.failures.push({ phase: 'fatal', ref: 'claimLpFees', error: err.message || String(err) });
  }

  result.claimedTokens = [...tokenTotals.entries()].map(([symbol, { amount, decimals }]) => ({ symbol, amount, decimals }));
  result.totalItems = result.txSignatures.length;
  return result;
}

export async function sendSignedFeePayloadForTest(
  connection: any,
  txPayload: string,
  signPayload: (txPayload: string) => Promise<{ serialize: () => Buffer | Uint8Array; message: { recentBlockhash: string } }>,
  skipPreflight: boolean,
): Promise<string> {
  const signed = await signPayload(txPayload);
  const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight, maxRetries: 3 });
  const latest = await connection.getLatestBlockhash('confirmed');
  const confirm = await connection.confirmTransaction({
    signature,
    blockhash: signed.message.recentBlockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  }, 'confirmed');
  if (confirm?.value?.err) {
    throw new Error(`Transaction confirmed but failed: ${JSON.stringify(confirm.value.err)}`);
  }
  return signature;
}

async function signRewardPayload(txPayload: string): Promise<string> {
  const tx = VersionedTransaction.deserialize(Buffer.from(txPayload, 'base64'));
  const signed = await signVersioned(tx);
  return Buffer.from(signed.serialize()).toString('base64');
}

async function sendFeePayload(connection: Connection, entry: FeeClaimEntry): Promise<string> {
  return sendSignedFeePayloadForTest(connection, entry.txPayload, async (txPayload) => {
    const tx = VersionedTransaction.deserialize(Buffer.from(txPayload, 'base64'));
    return signVersioned(tx);
  }, config.skipPreflight);
}

export async function claimLpFeesOffchain(connection: Connection): Promise<LpFeeClaimResult> {
  const walletAddress = getUserAddress().toBase58();
  logger.info(MODULE, `=== Claim Byreal LP fees/rewards wallet=${walletAddress.slice(0, 8)} ===`);
  const result = await claimLpFeesCliParityForTest(connection, {
    apiGet,
    apiPost,
    getWalletAddress: () => walletAddress,
    signRewardPayload,
    sendFeePayload,
  });
  logger.info(MODULE, `=== Claim finished: ${result.totalItems} txs, ${result.failures.length} failures ===`);
  return result;
}

function finalize(entry: ClaimHistoryEntry, currentWeek: string): void {
  claimHistory.push(entry);
  saveClaimHistory();

  lastClaimTs = entry.ts;
  lastClaimResult = formatClaimResult(entry);

  if (!entry.error) lastClaimWeek = currentWeek;

  logger.info(MODULE, `=== 領取完畢: ${entry.totalPools} pools, ${entry.txSignatures.length} txs ===`);
}

// --- Scheduler ---

/** 算到下一個週二 16:30 台灣時間 (08:30 UTC) 的毫秒數 */
function msUntilNextClaim(): number {
  const now = new Date();
  const target = new Date(now);
  target.setUTCHours(8, 30, 0, 0);

  const dayDiff = (2 - now.getUTCDay() + 7) % 7;
  target.setUTCDate(target.getUTCDate() + dayDiff);

  if (target.getTime() <= now.getTime()) {
    target.setUTCDate(target.getUTCDate() + 7);
  }

  return target.getTime() - now.getTime();
}

function scheduleNextClaim(): void {
  if (!config.autoClaimEnabled) return;

  const ms = msUntilNextClaim();
  const hours = (ms / 3600000).toFixed(1);
  const targetDate = new Date(Date.now() + ms);
  logger.info(MODULE, `下次領取: ${targetDate.toISOString()} (${hours} 小時後)`);

  schedulerTimer = setTimeout(() => {
    const week = getISOWeek(new Date());
    if (lastClaimWeek === week) {
      logger.info(MODULE, `本週已領取 (week=${week})，跳過`);
    } else {
      logger.info(MODULE, `排程觸發：週二 16:30 台灣時間`);
      claimCopyBonus().catch(err => {
        logger.error(MODULE, `Auto-claim error: ${err.message}`);
      });
    }
    scheduleNextClaim();
  }, ms);
}

export function startAutoClaimScheduler(): void {
  loadClaimHistory();
  if (!config.autoClaimEnabled) {
    logger.info(MODULE, 'Auto-claim disabled (AUTO_CLAIM_ENABLED != true)');
    return;
  }
  logger.info(MODULE, `Auto-claim scheduler started (每週二 16:30 台灣時間)`);
  if (lastClaimWeek) logger.info(MODULE, `上次領取: week=${lastClaimWeek}`);
  scheduleNextClaim();
}

export function stopAutoClaimScheduler(): void {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
}

export function getClaimHistory(): ClaimHistoryEntry[] {
  return claimHistory;
}
