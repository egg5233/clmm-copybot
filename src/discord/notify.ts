import fs from 'fs';
import { config } from '../config';
import { getUserAddress } from '../utils/wallet';
import { logger } from '../utils/logger';

const pkg = require('../../package.json');

function resolveSymbol(mint: string): string {
  try {
    const raw = fs.readFileSync('./data/token-names.json', 'utf-8');
    const cache = JSON.parse(raw);
    return cache[mint]?.symbol || mint;
  } catch {
    return mint;
  }
}

const MODULE = 'Discord';

// ---------------------------------------------------------------------------
// On-chain error parser — extracts readable summary from simulation logs
// ---------------------------------------------------------------------------

const ERROR_MAP: Record<number, string> = {
  1: '代幣餘額不足 (insufficient funds)',
  6013: '價格限制溢出 (SqrtPriceLimitOverflow)',
  6021: '價格滑點超限 (PriceSlippageCheck)',
  6024: '滑點超限 (SlippageToleranceExceeded)',
};

function parseOnChainError(error: any): string {
  let raw = error?.message ?? error;
  // If .message is an object (some Solana RPC errors), try deeper extraction or stringify
  if (raw && typeof raw === 'object') {
    raw = raw.message ?? raw.msg ?? raw.error ?? raw;
  }
  let msg: string;
  if (typeof raw === 'string') {
    msg = raw;
  } else if (raw instanceof Error) {
    msg = raw.message;
  } else {
    try {
      msg = JSON.stringify(raw) ?? String(raw);
    } catch {
      msg = String(raw);
    }
  }
  // Guard against [object Object] leaking through
  if (msg.includes('[object Object]')) {
    try {
      msg = JSON.stringify(error);
    } catch {
      msg = String(error);
    }
  }

  // Extract AnchorError: "Error Code: PriceSlippageCheck. Error Number: 6021."
  const anchorMatch = msg.match(/Error Code: (\w+)\.\s*Error Number: (\d+)/);
  if (anchorMatch) {
    const num = parseInt(anchorMatch[2]);
    const friendly = ERROR_MAP[num];
    if (friendly) return friendly;
    return `${anchorMatch[1]} (0x${num.toString(16)})`;
  }

  // Extract "custom program error: 0xXXXX"
  const hexMatch = msg.match(/custom program error: (0x[0-9a-fA-F]+)/);
  if (hexMatch) {
    const num = parseInt(hexMatch[1], 16);
    const friendly = ERROR_MAP[num];
    if (friendly) return `${friendly}`;
    return `Program error ${hexMatch[1]}`;
  }

  // Jupiter / SPL token errors
  if (/insufficient lamports/i.test(msg)) return 'SOL 餘額不足';
  if (/insufficient funds/i.test(msg) || /0x1\b/.test(msg)) return '代幣餘額不足';

  // Fallback: first 150 chars
  const clean = msg.replace(/\s+/g, ' ').trim();
  return clean.length > 150 ? clean.slice(0, 150) + '…' : clean;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NotifyField {
  name: string;
  value: string;
}

interface NotifyPayload {
  wallet: string;
  apiKey: string;
  type: string;
  title: string;
  description: string;
  timestamp: string;
  fields?: NotifyField[];
  version: string;
}

// ---------------------------------------------------------------------------
// Rate-limit aggregation
// ---------------------------------------------------------------------------

interface PendingNotification {
  type: string;
  title: string;
  description: string;
  fields?: NotifyField[];
  count: number;
  eventTime: Date;
  timer: ReturnType<typeof setTimeout>;
}

const AGGREGATE_WINDOW_MS = 10_000;
const pendingMap = new Map<string, PendingNotification>();

// ---------------------------------------------------------------------------
// Core POST
// ---------------------------------------------------------------------------

async function postNotification(
  type: string,
  title: string,
  description: string,
  fields?: NotifyField[],
  eventTime?: Date,
): Promise<void> {
  const url = (config as any).discordNotifyUrl;
  const apiKey = (config as any).discordApiKey;
  if (!url) return; // not configured — silently skip

  const ts = eventTime || new Date();
  const utcStr = ts.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const twTime =
    ts.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) + ' (UTC+8)';
  const allFields = [
    ...(fields && fields.length > 0 ? fields : []),
    { name: '時間', value: `${twTime}\n${utcStr}` },
  ];

  const payload: NotifyPayload = {
    wallet: getUserAddress().toBase58(),
    apiKey: apiKey || '',
    type,
    title,
    description,
    timestamp: ts.toISOString(),
    fields: allFields,
    version: pkg.version,
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      logger.warn(MODULE, `POST ${res.status}: ${await res.text().catch(() => '')}`);
    }
  } catch (err: any) {
    logger.warn(MODULE, `POST failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Aggregated send (dedup same-key events within 10s window)
// ---------------------------------------------------------------------------

function aggregateKey(type: string, extra?: string): string {
  return extra ? `${type}:${extra}` : type;
}

function sendAggregated(
  type: string,
  title: string,
  description: string,
  fields?: NotifyField[],
  dedupeExtra?: string,
): void {
  const key = aggregateKey(type, dedupeExtra);
  const existing = pendingMap.get(key);

  if (existing) {
    existing.count += 1;
    existing.description = description;
    existing.fields = fields;
    return;
  }

  const pending: PendingNotification = {
    type,
    title,
    description,
    fields,
    count: 1,
    eventTime: new Date(),
    timer: setTimeout(() => {
      pendingMap.delete(key);
      const desc =
        pending.count > 1 ? `${pending.description} (x${pending.count})` : pending.description;
      postNotification(pending.type, pending.title, desc, pending.fields, pending.eventTime);
    }, AGGREGATE_WINDOW_MS),
  };

  pendingMap.set(key, pending);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function notifySolInsufficient(solBalance: number): void {
  sendAggregated(
    'sol_insufficient',
    'SOL 餘額不足',
    `目前 SOL 餘額: ${solBalance.toFixed(4)} SOL，可能無法支付交易費用`,
    [{ name: 'SOL 餘額', value: `${solBalance.toFixed(4)} SOL` }],
  );
}

export function notifyDrawdownPause(
  drawdownPct: number,
  startAsset: number,
  currentAsset: number,
): void {
  sendAggregated(
    'drawdown_pause',
    '回撤暫停',
    `回撤 ${drawdownPct.toFixed(1)}% 已超過閾值，Bot 暫停運作`,
    [
      { name: '回撤幅度', value: `${drawdownPct.toFixed(1)}%` },
      { name: '起始資產', value: `$${startAsset.toFixed(2)}` },
      { name: '目前資產', value: `$${currentAsset.toFixed(2)}` },
    ],
  );
}

export function notifySwapFailed(tokenMint: string, context: string): void {
  const symbol = resolveSymbol(tokenMint);
  const errSummary = parseOnChainError({ message: context });
  sendAggregated(
    'swap_failed',
    '兌換失敗',
    `${symbol} 兌換失敗`,
    [
      { name: '代幣', value: symbol },
      { name: 'Mint', value: tokenMint },
      { name: '錯誤', value: errSummary },
    ],
    tokenMint,
  );
}

export function notifyOpenFailed(error: any, targetNft: string): void {
  const errSummary = parseOnChainError(error);
  sendAggregated(
    'open_failed',
    '開倉失敗',
    `目標 NFT ${targetNft} 開倉失敗: ${errSummary}`,
    [
      { name: '目標 NFT', value: targetNft },
      { name: '錯誤', value: errSummary },
    ],
    targetNft,
  );
}

export function notifyCloseFailed(ourNft: string, error: any, attempt: number): void {
  const errSummary = typeof error === 'string' ? error : parseOnChainError(error);
  sendAggregated(
    'close_failed',
    '平倉失敗',
    `NFT ${ourNft} 平倉失敗 (第 ${attempt} 次): ${errSummary}`,
    [
      { name: '我方 NFT', value: ourNft },
      { name: '重試次數', value: `${attempt}` },
      { name: '錯誤', value: errSummary },
    ],
    ourNft,
  );
}

/**
 * Pump token approval request — sends immediately (no aggregation).
 * Payload includes pumpMint so the Worker can generate approve/reject buttons.
 */
export async function notifyPumpApproval(
  mint: string,
  symbol: string,
  pool: string,
): Promise<void> {
  const url = (config as any).discordNotifyUrl;
  const apiKey = (config as any).discordApiKey;
  if (!url) return;

  // Try to resolve real token name from Jupiter if symbol looks like truncated mint
  let resolvedSymbol = symbol;
  if (!symbol || symbol === mint || symbol.length <= 12) {
    try {
      const headers: Record<string, string> = {};
      if ((config as any).jupApiKey) headers['x-api-key'] = (config as any).jupApiKey;
      const jupRes = await fetch(`https://api.jup.ag/tokens/v2/search?query=${mint}`, { headers });
      if (jupRes.ok) {
        const arr: any[] = (await jupRes.json()) as any;
        if (arr?.[0]?.symbol) resolvedSymbol = arr[0].symbol;
      }
    } catch {
      /* use original symbol */
    }
  }

  const payload = {
    wallet: getUserAddress().toBase58(),
    apiKey: apiKey || '',
    type: 'pump_approval',
    title: 'Pump 代幣審批',
    description: `偵測到 Pump 代幣 **${resolvedSymbol}**，等待您批准或拒絕`,
    timestamp: new Date().toISOString(),
    fields: [
      { name: '代幣', value: resolvedSymbol },
      { name: 'Mint', value: mint },
      { name: '流動池', value: pool },
    ],
    version: pkg.version,
    pumpMint: mint,
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      logger.warn(MODULE, `Pump approval POST ${res.status}: ${await res.text().catch(() => '')}`);
    }
  } catch (err: any) {
    logger.warn(MODULE, `Pump approval POST failed: ${err.message}`);
  }
}

/**
 * Pump token expired after 24h — auto-rejected and blacklisted.
 */
export async function notifyPumpExpired(mint: string, symbol: string): Promise<void> {
  const url = (config as any).discordNotifyUrl;
  const apiKey = (config as any).discordApiKey;
  if (!url) return;

  const payload = {
    wallet: getUserAddress().toBase58(),
    apiKey: apiKey || '',
    type: 'pump_expired',
    title: 'Pump 代幣審批已過期',
    description: `Pump 代幣 **${symbol}** 超過 1 小時未回應，已自動拒絕並加入黑名單`,
    timestamp: new Date().toISOString(),
    fields: [
      { name: '代幣', value: symbol },
      { name: 'Mint', value: mint },
    ],
    version: pkg.version,
    pumpMint: mint,
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      logger.warn(MODULE, `Pump expired POST ${res.status}: ${await res.text().catch(() => '')}`);
    }
  } catch (err: any) {
    logger.warn(MODULE, `Pump expired POST failed: ${err.message}`);
  }
}

/**
 * Crash notification — awaited to ensure delivery before process exits.
 */
export async function notifyCrash(error: any): Promise<void> {
  const errMsg = error?.stack ?? error?.message ?? String(error);
  // Bypass aggregation — send immediately since bot is crashing
  await postNotification('crash', 'Bot 崩潰', `Bot 發生未預期錯誤並即將重啟:\n${errMsg}`, [
    { name: '錯誤', value: errMsg.slice(0, 1000) },
  ]);
}

/**
 * Flush all pending aggregated notifications immediately.
 * Call before graceful shutdown.
 */
export async function flushAllPending(): Promise<void> {
  const promises: Promise<void>[] = [];

  for (const [key, pending] of pendingMap) {
    clearTimeout(pending.timer);
    pendingMap.delete(key);
    const desc =
      pending.count > 1 ? `${pending.description} (x${pending.count})` : pending.description;
    promises.push(
      postNotification(pending.type, pending.title, desc, pending.fields, pending.eventTime),
    );
  }

  await Promise.allSettled(promises);
}
