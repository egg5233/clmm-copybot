import http from 'http';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { execSync } from 'child_process';
import { PublicKey } from '@solana/web3.js';
import WebSocket = require('ws');
import {
  config,
  DAC_TOKEN_OPTIONS,
  normalizeByrealMaxOpenPositions,
  normalizeDacTargetToken,
} from '../config';
import { logger, logEmitter, getRecentLogs, LogEntry } from '../utils/logger';
import { getUserAddress } from '../utils/wallet';
import { BotContext } from './context';
import { getAssetTrend, forceSnapshot, getTrendLatestTs } from './asset-trend';
import {
  claimCopyBonus,
  claimLpFeesOffchain,
  lastClaimTs,
  lastClaimResult,
  getClaimHistory,
} from '../executor/auto-claim';
import {
  setPoolTvlRefreshMinutes,
  getTvlCacheInfo,
  fetchAndCache as refreshTvlCache,
  checkTokenLiquidity,
} from '../monitor/pool-tvl';
import { updateEnvFile } from '../utils/env';
import {
  normalizeByrealAllowSameTickWallets,
  serializeWalletSet,
} from '../utils/byreal-allow-same-tick';
import { applyPoolAgeWhitelistConfig } from '../utils/pool-age-whitelist';
import {
  getPumpPendingList,
  resolvePump,
  deletePumpEntry,
  addPumpPending,
  pollApprovals,
  setPumpPollerWallet,
} from '../state/pump-pending';
import { pushSwap } from '../state/activity-log';
import { authLog as authLogRepo } from '../state/repo';
import type { AuthLogEntry } from '../state/repo/authLog';
import { WriteChain } from '../state/write-chain';
import { notifyPumpApproval } from '../discord/notify';
import {
  getDacHistory,
  getDacNextScheduledTime,
  triggerDac,
  stopDacScheduler,
  startDacScheduler,
} from '../executor/dac';

const MODULE = 'Dashboard';
const CC_OVERRIDES_FILE = path.resolve('./data/coin-concentration-overrides.json');

export function applyByrealMaxOpenPositionsConfig(
  body: Record<string, any>,
  targetConfig: { byrealMaxOpenPositions: number } = config,
  envUpdates: Record<string, string> = {},
): Record<string, string> {
  if (body.byrealMaxOpenPositions !== undefined) {
    const normalizedByrealMaxOpenPositions = normalizeByrealMaxOpenPositions(
      body.byrealMaxOpenPositions,
    );
    targetConfig.byrealMaxOpenPositions = normalizedByrealMaxOpenPositions;
    envUpdates.BYREAL_MAX_OPEN_POSITIONS = String(normalizedByrealMaxOpenPositions);
  }
  return envUpdates;
}

function loadCcOverrides(): void {
  try {
    if (!fs.existsSync(CC_OVERRIDES_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(CC_OVERRIDES_FILE, 'utf-8'));
    const overrides: Array<{ mint: string; usd: number; pct: number }> = raw.overrides ?? [];
    config.coinConcentrationOverrides.clear();
    for (const o of overrides) {
      if (o.mint)
        config.coinConcentrationOverrides.set(o.mint, { usd: o.usd ?? 0, pct: o.pct ?? 0 });
    }
    if (overrides.length > 0)
      logger.info(MODULE, `Loaded ${overrides.length} coin concentration overrides`);
  } catch (err: any) {
    logger.warn(MODULE, `Failed to load CC overrides: ${err.message}`);
  }
}

function saveCcOverrides(): void {
  try {
    const dir = path.dirname(CC_OVERRIDES_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const overrides = Array.from(config.coinConcentrationOverrides.entries()).map(([mint, v]) => ({
      mint,
      usd: v.usd,
      pct: v.pct,
    }));
    fs.writeFileSync(CC_OVERRIDES_FILE, JSON.stringify({ overrides }, null, 2));
  } catch (err: any) {
    logger.warn(MODULE, `Failed to save CC overrides: ${err.message}`);
  }
}

// --- Pump notification queue (2s spacing to avoid Discord rate limit) ---
const pumpNotifyQueue: Array<{ mint: string; symbol: string; pool: string }> = [];
let pumpNotifyRunning = false;

function queuePumpNotify(mint: string, symbol: string, pool: string): void {
  pumpNotifyQueue.push({ mint, symbol, pool });
  if (!pumpNotifyRunning) drainPumpNotifyQueue();
}

async function drainPumpNotifyQueue(): Promise<void> {
  pumpNotifyRunning = true;
  while (pumpNotifyQueue.length > 0) {
    const task = pumpNotifyQueue.shift()!;
    try {
      await notifyPumpApproval(task.mint, task.symbol, task.pool);
      logger.info(MODULE, `Pump notification sent: ${task.symbol} (${task.mint})`);
    } catch (err: any) {
      logger.warn(MODULE, `Pump notification failed: ${task.symbol} — ${err.message}`);
    }
    if (pumpNotifyQueue.length > 0) await new Promise((r) => setTimeout(r, 2000));
  }
  pumpNotifyRunning = false;
}

// --- SOL Price Cache (updated by asset-trend every 5min, or on OPEN/CLOSE via Jupiter) ---
let cachedSolPrice = 0;
let solPriceUpdatedAt = 0;

/** Update SOL price from Jupiter (called by asset-trend module) */
export function updateSolPrice(price: number): void {
  if (price > 0) {
    cachedSolPrice = price;
    solPriceUpdatedAt = Date.now();
  }
}

/** Get cached SOL price */
export function getSolPrice(): number {
  return cachedSolPrice;
}

/** Fetch SOL price from Jupiter Price v3 (used on OPEN/CLOSE events) */
async function fetchSolPrice(): Promise<number> {
  const jupApiKey = config.jupApiKey;
  if (!jupApiKey) return cachedSolPrice;
  try {
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const res = await fetch(`https://api.jup.ag/price/v3?ids=${SOL_MINT}`, {
      headers: { 'x-api-key': jupApiKey },
    });
    if (!res.ok) return cachedSolPrice;
    const data = (await res.json()) as any;
    const price = data?.[SOL_MINT]?.usdPrice;
    if (price > 0) {
      cachedSolPrice = parseFloat(String(price));
      solPriceUpdatedAt = Date.now();
      logger.info(MODULE, `SOL price updated: $${cachedSolPrice}`);
    }
    return cachedSolPrice;
  } catch (err: any) {
    logger.warn(MODULE, `Failed to fetch SOL price: ${err.message}`);
    return cachedSolPrice;
  }
}

/** Call this after OPEN/CLOSE events to refresh SOL price (throttled: max once per 5min) */
export async function refreshSolPrice(): Promise<void> {
  if (Date.now() - solPriceUpdatedAt < 5 * 60 * 1000) return;
  await fetchSolPrice();
}

// --- Auth Log (Postgres-persisted, independent from bot logs) ---
const MAX_AUTH_LOG = 200;

/**
 * Login attempts, newest last — the order the file held and `slice(-20)` reads.
 * `authLogRepo.list()` hands them back newest first, so the boot load reverses.
 */
let authLog: AuthLogEntry[] = [];
const authLogWrites = new WriteChain(MODULE);

async function initAuthLog(): Promise<void> {
  const newestFirst = await authLogRepo.list(MAX_AUTH_LOG);
  authLog = newestFirst.reverse();
  authLogWrites.enable();
  logger.info(MODULE, `Loaded ${authLog.length} auth log entries from Postgres`);
}

/** Resolves once every queued auth-log write has reached Postgres. For shutdown. */
export async function flushAuthLog(): Promise<void> {
  await authLogWrites.drain();
}

function pushAuthLog(ip: string, event: string): void {
  const ts = Date.now();
  authLog.push({ ts, ip, event });
  if (authLog.length > MAX_AUTH_LOG) authLog.splice(0, authLog.length - MAX_AUTH_LOG);
  authLogWrites.push('auth log entry', () => authLogRepo.push(ip, event, ts, MAX_AUTH_LOG));
}

// --- Token Info Cache (disk-persisted, lazy API fetch on unknown mint) ---
interface TokenInfo {
  symbol: string;
  decimals: number;
  logoURI?: string;
}
const tokenInfoCache = new Map<string, TokenInfo>();
const TOKEN_CACHE_FILE = './data/token-names.json';
let apiFetchedThisRun = false; // Only fetch API once per run

/** Load token info from disk cache on startup. */
function loadTokenInfo(): void {
  try {
    if (fs.existsSync(TOKEN_CACHE_FILE)) {
      const cached = JSON.parse(fs.readFileSync(TOKEN_CACHE_FILE, 'utf-8'));
      let count = 0;
      for (const [mint, info] of Object.entries(cached)) {
        const ti = info as TokenInfo;
        if (ti.symbol) {
          tokenInfoCache.set(mint, ti);
          count++;
        }
      }
      if (count > 0) {
        logger.info(MODULE, `Loaded ${count} token info from disk cache`);
      }
    }
  } catch {
    /* disk read failed */
  }
}

async function fetchAndCacheTokenInfo(): Promise<void> {
  try {
    const res = await fetch('https://api2.byreal.io/byreal/api/dex/v2/mint/list?pageSize=100', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json',
        Referer: 'https://www.byreal.io/',
      },
    });
    if (!res.ok) {
      logger.warn(MODULE, `Byreal mint/list returned ${res.status}`);
      return;
    }
    const data = (await res.json()) as any;
    const records = data?.result?.data?.records;
    if (!Array.isArray(records)) return;

    let added = 0;
    for (const r of records) {
      if (r.address && r.symbol) {
        const existing = tokenInfoCache.get(r.address);
        if (!existing || !existing.logoURI) {
          tokenInfoCache.set(r.address, {
            symbol: r.symbol,
            decimals: typeof r.decimals === 'number' ? r.decimals : 6,
            logoURI: r.logoURI || existing?.logoURI || '',
          });
          if (!existing) added++;
        }
      }
    }
    saveTokenCache();
    logger.info(MODULE, `Fetched ${added} new token info from API (total: ${tokenInfoCache.size})`);
  } catch (err: any) {
    logger.warn(MODULE, `Could not fetch Byreal token info: ${err.message}`);
  }
}

function saveTokenCache(): void {
  try {
    const dir = path.dirname(TOKEN_CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const obj: Record<string, TokenInfo> = {};
    for (const [k, v] of tokenInfoCache) obj[k] = v;
    fs.writeFileSync(TOKEN_CACHE_FILE, JSON.stringify(obj, null, 2));
  } catch {
    /* ignore */
  }
}

function resolveTokenName(mint: string): string {
  if (!mint) return '???';
  const cached = tokenInfoCache.get(mint);
  if (cached) return cached.symbol;
  // Unknown mint — trigger lazy API fetch (once per run)
  if (!apiFetchedThisRun) {
    apiFetchedThisRun = true;
    fetchAndCacheTokenInfo().catch(() => {});
  }
  return mint.slice(0, 4) + '...' + mint.slice(-4);
}

/** Batch-resolve unknown mints via Jupiter Token API. Call (await) before API responses. */
async function ensureTokenNames(mints: string[]): Promise<void> {
  const unknown = mints.filter((m) => m && !tokenInfoCache.has(m));
  if (unknown.length === 0) return;
  const unique = [...new Set(unknown)];
  let resolved = 0;
  // Jupiter API key header (if configured)
  const jupHeaders: Record<string, string> = { Accept: 'application/json' };
  if (config.jupApiKey) jupHeaders['x-api-key'] = config.jupApiKey;
  // Batch via Jupiter tokens endpoint (up to 100 at a time)
  for (let i = 0; i < unique.length; i += 100) {
    const batch = unique.slice(i, i + 100);
    try {
      const ids = batch.join(',');
      const res = await fetch(`https://tokens.jup.ag/tokens?ids=${ids}`, {
        headers: jupHeaders,
      });
      if (res.ok) {
        const tokens = (await res.json()) as any[];
        if (Array.isArray(tokens)) {
          for (const t of tokens) {
            if (t?.address && t?.symbol) {
              tokenInfoCache.set(t.address, {
                symbol: t.symbol,
                decimals: t.decimals ?? 6,
                logoURI: t.logoURI || '',
              });
              resolved++;
            }
          }
        }
      } else {
        logger.warn(MODULE, `Jupiter batch API ${res.status}: ${batch.length} mints`);
      }
    } catch (err: any) {
      logger.warn(MODULE, `Jupiter batch API error: ${err.message}`);
    }
  }
  // Fallback 1: individually fetch any still-unknown mints from Jupiter
  const stillUnknown = unique.filter((m) => !tokenInfoCache.has(m));
  for (const mint of stillUnknown) {
    try {
      const res = await fetch(`https://tokens.jup.ag/token/${mint}`, {
        headers: jupHeaders,
      });
      if (res.ok) {
        const t = (await res.json()) as any;
        if (t?.symbol) {
          tokenInfoCache.set(mint, {
            symbol: t.symbol,
            decimals: t.decimals ?? 6,
            logoURI: t.logoURI || '',
          });
          resolved++;
        }
      }
    } catch (err: any) {
      logger.warn(MODULE, `Jupiter single API error for ${mint}: ${err.message}`);
    }
  }
  // Fallback 2: Helius DAS API (getAssetBatch) — supports Token2022 + pump tokens
  const finalUnknown = unique.filter((m) => !tokenInfoCache.has(m));
  if (finalUnknown.length > 0 && config.rpcUrl) {
    const apiKeyMatch = config.rpcUrl.match(/api-key=([a-f0-9-]+)/i);
    if (apiKeyMatch) {
      const heliusKey = apiKeyMatch[1];
      for (let i = 0; i < finalUnknown.length; i += 100) {
        const batch = finalUnknown.slice(i, i + 100);
        try {
          const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${heliusKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 'token-names',
              method: 'getAssetBatch',
              params: { ids: batch },
            }),
          });
          if (res.ok) {
            const json = (await res.json()) as any;
            const assets = json?.result;
            if (Array.isArray(assets)) {
              for (const asset of assets) {
                const mint = asset?.id;
                const symbol = asset?.content?.metadata?.symbol;
                if (mint && symbol) {
                  const decimals = asset?.token_info?.decimals ?? 6;
                  const logoURI = asset?.content?.links?.image || asset?.content?.json_uri || '';
                  tokenInfoCache.set(mint, { symbol: symbol.trim(), decimals, logoURI });
                  resolved++;
                }
              }
            }
          } else {
            logger.warn(MODULE, `Helius DAS API ${res.status}: ${batch.length} mints`);
          }
        } catch (err: any) {
          logger.warn(MODULE, `Helius DAS API error: ${err.message}`);
        }
      }
    } else {
      logger.warn(MODULE, `Cannot extract Helius API key from RPC URL for token name fallback`);
    }
  }
  if (resolved > 0) {
    saveTokenCache();
    logger.info(MODULE, `Resolved ${resolved} unknown token names via Jupiter/Helius`);
  } else if (unique.length > 0) {
    logger.warn(MODULE, `Failed to resolve ${unique.length} token names: ${unique.join(', ')}`);
  }
}

function resolveDecimals(mint: string): number {
  return tokenInfoCache.get(mint)?.decimals ?? 6;
}

function resolveLogoURI(mint: string): string {
  return tokenInfoCache.get(mint)?.logoURI || '';
}

/** Convert raw amount string to human-readable UI amount. */
function rawToUi(raw: string, decimals: number): string {
  if (!raw || raw === '0') return '0';
  const s = raw.padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals) || '0';
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

// --- Rate Limiting ---
const MAX_FAILURES = 5;
const LOCK_DURATION_MS = 60 * 60 * 1000; // 1 hour
const failureMap = new Map<string, { count: number; blockedUntil: number }>();

function getClientIP(req: http.IncomingMessage): string {
  // Behind Cloudflare Tunnel: CF-Connecting-IP > X-Forwarded-For > socket
  const cfIp = req.headers['cf-connecting-ip'];
  if (typeof cfIp === 'string') return cfIp;
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') return xff.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function isBlocked(ip: string): boolean {
  const entry = failureMap.get(ip);
  if (!entry) return false;
  if (entry.blockedUntil > Date.now()) return true;
  // Lock expired, reset
  failureMap.delete(ip);
  return false;
}

function recordFailure(ip: string): void {
  const entry = failureMap.get(ip) || { count: 0, blockedUntil: 0 };
  entry.count++;
  if (entry.count >= MAX_FAILURES) {
    entry.blockedUntil = Date.now() + LOCK_DURATION_MS;
    logger.warn(MODULE, `IP ${ip} blocked for 1hr after ${entry.count} failed attempts`);
  }
  failureMap.set(ip, entry);
}

function clearFailure(ip: string): void {
  failureMap.delete(ip);
}

// Module-level WS broadcast (set by startDashboard, used by handleAPI)
let wsClientsRef: Set<WebSocket> | null = null;
function _broadcastWs(type: string, data: any): void {
  if (!wsClientsRef) return;
  const msg = JSON.stringify({ type, data });
  for (const ws of wsClientsRef) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

export async function startDashboard(ctx: BotContext): Promise<void> {
  if (!config.dashboardPassword) {
    logger.warn(MODULE, 'DASHBOARD_PASSWORD not set, dashboard disabled');
    return;
  }

  // Load auth log and coin concentration overrides
  await initAuthLog();
  loadCcOverrides();

  // Load token info from disk cache; fetch API only if some tokens are missing logos
  loadTokenInfo();
  let missingLogos = 0;
  for (const [, info] of tokenInfoCache) {
    if (!info.logoURI) missingLogos++;
  }
  if (missingLogos > 0) {
    logger.info(MODULE, `${missingLogos} tokens missing logoURI, fetching from API...`);
    fetchAndCacheTokenInfo().catch(() => {});
  }
  // Resolve unknown mints from position map on startup
  {
    const startupMints: string[] = [];
    const raw = ctx.positionMap.toJSON();
    for (const val of Object.values(raw)) {
      if (val.pool && val.pool.includes('/')) {
        const poolPart = val.pool.includes('@') ? val.pool.split('@')[0] : val.pool;
        for (const m of poolPart.split('/')) if (m) startupMints.push(m);
      }
    }
    ensureTokenNames(startupMints).catch(() => {});
  }

  const port = config.dashboardPort;

  // --- HTTP Server ---
  const server = http.createServer((req, res) => {
    const clientIP = getClientIP(req);

    // Rate limit check
    if (isBlocked(clientIP)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many failed attempts. Try again later.' }));
      return;
    }

    // CORS for local dev
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, PUT, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://localhost:${port}`);
    const pathname = url.pathname;

    // Block crawlers
    if (pathname === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('User-agent: *\nDisallow: /\n');
    }

    // Serve frontend (no auth needed)
    if (pathname === '/' || pathname === '/index.html') {
      return serveHTML(res);
    }

    // Health check (no auth required)
    if (pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', ts: Date.now() }));
    }

    // API routes require auth
    if (pathname.startsWith('/api/')) {
      if (!checkAuth(req)) {
        recordFailure(clientIP);
        pushAuthLog(clientIP, `API 認證失敗 ${pathname}`);
        logger.warn(MODULE, `[AUTH FAIL] API ${pathname} from ${clientIP}`);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '未授權' }));
        return;
      }
      clearFailure(clientIP);
      return handleAPI(req, res, url, ctx);
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  // --- WebSocket Server ---
  const wss = new WebSocket.Server({ server, path: '/ws' });
  const authenticatedClients = new Set<WebSocket>();
  wsClientsRef = authenticatedClients;

  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    const wsClientIP = getClientIP(req);
    let authed = false;

    // Block if rate-limited
    if (isBlocked(wsClientIP)) {
      pushAuthLog(wsClientIP, '連線被封鎖（頻率限制）');
      logger.warn(MODULE, `[BLOCKED] WS connection from ${wsClientIP} (rate-limited)`);
      ws.close(4029, 'Too many failed attempts');
      return;
    }

    // Must auth within 10s
    const authTimeout = setTimeout(() => {
      if (!authed) {
        pushAuthLog(wsClientIP, '認證逾時');
        logger.warn(MODULE, `[AUTH TIMEOUT] WS from ${wsClientIP} — no auth in 10s`);
        ws.close(4001, '認證超時');
      }
    }, 10000);

    ws.on('message', (raw: WebSocket.Data) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'auth') {
          if (msg.password === config.dashboardPassword) {
            authed = true;
            clearTimeout(authTimeout);
            clearFailure(wsClientIP);
            authenticatedClients.add(ws);
            pushAuthLog(wsClientIP, '登入成功');
            logger.info(MODULE, `[LOGIN OK] WS from ${wsClientIP}`);
            ws.send(JSON.stringify({ type: 'auth_ok' }));
            // Send recent logs as batch on connect
            ws.send(JSON.stringify({ type: 'logs_batch', data: getRecentLogs() }));
          } else {
            recordFailure(wsClientIP);
            pushAuthLog(wsClientIP, '密碼錯誤');
            logger.warn(MODULE, `[LOGIN FAIL] WS from ${wsClientIP} — wrong password`);
            ws.close(4003, '密碼錯誤');
          }
        }
      } catch {
        /* ignore bad messages */
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimeout);
      authenticatedClients.delete(ws);
    });
  });

  // Ping all authenticated clients every 30s to keep Cloudflare Tunnel alive
  setInterval(() => {
    for (const ws of authenticatedClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }
  }, 30000);

  // Broadcast logs to all authenticated clients
  logEmitter.on('log', (entry: LogEntry) => {
    const msg = JSON.stringify({ type: 'log', data: entry });
    for (const ws of authenticatedClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  });

  server.listen(port, config.dashboardIP, () => {
    logger.info(MODULE, `Dashboard running on http://127.0.0.1:${port} (tunnel only)`);
  });
}

// --- Auth check ---
function checkAuth(req: http.IncomingMessage): boolean {
  const auth = req.headers.authorization || '';
  // Bearer <password>
  if (auth.startsWith('Bearer ')) {
    return auth.slice(7) === config.dashboardPassword;
  }
  return false;
}

// --- Serve HTML ---
function serveHTML(res: http.ServerResponse): void {
  const htmlPath = path.resolve(__dirname, '../../public/index.html');
  try {
    const html = fs.readFileSync(htmlPath, 'utf-8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
    });
    res.end(html);
  } catch {
    res.writeHead(500);
    res.end('Dashboard HTML not found');
  }
}

// --- API Router ---
async function handleAPI(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: BotContext,
): Promise<void> {
  const pathname = url.pathname;
  const method = req.method || 'GET';

  const json = (data: any, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  // GET /api/status
  if (method === 'GET' && pathname === '/api/status') {
    const pkg = require('../../package.json');
    const posCount = ctx.positionMap.size();
    const posByDex = ctx.positionMap.countByDex();
    const orcaRent = ctx.orcaExecutor?.rentPerPosition ?? 0.0074542;
    const meteoraRent = ctx.meteoraExecutor?.rentPerPosition ?? 0.0079;
    const pcsRent = ctx.pcsExecutor?.rentPerPosition ?? 0.0090132;
    const dammv2Rent = ctx.dammv2Executor?.rentPerPosition ?? 0.0089088;
    const lockedByDex = ctx.positionMap.getTotalLockedSolByDex(
      ctx.executor.rentPerPosition,
      orcaRent,
      meteoraRent,
      pcsRent,
      dammv2Rent,
    );
    const lockedSol = +(
      lockedByDex.byreal +
      lockedByDex.orca +
      lockedByDex.meteora +
      lockedByDex.pancakeswap +
      lockedByDex.dammv2
    ).toFixed(5);
    const lockedUsd = cachedSolPrice > 0 ? +(lockedSol * cachedSolPrice).toFixed(2) : null;
    const solBalance = ctx.executor.cachedSolBalance ?? 0;
    const estimatedSlots = ctx.executor.estimateOpenSlots(solBalance);
    return json({
      version: pkg.version,
      status: ctx.executor.drawdownPaused
        ? '資產跌幅暫停'
        : ctx.executor.solPaused
          ? 'SOL 不足'
          : '運行中',
      uptime: Math.floor((Date.now() - ctx.startedAt) / 1000),
      dryRun: config.dryRun,
      wallet: getUserAddress().toBase58(),
      positions: posCount,
      posByDex,
      lockedSol,
      lockedByDex: {
        byreal: +lockedByDex.byreal.toFixed(5),
        orca: +lockedByDex.orca.toFixed(5),
        meteora: +lockedByDex.meteora.toFixed(5),
        pancakeswap: +lockedByDex.pancakeswap.toFixed(5),
        dammv2: +lockedByDex.dammv2.toFixed(5),
      },
      lockedUsd,
      solPrice: cachedSolPrice > 0 ? +cachedSolPrice.toFixed(2) : null,
      solBalance: +solBalance.toFixed(4),
      solPaused: ctx.executor.solPaused,
      solPausedAt: ctx.executor.solPausedAt,
      drawdownPaused: ctx.executor.drawdownPaused,
      drawdownPausedAt: ctx.executor.drawdownPausedAt,
      startAssetUsd: ctx.executor.startAssetUsd,
      tokenCooldowns: Object.fromEntries(
        [...ctx.executor.tokenCooldowns.entries()].map(([mint, until]) => {
          const info = tokenInfoCache.get(mint);
          return [mint, { until, symbol: info?.symbol || null }];
        }),
      ),
      tokenLossStreak: Object.fromEntries(ctx.executor.tokenLossStreak),
      estimatedSlots,
      queueLength: ctx.opQueue.pendingCount,
      processing: ctx.opQueue.isExecuting,
      busy: ctx.executor.isBusy,
      targets: config.targetWallets.length,
      closeOnlyWallets: Array.from(config.closeOnlyWallets),
      autoClaimEnabled: config.autoClaimEnabled,
      lastClaimTs,
      lastClaimResult,
      trendLatestTs: getTrendLatestTs(),
      // Orca
      orcaEnabled: config.orcaEnabled,
      orcaTargets: config.orcaTargetWallets.length,
      orcaCloseOnlyWallets: Array.from(config.orcaCloseOnlyWallets),
      // Meteora
      meteoraEnabled: config.meteoraEnabled,
      meteoraTargets: config.meteoraTargetWallets.length,
      meteoraCloseOnlyWallets: Array.from(config.meteoraCloseOnlyWallets),
      // PancakeSwap
      pcsEnabled: config.pcsEnabled,
      pcsTargets: config.pcsTargetWallets.length,
      pcsCloseOnlyWallets: Array.from(config.pcsCloseOnlyWallets),
      // DAMM v2
      dammv2Enabled: config.dammv2Enabled,
      dammv2Targets: config.dammv2TargetWallets.length,
      dammv2CloseOnlyWallets: Array.from(config.dammv2CloseOnlyWallets),
      // Signer mode: 'signer' (remote signer) or 'legacy' (private key in-process)
      signerMode: config.signerSocketPath ? 'signer' : 'legacy',
    });
  }

  // GET /api/claim-history
  if (method === 'GET' && pathname === '/api/claim-history') {
    return json(getClaimHistory());
  }

  // GET /api/auth-log (最近50筆)
  if (method === 'GET' && pathname === '/api/auth-log') {
    return json(authLog.slice(-20));
  }

  // DELETE /api/auth-log
  if (method === 'DELETE' && pathname === '/api/auth-log') {
    authLog.length = 0;
    authLogWrites.push('auth log reset', () => authLogRepo.clear());
    return json({ ok: true });
  }

  // GET /api/trend (asset trend data; ?refresh=1 to force new snapshot)
  if (method === 'GET' && pathname === '/api/trend') {
    if (url.searchParams.get('refresh') === '1') {
      ctx.executor.invalidateAssetCaches();
      forceSnapshot();
    }
    // Payload can exceed 500KB — gzip when the client accepts it
    const acceptEncoding = (req.headers['accept-encoding'] || '') as string;
    const body = JSON.stringify(getAssetTrend());
    if (acceptEncoding.includes('gzip')) {
      const gz = zlib.gzipSync(body);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'Content-Length': String(gz.length),
      });
      res.end(gz);
    } else {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
      });
      res.end(body);
    }
    return;
  }

  // GET /api/stats (aggregated event statistics)
  if (method === 'GET' && pathname === '/api/stats') {
    const events = ctx.eventLog;
    // Per-wallet + per-type breakdown
    const byWallet: Record<string, { total: number; success: number; fail: number; skip: number }> =
      {};
    const byWalletType: Record<
      string,
      Record<string, { total: number; success: number; fail: number }>
    > = {};
    // Per-dex+wallet breakdown: key = "dex:wallet"
    const byDexWallet: Record<
      string,
      { total: number; success: number; fail: number; skip: number }
    > = {};
    const byDexWalletType: Record<
      string,
      Record<string, { total: number; success: number; fail: number }>
    > = {};

    for (const e of events) {
      const t = e.type || 'UNKNOWN';
      const w = e.targetWallet || 'unknown';
      const dex = e.dex || '';

      // By wallet (legacy, all DEX combined)
      if (!byWallet[w]) byWallet[w] = { total: 0, success: 0, fail: 0, skip: 0 };
      byWallet[w].total++;
      if (t === 'SKIP') {
        byWallet[w].skip++;
      } else if (e.success) {
        byWallet[w].success++;
      } else {
        byWallet[w].fail++;
      }

      // By wallet + type (legacy)
      if (!byWalletType[w]) byWalletType[w] = {};
      if (!byWalletType[w][t]) byWalletType[w][t] = { total: 0, success: 0, fail: 0 };
      byWalletType[w][t].total++;
      if (e.success || t === 'SKIP') {
        byWalletType[w][t].success++;
      } else {
        byWalletType[w][t].fail++;
      }

      // By dex+wallet (new, per-dex stats)
      if (dex) {
        const dk = dex + ':' + w;
        if (!byDexWallet[dk]) byDexWallet[dk] = { total: 0, success: 0, fail: 0, skip: 0 };
        byDexWallet[dk].total++;
        if (t === 'SKIP') {
          byDexWallet[dk].skip++;
        } else if (e.success) {
          byDexWallet[dk].success++;
        } else {
          byDexWallet[dk].fail++;
        }

        // Normalize type by stripping DEX prefix (e.g. ORCA_OPEN → OPEN)
        const prefixes = ['ORCA_', 'METEORA_', 'PCS_', 'DAMMV2_'];
        let nt = t;
        for (const p of prefixes) {
          if (t.startsWith(p)) {
            nt = t.slice(p.length);
            break;
          }
        }
        if (!byDexWalletType[dk]) byDexWalletType[dk] = {};
        if (!byDexWalletType[dk][nt]) byDexWalletType[dk][nt] = { total: 0, success: 0, fail: 0 };
        byDexWalletType[dk][nt].total++;
        if (e.success || nt === 'SKIP') {
          byDexWalletType[dk][nt].success++;
        } else {
          byDexWalletType[dk][nt].fail++;
        }
      }
    }

    return json({ total: events.length, byWallet, byWalletType, byDexWallet, byDexWalletType });
  }

  // GET /api/positions (enriched with pool token symbols + Byreal link data)
  if (method === 'GET' && pathname === '/api/positions') {
    (async () => {
      const raw = ctx.positionMap.toJSON();
      // Collect all mints from pool strings and resolve names before rendering
      const allMints: string[] = [];
      for (const val of Object.values(raw)) {
        if (val.pool && val.pool.includes('/')) {
          const poolPart = val.pool.includes('@') ? val.pool.split('@')[0] : val.pool;
          for (const m of poolPart.split('/')) if (m) allMints.push(m);
        }
      }
      await ensureTokenNames(allMints);

      const enriched: Record<string, any> = {};
      const POSITION_SEED = Buffer.from('position', 'utf8');
      for (const [key, val] of Object.entries(raw)) {
        let poolDisplay = '';
        let mintA = '';
        let mintB = '';
        if (val.pool && val.pool.includes('/')) {
          const poolPart = val.pool.includes('@') ? val.pool.split('@')[0] : val.pool;
          const parts = poolPart.split('/');
          mintA = parts[0];
          mintB = parts[1];
          poolDisplay = resolveTokenName(mintA) + ' / ' + resolveTokenName(mintB);
        }
        // Derive position PDA from our NFT mint
        let positionAddress = '';
        try {
          const [pda] = PublicKey.findProgramAddressSync(
            [POSITION_SEED, new PublicKey(val.ourNft).toBuffer()],
            config.byrealProgramId,
          );
          positionAddress = pda.toBase58();
        } catch {
          /* ignore invalid keys */
        }
        enriched[key] = { ...val, poolDisplay, mintA, mintB, positionAddress };
      }
      json(enriched);
    })();
    return;
  }

  // GET /api/pending-swaps (enriched with token symbols + UI amounts)
  if (method === 'GET' && pathname === '/api/pending-swaps') {
    (async () => {
      const raw = ctx.executor.getPendingSwaps();
      await ensureTokenNames(Object.keys(raw));
      const enriched: Record<string, any> = {};
      for (const [mint, val] of Object.entries(raw)) {
        const v = val as any;
        const decimals = resolveDecimals(mint);
        enriched[mint] = {
          ...v,
          symbol: resolveTokenName(mint),
          uiPending: rawToUi(v.pending || '0', decimals),
          uiBotReceived: rawToUi(v.botReceived || '0', decimals),
        };
      }
      json(enriched);
    })();
    return;
  }

  // DELETE /api/pending-swaps (clear all)
  if (method === 'DELETE' && pathname === '/api/pending-swaps') {
    ctx.executor.clearAllPendingSwaps();
    return json({ ok: true });
  }

  // DELETE /api/pending-swaps/:mint (clear single)
  const pendingDeleteMatch = pathname.match(/^\/api\/pending-swaps\/(.+)$/);
  if (method === 'DELETE' && pendingDeleteMatch) {
    ctx.executor.clearOnePendingSwap(pendingDeleteMatch[1]);
    return json({ ok: true });
  }

  // GET /api/referers
  if (method === 'GET' && pathname === '/api/referers') {
    return json(ctx.executor.getOpenedReferers());
  }

  // GET /api/config
  if (method === 'GET' && pathname === '/api/config') {
    const cfgMints = [...Array.from(config.tokenBlacklist), ...Array.from(config.tokenWhitelist)];
    ensureTokenNames(cfgMints).then(() =>
      json({
        targetWallets: config.targetWallets.map((w) => w.toBase58()),
        closeOnlyWallets: Array.from(config.closeOnlyWallets),
        byrealAllowSameTickWallets: Array.from(config.byrealAllowSameTickWallets),
        byrealAllowOpenAfterOthersWallets: Array.from(config.byrealAllowOpenAfterOthersWallets),
        byrealMaxOpenPositions: config.byrealMaxOpenPositions,
        amountRatio: config.amountRatio,
        walletAmountRatios: Object.fromEntries(config.walletAmountRatios),
        skipSameTickRange: config.skipSameTickRange,
        pumpFilterMode: config.pumpFilterMode,
        minPoolAgeDays: config.minPoolAgeDays,
        poolAgeWhitelist: Array.from(config.poolAgeWhitelist),
        maxCoinConcentrationUsd: config.maxCoinConcentrationUsd,
        maxCoinConcentrationPct: config.maxCoinConcentrationPct,
        coinConcentrationOverrides: Array.from(config.coinConcentrationOverrides.entries()).map(
          ([mint, v]) => ({ mint, usd: v.usd, pct: v.pct }),
        ),
        slippageBps: config.slippageBps,
        maxRetry: config.maxRetry,
        priorityFeeLamports: config.priorityFeeLamports,
        dryRun: config.dryRun,
        allowSameWalletReopen: config.allowSameWalletReopen,
        drawdownThresholdPct: config.drawdownThresholdPct,
        tokenLossStreakLimit: config.tokenLossStreakLimit,
        tokenCooldownMinutes: config.tokenCooldownMinutes,
        jupSwapMode: config.jupSwapMode,
        tokenBlacklist: Array.from(config.tokenBlacklist).map((m) => ({
          mint: m,
          symbol: resolveTokenName(m),
          logoURI: resolveLogoURI(m),
        })),
        tokenWhitelist: Array.from(config.tokenWhitelist).map((m) => ({
          mint: m,
          symbol: resolveTokenName(m),
          logoURI: resolveLogoURI(m),
        })),
        autoClaimEnabled: config.autoClaimEnabled,
        minPoolTvl: config.minPoolTvl,
        tvlSource: config.tvlSource,
        poolTvlWhitelist: Array.from(config.poolTvlWhitelist),
        poolTvlRefreshMinutes: config.poolTvlRefreshMinutes,
        // Skip SOL pools (per-DEX)
        byrealSkipSol: config.byrealSkipSol,
        orcaSkipSol: config.orcaSkipSol,
        meteoraSkipSol: config.meteoraSkipSol,
        // Orca
        orcaTargetWallets: config.orcaTargetWallets.map((w) => w.toBase58()),
        orcaCloseOnlyWallets: Array.from(config.orcaCloseOnlyWallets),
        orcaWalletAmountRatios: Object.fromEntries(config.orcaWalletAmountRatios),
        // Meteora
        meteoraTargetWallets: config.meteoraTargetWallets.map((w) => w.toBase58()),
        meteoraCloseOnlyWallets: Array.from(config.meteoraCloseOnlyWallets),
        meteoraWalletAmountRatios: Object.fromEntries(config.meteoraWalletAmountRatios),
        // PancakeSwap
        pcsSkipSol: config.pcsSkipSol,
        pcsTargetWallets: config.pcsTargetWallets.map((w) => w.toBase58()),
        pcsCloseOnlyWallets: Array.from(config.pcsCloseOnlyWallets),
        pcsWalletAmountRatios: Object.fromEntries(config.pcsWalletAmountRatios),
        // DAMM v2
        dammv2SkipSol: config.dammv2SkipSol,
        dammv2TargetWallets: config.dammv2TargetWallets.map((w) => w.toBase58()),
        dammv2CloseOnlyWallets: Array.from(config.dammv2CloseOnlyWallets),
        dammv2WalletAmountRatios: Object.fromEntries(config.dammv2WalletAmountRatios),
      }),
    );
    return;
  }

  // GET /api/events (paginated: ?page=1&pageSize=50&type=OPEN,CLOSE)
  if (method === 'GET' && pathname === '/api/events') {
    (async () => {
      const pageSize = Math.min(parseInt(url.searchParams.get('pageSize') || '50'), 500);
      const page = Math.max(parseInt(url.searchParams.get('page') || '1'), 1);
      const typeFilter = url.searchParams.get('type');
      const allowedTypes = typeFilter
        ? new Set(typeFilter.split(',').map((t) => t.trim().toUpperCase()))
        : null;

      // Filter by type if specified
      const filtered = allowedTypes
        ? ctx.eventLog.filter((e) => allowedTypes.has((e.type || '').toUpperCase()))
        : ctx.eventLog;

      const total = filtered.length;
      const totalPages = Math.max(1, Math.ceil(total / pageSize));
      // Page 1 = newest events (from end of array)
      const start = Math.max(0, total - page * pageSize);
      const end = Math.max(0, total - (page - 1) * pageSize);
      const pageEvents = filtered.slice(start, end);

      // Resolve token names before rendering
      const eventMints: string[] = [];
      for (const e of pageEvents) {
        if (e.pool && e.pool.includes('/')) {
          const poolPart = e.pool.includes('@') ? e.pool.split('@')[0] : e.pool;
          for (const m of poolPart.split('/')) if (m) eventMints.push(m);
        }
      }
      await ensureTokenNames(eventMints);

      const events = pageEvents.map((e) => {
        let poolDisplay = '';
        if (e.pool && e.pool.includes('/')) {
          const poolPart = e.pool.includes('@') ? e.pool.split('@')[0] : e.pool;
          const parts = poolPart.split('/');
          poolDisplay = resolveTokenName(parts[0]) + ' / ' + resolveTokenName(parts[1]);
        }
        return { ...e, poolDisplay };
      });
      json({ events, page, pageSize, total, totalPages });
    })();
    return;
  }

  // GET /api/queue/high-priority-seq
  if (method === 'GET' && pathname === '/api/queue/high-priority-seq') {
    return json({
      highPrioritySeq: ctx.opQueue.getHighPrioritySeq(),
      highPriorityActive: ctx.opQueue.isHighPriorityRunningOrPending(),
    });
  }

  // GET /api/wallet-balances (non-USDC/USDT/SOL token balances)
  if (method === 'GET' && pathname === '/api/wallet-balances') {
    const DISPLAY_EXCLUDE = new Set([
      'So11111111111111111111111111111111111111112', // SOL
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmKfrE1SBVYuL9sSMdCL3DscMVPR1YnG5', // USDT
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT Token2022
    ]);
    if (url.searchParams.get('refresh') === '1') {
      ctx.executor.invalidateAssetCaches();
    }
    ctx.executor
      .getWalletTokenBalances()
      .then(async (balances) => {
        const filteredBalances = balances.filter((b) => !DISPLAY_EXCLUDE.has(b.mint));
        // Resolve token names before rendering
        await ensureTokenNames(filteredBalances.map((b) => b.mint));
        const enriched = filteredBalances.map((b) => ({
          ...b,
          symbol: resolveTokenName(b.mint),
          uiAmount: rawToUi(b.amount, b.decimals),
          logoURI: resolveLogoURI(b.mint),
          usdcValue: null as number | null,
        }));
        // Fetch USD prices from Jupiter Price API
        if (enriched.length > 0 && config.jupApiKey) {
          try {
            const mints = enriched.map((b) => b.mint).join(',');
            const priceRes = await fetch(`https://api.jup.ag/price/v3?ids=${mints}`, {
              headers: { 'x-api-key': config.jupApiKey },
            });
            if (priceRes.ok) {
              const priceData = (await priceRes.json()) as Record<string, any>;
              for (const b of enriched) {
                const p = priceData?.[b.mint]?.usdPrice;
                if (p && b.uiAmount) {
                  b.usdcValue = parseFloat(String(p)) * parseFloat(b.uiAmount);
                }
              }
            }
          } catch {
            /* price fetch failed — return balances without USDC value */
          }
        }
        enriched.sort((a, b) => (a.usdcValue || 0) - (b.usdcValue || 0));
        json(enriched);
      })
      .catch((err) => {
        logger.warn(MODULE, `Wallet balances error: ${err.message}`);
        json({ error: err.message }, 500);
      });
    return;
  }

  // GET /api/asset-breakdown (tokens locked in Byreal LP positions, aggregated by mint)
  if (method === 'GET' && pathname === '/api/asset-breakdown') {
    if (url.searchParams.get('refresh') === '1') {
      ctx.executor.invalidateAssetCaches();
      forceSnapshot();
    }
    (async () => {
      try {
        const byrealItems = await ctx.executor.getPositionAssets();
        const orcaItems = ctx.orcaExecutor ? await ctx.orcaExecutor.getPositionAssets() : [];
        const meteoraItems = ctx.meteoraExecutor
          ? await ctx.meteoraExecutor.getPositionAssets()
          : [];
        const pcsItems = ctx.pcsExecutor ? await ctx.pcsExecutor.getPositionAssets() : [];
        const dammv2Items = ctx.dammv2Executor ? await ctx.dammv2Executor.getPositionAssets() : [];
        // Merge: tag each item with dex, combine into one list
        const lpItems = [
          ...byrealItems.map((i) => ({ ...i, dex: 'byreal' as const })),
          ...orcaItems.map((i) => ({ ...i, dex: 'orca' as const })),
          ...meteoraItems.map((i) => ({ ...i, dex: 'meteora' as const })),
          ...pcsItems.map((i) => ({ ...i, dex: 'pancakeswap' as const })),
          ...dammv2Items.map((i) => ({ ...i, dex: 'dammv2' as const })),
        ];
        if (lpItems.length === 0) {
          return json({ items: [], total: 0 });
        }

        // Resolve token names for all LP item mints + paired stable mints
        const allLpMints: string[] = lpItems.map((i) => i.mint);
        for (const i of lpItems) {
          for (const m of Object.keys(i.pairedStable)) if (m) allLpMints.push(m);
        }
        await ensureTokenNames(allLpMints);

        // Fetch live USD prices from Jupiter Price API
        const prices: Record<string, number> = {};
        if (config.jupApiKey) {
          try {
            const mints = lpItems.map((i) => i.mint).join(',');
            const priceRes = await fetch(`https://api.jup.ag/price/v3?ids=${mints}`, {
              headers: { 'x-api-key': config.jupApiKey },
            });
            if (priceRes.ok) {
              const priceData = (await priceRes.json()) as any;
              for (const [mint, info] of Object.entries(priceData)) {
                const p = (info as any)?.usdPrice;
                if (p) prices[mint] = parseFloat(String(p));
              }
            }
          } catch {
            /* prices unavailable */
          }
        }

        // Resolve TVL for all unique mints (respects tvlSource setting)
        const uniqueMints = [...new Set(lpItems.map((i) => i.mint))];
        const tvlMap: Record<string, number | null> = {};
        await Promise.all(
          uniqueMints.map(async (mint) => {
            tvlMap[mint] = await checkTokenLiquidity(mint);
          }),
        );

        const items = lpItems.map((i) => {
          const price = prices[i.mint] ?? null;
          // Convert pairedStable mint addresses → symbol:amount pairs for display
          const pairedStable: Record<string, number> = {};
          for (const [stableMint, amount] of Object.entries(i.pairedStable)) {
            const sym = resolveTokenName(stableMint);
            pairedStable[sym] = +((pairedStable[sym] ?? 0) + amount).toFixed(4);
          }
          return {
            mint: i.mint,
            symbol: resolveTokenName(i.mint),
            balance: i.balance,
            usdValue: price !== null ? +(i.balance * price).toFixed(2) : null,
            logoURI: resolveLogoURI(i.mint),
            tvl: tvlMap[i.mint] ?? (i as any).poolTvl ?? null,
            pairedStable,
            liquidityUsd: i.liquidityUsd > 0 ? +i.liquidityUsd.toFixed(2) : null,
            dex: (i as any).dex || 'byreal',
          };
        });

        // Sort: USDC/USDT always first, then by USD value descending (nulls last)
        const STABLE_TOP = new Set([
          'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
          'Es9vMFrzaCERmKfrE1SBVYuL9sSMdCL3DscMVPR1YnG5', // USDT
          'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT Token2022
        ]);
        items.sort((a, b) => {
          const aStable = STABLE_TOP.has(a.mint) ? 1 : 0;
          const bStable = STABLE_TOP.has(b.mint) ? 1 : 0;
          if (aStable !== bStable) return bStable - aStable;
          return (b.usdValue ?? -1) - (a.usdValue ?? -1);
        });
        const total = items.reduce((sum, i) => sum + (i.usdValue ?? 0), 0);

        json({ items, total: +total.toFixed(2) });
      } catch (err: any) {
        json({ error: err.message }, 500);
      }
    })();
    return;
  }

  // GET /api/swap-history
  if (method === 'GET' && pathname === '/api/swap-history') {
    (async () => {
      await ensureTokenNames(ctx.swapHistory.map((s) => s.inputMint));
      const enriched = ctx.swapHistory.map((s) => {
        const decimals = s.inputDecimals ?? resolveDecimals(s.inputMint);
        return {
          ...s,
          symbol: resolveTokenName(s.inputMint),
          logoURI: resolveLogoURI(s.inputMint),
          inputAmount: s.inputAmountRaw ? rawToUi(s.inputAmountRaw, decimals) : undefined,
          outputAmount: s.outputAmountRaw ? rawToUi(s.outputAmountRaw, 6) : undefined, // USDC = 6 decimals
        };
      });
      json(enriched);
    })();
    return;
  }

  // GET /api/token-pnl (persisted PnL data per token, enriched with name/logo)
  if (method === 'GET' && pathname === '/api/token-pnl') {
    (async () => {
      const raw = ctx.executor.getTokenPnlData();
      await ensureTokenNames(Object.keys(raw));
      const enriched: Record<string, any> = {};
      for (const [mint, data] of Object.entries(raw)) {
        enriched[mint] = {
          ...(data as any),
          symbol: resolveTokenName(mint),
          logoURI: resolveLogoURI(mint),
        };
      }
      json(enriched);
    })();
    return;
  }

  // POST /api/actions/reconcile
  if (method === 'POST' && pathname === '/api/actions/reconcile') {
    ctx.executor.enqueueReconcile(ctx.opQueue);
    return json({ ok: true, message: '對帳已排入佇列' });
  }

  // PATCH /api/config — update all config (wallets + strategy + mode)
  if (method === 'POST' && pathname === '/api/actions/audit-byreal-nfts') {
    return readBody(req, async () => {
      try {
        const result = await ctx.opQueue.executeNow('audit-byreal-nfts', () =>
          ctx.executor.auditByrealNftsOnChainAndQueueClose(ctx.opQueue),
        );
        return json({ ok: true, ...result });
      } catch (err: any) {
        logger.error(MODULE, `Byreal NFT audit failed: ${err.message}`);
        return json({ ok: false, message: 'Byreal NFT audit failed: ' + err.message }, 500);
      }
    });
  }

  if (method === 'PATCH' && pathname === '/api/config') {
    return readBody(req, (body) => {
      try {
        const {
          targetWallets,
          closeOnlyWallets,
          byrealAllowSameTickWallets,
          byrealAllowOpenAfterOthersWallets,
          byrealMaxOpenPositions,
          amountRatio,
          walletAmountRatios,
          skipSameTickRange,
          pumpFilterMode,
          minPoolAgeDays,
          poolAgeWhitelist,
          maxCoinConcentrationUsd,
          maxCoinConcentrationPct,
          coinConcentrationOverrides,
          slippageBps,
          maxRetry,
          priorityFeeLamports,
          dryRun,
          allowSameWalletReopen,
          drawdownThresholdPct,
          tokenLossStreakLimit,
          tokenCooldownMinutes,
          jupSwapMode,
          tokenBlacklist,
          tokenWhitelist,
          autoClaimEnabled,
          minPoolTvl,
          tvlSource,
          poolTvlWhitelist,
          poolTvlRefreshMinutes,
          byrealSkipSol,
          orcaSkipSol,
          meteoraSkipSol,
          pcsSkipSol,
          orcaTargetWallets,
          orcaCloseOnlyWallets,
          orcaWalletAmountRatios,
          meteoraTargetWallets,
          meteoraCloseOnlyWallets,
          meteoraWalletAmountRatios,
          pcsTargetWallets,
          pcsCloseOnlyWallets,
          pcsWalletAmountRatios,
          dammv2SkipSol,
          dammv2TargetWallets,
          dammv2CloseOnlyWallets,
          dammv2WalletAmountRatios,
        } = body;
        if (!Array.isArray(targetWallets) || targetWallets.length === 0) {
          return json({ error: '至少需要一個目標錢包' }, 400);
        }

        // Validate addresses
        const newTargets: PublicKey[] = [];
        for (const addr of targetWallets) {
          try {
            newTargets.push(new PublicKey(addr.trim()));
          } catch {
            return json({ error: `無效地址: ${addr}` }, 400);
          }
        }

        const newCloseOnly = new Set<string>();
        if (Array.isArray(closeOnlyWallets)) {
          for (const addr of closeOnlyWallets) {
            const trimmed = addr.trim();
            if (trimmed) newCloseOnly.add(trimmed);
          }
        }

        // Update in-memory config — wallets
        config.targetWallets.length = 0;
        for (const t of newTargets) config.targetWallets.push(t);
        config.closeOnlyWallets.clear();
        for (const c of newCloseOnly) config.closeOnlyWallets.add(c);

        let normalizedAllowSameTick = new Set<string>();
        if (byrealAllowSameTickWallets !== undefined) {
          if (!Array.isArray(byrealAllowSameTickWallets)) {
            return json({ error: 'byrealAllowSameTickWallets 必須是陣列' }, 400);
          }
          for (const addr of byrealAllowSameTickWallets) {
            const trimmed = String(addr).trim();
            if (!trimmed) continue;
            try {
              new PublicKey(trimmed);
            } catch {
              return json({ error: `無效地址: ${trimmed}` }, 400);
            }
          }
          normalizedAllowSameTick = normalizeByrealAllowSameTickWallets(
            byrealAllowSameTickWallets,
            newTargets.map((t) => t.toBase58()),
          );
          config.byrealAllowSameTickWallets.clear();
          for (const addr of normalizedAllowSameTick) config.byrealAllowSameTickWallets.add(addr);
        }

        let normalizedAllowOpenAfterOthers = new Set<string>();
        if (byrealAllowOpenAfterOthersWallets !== undefined) {
          if (!Array.isArray(byrealAllowOpenAfterOthersWallets)) {
            return json({ error: 'byrealAllowOpenAfterOthersWallets must be an array' }, 400);
          }
          for (const addr of byrealAllowOpenAfterOthersWallets) {
            const trimmed = String(addr).trim();
            if (!trimmed) continue;
            try {
              new PublicKey(trimmed);
            } catch {
              return json({ error: `?⊥??啣?: ${trimmed}` }, 400);
            }
          }
          normalizedAllowOpenAfterOthers = normalizeByrealAllowSameTickWallets(
            byrealAllowOpenAfterOthersWallets,
            newTargets.map((t) => t.toBase58()),
          );
          config.byrealAllowOpenAfterOthersWallets.clear();
          for (const addr of normalizedAllowOpenAfterOthers)
            config.byrealAllowOpenAfterOthersWallets.add(addr);
        }

        // Apply per-wallet ratio overrides FIRST so TARGET_WALLETS serialization reflects them
        if (walletAmountRatios !== undefined && typeof walletAmountRatios === 'object') {
          config.walletAmountRatios.clear();
          for (const [addr, val] of Object.entries(walletAmountRatios)) {
            const ratio = parseFloat(String(val));
            if (!isNaN(ratio) && ratio > 0) config.walletAmountRatios.set(addr.trim(), ratio);
          }
        }

        // Update in-memory config — strategy
        const envUpdates: Record<string, string> = {
          // Serialize per-wallet ratios into TARGET_WALLETS as "addr:ratio" entries
          TARGET_WALLETS: newTargets
            .map((t) => {
              const addr = t.toBase58();
              const ratio = config.walletAmountRatios.get(addr);
              return ratio !== undefined ? `${addr}:${ratio}` : addr;
            })
            .join(','),
          CLOSE_ONLY_WALLETS: Array.from(newCloseOnly).join(','),
        };
        if (byrealAllowSameTickWallets !== undefined) {
          envUpdates.BYREAL_ALLOW_SAME_TICK_WALLETS = serializeWalletSet(normalizedAllowSameTick);
        }
        if (byrealAllowOpenAfterOthersWallets !== undefined) {
          envUpdates.BYREAL_ALLOW_OPEN_AFTER_OTHERS_WALLETS = serializeWalletSet(
            normalizedAllowOpenAfterOthers,
          );
        }
        applyByrealMaxOpenPositionsConfig({ byrealMaxOpenPositions }, config, envUpdates);

        if (amountRatio !== undefined) {
          const val = parseFloat(amountRatio);
          if (!isNaN(val) && val > 0) {
            config.amountRatio = val;
            envUpdates.AMOUNT_RATIO = val.toString();
          }
        }
        if (slippageBps !== undefined) {
          const val = parseInt(slippageBps);
          if (!isNaN(val) && val > 0) {
            config.slippageBps = val;
            envUpdates.SLIPPAGE_BPS = val.toString();
          }
        }
        if (maxRetry !== undefined) {
          const val = parseInt(maxRetry);
          if (!isNaN(val) && val > 0) {
            config.maxRetry = val;
            envUpdates.MAX_RETRY = val.toString();
          }
        }
        if (priorityFeeLamports !== undefined) {
          const val = parseInt(priorityFeeLamports);
          if (!isNaN(val) && val >= 0) {
            config.priorityFeeLamports = val;
            envUpdates.PRIORITY_FEE_LAMPORTS = val.toString();
          }
        }
        if (dryRun !== undefined) {
          const val = dryRun === true || dryRun === 'true';
          config.dryRun = val;
          envUpdates.DRY_RUN = val.toString();
        }
        if (allowSameWalletReopen !== undefined) {
          const val = allowSameWalletReopen === true || allowSameWalletReopen === 'true';
          config.allowSameWalletReopen = val;
          envUpdates.ALLOW_SAME_WALLET_REOPEN = val.toString();
        }
        if (skipSameTickRange !== undefined) {
          const val = skipSameTickRange === true || skipSameTickRange === 'true';
          config.skipSameTickRange = val;
          envUpdates.SKIP_SAME_TICK_RANGE = val.toString();
        }
        if (
          pumpFilterMode !== undefined &&
          (pumpFilterMode === 'off' || pumpFilterMode === 'full' || pumpFilterMode === 'discord')
        ) {
          const oldMode = config.pumpFilterMode;
          config.pumpFilterMode = pumpFilterMode;
          envUpdates.PUMP_FILTER_MODE = pumpFilterMode;
          // Set poller wallet when switching to discord mode
          if (pumpFilterMode === 'discord' && oldMode !== 'discord') {
            const { getUserAddress } = require('../utils/wallet');
            setPumpPollerWallet(getUserAddress().toBase58());
          }
        }
        if (minPoolAgeDays !== undefined) {
          const val = Math.max(0, parseInt(minPoolAgeDays) || 0);
          config.minPoolAgeDays = val;
          envUpdates.MIN_POOL_AGE_DAYS = val.toString();
        }
        applyPoolAgeWhitelistConfig({ poolAgeWhitelist }, config, envUpdates);
        if (maxCoinConcentrationUsd !== undefined) {
          const val = Math.max(0, parseFloat(maxCoinConcentrationUsd) || 0);
          config.maxCoinConcentrationUsd = val;
          envUpdates.MAX_COIN_CONCENTRATION_USD = val.toString();
        }
        if (maxCoinConcentrationPct !== undefined) {
          const val = Math.min(100, Math.max(0, parseFloat(maxCoinConcentrationPct) || 0));
          config.maxCoinConcentrationPct = val;
          envUpdates.MAX_COIN_CONCENTRATION_PCT = val.toString();
        }
        if (Array.isArray(coinConcentrationOverrides)) {
          config.coinConcentrationOverrides.clear();
          for (const o of coinConcentrationOverrides) {
            if (o.mint && (o.usd > 0 || o.pct > 0)) {
              config.coinConcentrationOverrides.set(o.mint, { usd: o.usd ?? 0, pct: o.pct ?? 0 });
            }
          }
          saveCcOverrides();
        }

        // Risk management
        if (drawdownThresholdPct !== undefined) {
          const val = parseFloat(drawdownThresholdPct);
          if (!isNaN(val) && val >= 0) {
            config.drawdownThresholdPct = val;
            envUpdates.DRAWDOWN_THRESHOLD_PCT = val.toString();
          }
        }
        if (tokenLossStreakLimit !== undefined) {
          const val = parseInt(tokenLossStreakLimit);
          if (!isNaN(val) && val >= 0) {
            config.tokenLossStreakLimit = val;
            envUpdates.TOKEN_LOSS_STREAK_LIMIT = val.toString();
          }
        }
        if (tokenCooldownMinutes !== undefined) {
          const val = parseInt(tokenCooldownMinutes);
          if (!isNaN(val) && val >= 0) {
            config.tokenCooldownMinutes = val;
            envUpdates.TOKEN_COOLDOWN_MINUTES = val.toString();
          }
        }
        if (jupSwapMode !== undefined && (jupSwapMode === 'metis' || jupSwapMode === 'ultra')) {
          config.jupSwapMode = jupSwapMode;
          envUpdates.JUP_SWAP_MODE = jupSwapMode;
        }

        // Token blacklist / whitelist
        if (Array.isArray(tokenBlacklist)) {
          const newBL = new Set(
            tokenBlacklist.map((s: string) => s.trim()).filter((s: string) => s.length > 0),
          );
          config.tokenBlacklist.clear();
          for (const m of newBL) config.tokenBlacklist.add(m);
          envUpdates.TOKEN_BLACKLIST = Array.from(newBL).join(',');
        }
        if (Array.isArray(tokenWhitelist)) {
          const newWL = new Set(
            tokenWhitelist.map((s: string) => s.trim()).filter((s: string) => s.length > 0),
          );
          config.tokenWhitelist.clear();
          for (const m of newWL) config.tokenWhitelist.add(m);
          envUpdates.TOKEN_WHITELIST = Array.from(newWL).join(',');
        }
        // Enforce mutual exclusivity: if a mint is in both, remove from the other
        for (const mint of config.tokenBlacklist) {
          if (config.tokenWhitelist.has(mint)) config.tokenWhitelist.delete(mint);
        }
        envUpdates.TOKEN_WHITELIST = Array.from(config.tokenWhitelist).join(',');

        // Skip SOL pools (per-DEX)
        if (byrealSkipSol !== undefined) {
          const val = byrealSkipSol === true || byrealSkipSol === 'true';
          config.byrealSkipSol = val;
          envUpdates.BYREAL_SKIP_SOL = val.toString();
        }
        if (orcaSkipSol !== undefined) {
          const val = orcaSkipSol === true || orcaSkipSol === 'true';
          config.orcaSkipSol = val;
          envUpdates.ORCA_SKIP_SOL = val.toString();
        }
        if (meteoraSkipSol !== undefined) {
          const val = meteoraSkipSol === true || meteoraSkipSol === 'true';
          config.meteoraSkipSol = val;
          envUpdates.METEORA_SKIP_SOL = val.toString();
        }
        if (pcsSkipSol !== undefined) {
          const val = pcsSkipSol === true || pcsSkipSol === 'true';
          config.pcsSkipSol = val;
          envUpdates.PCS_SKIP_SOL = val.toString();
        }
        if (dammv2SkipSol !== undefined) {
          const val = dammv2SkipSol === true || dammv2SkipSol === 'true';
          config.dammv2SkipSol = val;
          envUpdates.DAMMV2_SKIP_SOL = val.toString();
        }

        // Auto-claim
        if (autoClaimEnabled !== undefined) {
          const val = autoClaimEnabled === true || autoClaimEnabled === 'true';
          config.autoClaimEnabled = val;
          envUpdates.AUTO_CLAIM_ENABLED = val.toString();
        }

        // Pool TVL filter
        if (minPoolTvl !== undefined) {
          const val = parseFloat(minPoolTvl);
          if (!isNaN(val) && val >= 0) {
            config.minPoolTvl = val;
            envUpdates.MIN_POOL_TVL = val.toString();
          }
        }
        if (tvlSource === 'dex' || tvlSource === 'jupiter') {
          config.tvlSource = tvlSource;
          envUpdates.TVL_SOURCE = tvlSource;
        }
        if (Array.isArray(poolTvlWhitelist)) {
          const newWL = new Set<string>(
            poolTvlWhitelist.map((s: string) => s.trim()).filter((s: string) => s.length > 0),
          );
          config.poolTvlWhitelist.clear();
          for (const m of newWL) config.poolTvlWhitelist.add(m);
          envUpdates.POOL_TVL_WHITELIST = Array.from(newWL).join(',');
        }
        if (poolTvlRefreshMinutes !== undefined) {
          const val = parseFloat(poolTvlRefreshMinutes);
          if (!isNaN(val) && val >= 15) {
            config.poolTvlRefreshMinutes = val;
            envUpdates.POOL_TVL_REFRESH_MINUTES = val.toString();
            setPoolTvlRefreshMinutes(val);
          }
        }

        // Orca wallets
        if (Array.isArray(orcaTargetWallets)) {
          const newOrcaTargets: PublicKey[] = [];
          for (const addr of orcaTargetWallets) {
            try {
              newOrcaTargets.push(new PublicKey(addr.trim()));
            } catch {
              /* skip invalid */
            }
          }
          config.orcaTargetWallets.length = 0;
          for (const t of newOrcaTargets) config.orcaTargetWallets.push(t);
          (config as any).orcaEnabled = newOrcaTargets.length > 0;

          if (orcaWalletAmountRatios !== undefined && typeof orcaWalletAmountRatios === 'object') {
            config.orcaWalletAmountRatios.clear();
            for (const [addr, val] of Object.entries(orcaWalletAmountRatios)) {
              const ratio = parseFloat(String(val));
              if (!isNaN(ratio) && ratio > 0) config.orcaWalletAmountRatios.set(addr.trim(), ratio);
            }
          }

          envUpdates.ORCA_TARGET_WALLETS = newOrcaTargets
            .map((t) => {
              const addr = t.toBase58();
              const ratio = config.orcaWalletAmountRatios.get(addr);
              return ratio !== undefined ? `${addr}:${ratio}` : addr;
            })
            .join(',');
        }
        if (Array.isArray(orcaCloseOnlyWallets)) {
          const newOrcaCloseOnly = new Set<string>();
          for (const addr of orcaCloseOnlyWallets) {
            const trimmed = addr.trim();
            if (trimmed) newOrcaCloseOnly.add(trimmed);
          }
          config.orcaCloseOnlyWallets.clear();
          for (const c of newOrcaCloseOnly) config.orcaCloseOnlyWallets.add(c);
          envUpdates.ORCA_CLOSE_ONLY_WALLETS = Array.from(newOrcaCloseOnly).join(',');
        }

        // Meteora wallets
        if (Array.isArray(meteoraTargetWallets)) {
          const newMeteoraTargets: PublicKey[] = [];
          for (const addr of meteoraTargetWallets) {
            try {
              newMeteoraTargets.push(new PublicKey(addr.trim()));
            } catch {
              /* skip invalid */
            }
          }
          config.meteoraTargetWallets.length = 0;
          for (const t of newMeteoraTargets) config.meteoraTargetWallets.push(t);
          (config as any).meteoraEnabled = newMeteoraTargets.length > 0;

          if (
            meteoraWalletAmountRatios !== undefined &&
            typeof meteoraWalletAmountRatios === 'object'
          ) {
            config.meteoraWalletAmountRatios.clear();
            for (const [addr, val] of Object.entries(meteoraWalletAmountRatios)) {
              const ratio = parseFloat(String(val));
              if (!isNaN(ratio) && ratio > 0)
                config.meteoraWalletAmountRatios.set(addr.trim(), ratio);
            }
          }

          envUpdates.METEORA_TARGET_WALLETS = newMeteoraTargets
            .map((t) => {
              const addr = t.toBase58();
              const ratio = config.meteoraWalletAmountRatios.get(addr);
              return ratio !== undefined ? `${addr}:${ratio}` : addr;
            })
            .join(',');
        }
        if (Array.isArray(meteoraCloseOnlyWallets)) {
          const newMeteoraCloseOnly = new Set<string>();
          for (const addr of meteoraCloseOnlyWallets) {
            const trimmed = addr.trim();
            if (trimmed) newMeteoraCloseOnly.add(trimmed);
          }
          config.meteoraCloseOnlyWallets.clear();
          for (const c of newMeteoraCloseOnly) config.meteoraCloseOnlyWallets.add(c);
          envUpdates.METEORA_CLOSE_ONLY_WALLETS = Array.from(newMeteoraCloseOnly).join(',');
        }

        // PancakeSwap wallets
        if (Array.isArray(pcsTargetWallets)) {
          const newPcsTargets: PublicKey[] = [];
          for (const addr of pcsTargetWallets) {
            try {
              newPcsTargets.push(new PublicKey(addr.trim()));
            } catch {
              /* skip invalid */
            }
          }
          config.pcsTargetWallets.length = 0;
          for (const t of newPcsTargets) config.pcsTargetWallets.push(t);
          (config as any).pcsEnabled = newPcsTargets.length > 0;

          if (pcsWalletAmountRatios !== undefined && typeof pcsWalletAmountRatios === 'object') {
            config.pcsWalletAmountRatios.clear();
            for (const [addr, val] of Object.entries(pcsWalletAmountRatios)) {
              const ratio = parseFloat(String(val));
              if (!isNaN(ratio) && ratio > 0) config.pcsWalletAmountRatios.set(addr.trim(), ratio);
            }
          }

          envUpdates.PCS_TARGET_WALLETS = newPcsTargets
            .map((t) => {
              const addr = t.toBase58();
              const ratio = config.pcsWalletAmountRatios.get(addr);
              return ratio !== undefined ? `${addr}:${ratio}` : addr;
            })
            .join(',');
        }
        if (Array.isArray(pcsCloseOnlyWallets)) {
          const newPcsCloseOnly = new Set<string>();
          for (const addr of pcsCloseOnlyWallets) {
            const trimmed = addr.trim();
            if (trimmed) newPcsCloseOnly.add(trimmed);
          }
          config.pcsCloseOnlyWallets.clear();
          for (const c of newPcsCloseOnly) config.pcsCloseOnlyWallets.add(c);
          envUpdates.PCS_CLOSE_ONLY_WALLETS = Array.from(newPcsCloseOnly).join(',');
        }

        // DAMM v2 wallets
        if (Array.isArray(dammv2TargetWallets)) {
          const newDammv2Targets: PublicKey[] = [];
          for (const addr of dammv2TargetWallets) {
            try {
              newDammv2Targets.push(new PublicKey(addr.trim()));
            } catch {
              /* skip invalid */
            }
          }
          config.dammv2TargetWallets.length = 0;
          for (const t of newDammv2Targets) config.dammv2TargetWallets.push(t);
          (config as any).dammv2Enabled = newDammv2Targets.length > 0;

          if (
            dammv2WalletAmountRatios !== undefined &&
            typeof dammv2WalletAmountRatios === 'object'
          ) {
            config.dammv2WalletAmountRatios.clear();
            for (const [addr, val] of Object.entries(dammv2WalletAmountRatios)) {
              const ratio = parseFloat(String(val));
              if (!isNaN(ratio) && ratio > 0)
                config.dammv2WalletAmountRatios.set(addr.trim(), ratio);
            }
          }

          envUpdates.DAMMV2_TARGET_WALLETS = newDammv2Targets
            .map((t) => {
              const addr = t.toBase58();
              const ratio = config.dammv2WalletAmountRatios.get(addr);
              return ratio !== undefined ? `${addr}:${ratio}` : addr;
            })
            .join(',');
        }
        if (Array.isArray(dammv2CloseOnlyWallets)) {
          const newDammv2CloseOnly = new Set<string>();
          for (const addr of dammv2CloseOnlyWallets) {
            const trimmed = addr.trim();
            if (trimmed) newDammv2CloseOnly.add(trimmed);
          }
          config.dammv2CloseOnlyWallets.clear();
          for (const c of newDammv2CloseOnly) config.dammv2CloseOnlyWallets.add(c);
          envUpdates.DAMMV2_CLOSE_ONLY_WALLETS = Array.from(newDammv2CloseOnly).join(',');
        }

        // Write .env
        updateEnvFile(envUpdates);

        // Resubscribe WebSocket
        ctx.monitor.resubscribe().catch((err) => {
          logger.error(MODULE, `Resubscribe error: ${err.message}`);
        });

        logger.info(
          MODULE,
          `Config updated: ${newTargets.length} targets, ratio=${config.amountRatio}, slippage=${config.slippageBps}, dryRun=${config.dryRun}`,
        );
        return json({ ok: true, message: '設定已儲存（即時生效）' });
      } catch (err: any) {
        return json({ error: err.message }, 500);
      }
    });
  }

  // GET /api/tvl-query?mint=... — query a token's TVL (respects tvlSource)
  if (method === 'GET' && pathname === '/api/tvl-query') {
    const mint = url.searchParams.get('mint')?.trim();
    if (!mint) return json({ error: 'Missing mint parameter' }, 400);
    (async () => {
      const info = getTvlCacheInfo();
      const tvl = await checkTokenLiquidity(mint);
      json({
        mint,
        tvl,
        found: tvl !== null,
        source: config.tvlSource,
        lastFetchAt: info.lastFetchAt,
        cacheSize: info.size,
      });
    })();
    return;
  }

  // POST /api/actions/tvl-refresh — force refresh TVL cache now
  if (method === 'POST' && pathname === '/api/actions/tvl-refresh') {
    refreshTvlCache()
      .then(() => {
        const info = getTvlCacheInfo();
        json({ ok: true, cacheSize: info.size, lastFetchAt: info.lastFetchAt });
      })
      .catch((err) => json({ error: err.message }, 500));
    return;
  }

  // POST /api/actions/restart — graceful restart (systemd/manage.sh will respawn)
  if (method === 'POST' && pathname === '/api/actions/restart') {
    logger.info(MODULE, 'Restart requested via dashboard');
    json({ ok: true, message: '正在重啟...' });
    setTimeout(() => process.exit(0), 500);
    return;
  }

  // GET /api/check-update — compare local version vs remote origin/main
  if (method === 'GET' && pathname === '/api/check-update') {
    const pkg = require('../../package.json');
    const currentVersion = pkg.version;
    try {
      // Auto-install git if missing
      try {
        execSync('git --version', { timeout: 5000 });
      } catch {
        logger.info(MODULE, 'Git not found, auto-installing...');
        try {
          execSync('apt-get update -qq && apt-get install -y -qq git', { timeout: 120000 });
        } catch {
          return json({
            currentVersion,
            latestVersion: currentVersion,
            error: 'Git 自動安裝失敗（需手動執行: sudo apt install git -y）',
          });
        }
      }
      // Auto-init git repo if missing
      try {
        execSync('git rev-parse --git-dir', { cwd: process.cwd(), timeout: 5000 });
      } catch {
        logger.info(MODULE, 'Git repo not initialized, auto-init...');
        try {
          execSync(
            'git init && git remote add origin https://github.com/zxcnny930/byreal-copy-bot.git',
            { cwd: process.cwd(), timeout: 10000 },
          );
        } catch {
          return json({ currentVersion, latestVersion: currentVersion, error: 'Git 初始化失敗' });
        }
      }

      // Fetch latest from origin
      try {
        execSync('git fetch origin main --quiet', { cwd: process.cwd(), timeout: 30000 });
      } catch {
        return json({
          currentVersion,
          latestVersion: currentVersion,
          error: '無法連線到更新伺服器（git fetch 失敗）',
        });
      }

      // Read remote package.json version
      let latestVersion = currentVersion;
      let changelog = '';
      try {
        const remotePkg = execSync('git show origin/main:package.json', {
          cwd: process.cwd(),
          timeout: 5000,
        }).toString();
        latestVersion = JSON.parse(remotePkg).version || currentVersion;
      } catch {
        /* remote package.json not found */
      }

      // Read remote CHANGELOG.md (first 3000 chars)
      try {
        const remoteChangelog = execSync('git show origin/main:CHANGELOG.md', {
          cwd: process.cwd(),
          timeout: 5000,
        }).toString();
        changelog = remoteChangelog.slice(0, 3000);
      } catch {
        /* no changelog */
      }

      const hasUpdate = latestVersion !== currentVersion;
      return json({ currentVersion, latestVersion, hasUpdate, changelog });
    } catch (err: any) {
      return json({ error: err.message }, 500);
    }
  }

  // POST /api/actions/update — git pull + npm install + tsc + restart
  if (method === 'POST' && pathname === '/api/actions/update') {
    logger.info(MODULE, 'System update requested via dashboard');
    const steps: string[] = [];
    try {
      // Step 1: git fetch + reset
      steps.push('> git fetch origin main');
      execSync('git fetch origin main --quiet', { cwd: process.cwd(), timeout: 30000 });
      steps.push('OK');

      steps.push('> git reset --hard origin/main');
      const resetOut = execSync('git reset --hard origin/main', {
        cwd: process.cwd(),
        timeout: 10000,
      })
        .toString()
        .trim();
      steps.push(resetOut);

      // Step 2: npm install
      steps.push('> npm install');
      execSync('npm install', { cwd: process.cwd(), timeout: 120000 });
      steps.push('OK');

      // Step 3: tsc build
      steps.push('> npx tsc');
      execSync('npx tsc', { cwd: process.cwd(), timeout: 60000 });
      steps.push('OK');

      // Read new version
      delete require.cache[require.resolve('../../package.json')];
      const newPkg = require('../../package.json');
      steps.push(`\n更新完成: v${newPkg.version}`);
      steps.push('2 秒後自動重啟...');

      logger.info(MODULE, `Update complete: v${newPkg.version}, restarting...`);
      json({ ok: true, output: steps.join('\n') });

      // Restart after 2s (systemd will respawn)
      setTimeout(() => process.exit(0), 2000);
      return;
    } catch (err: any) {
      steps.push(`\nERROR: ${err.message}`);
      if (err.stderr) steps.push(err.stderr.toString().slice(0, 500));
      logger.error(MODULE, `Update failed: ${err.message}`);
      return json({ ok: false, output: steps.join('\n') }, 500);
    }
  }

  // POST /api/actions/manual-open — manually trigger copyOpenPosition for a missed/failed target
  if (method === 'POST' && pathname === '/api/actions/manual-open') {
    return readBody(req, async (body) => {
      const { targetNft, poolAddress, targetWallet, dex } = body;
      if (!targetNft || !poolAddress || !targetWallet)
        return json({ error: 'targetNft, poolAddress, targetWallet required' }, 400);
      try {
        const sig = await ctx.opQueue.executeNow(`manual-open(${targetNft.slice(0, 8)})`, () => {
          if (dex === 'orca' && ctx.orcaExecutor) {
            return ctx.orcaExecutor.copyOpenPosition(targetNft, poolAddress, targetWallet);
          }
          if (dex === 'meteora' && ctx.meteoraExecutor) {
            return ctx.meteoraExecutor.copyOpenPosition(targetNft, poolAddress, targetWallet);
          }
          if (dex === 'pancakeswap' && ctx.pcsExecutor) {
            return ctx.pcsExecutor.copyOpenPosition(targetNft, poolAddress, null, targetWallet);
          }
          if (dex === 'dammv2' && ctx.dammv2Executor) {
            return ctx.dammv2Executor.copyOpenPosition(targetNft, poolAddress, targetWallet);
          }
          return ctx.executor.copyOpenPosition(targetNft, poolAddress, null, targetWallet);
        });
        if (sig) {
          logger.info(MODULE, `Manual open done: ${targetNft.slice(0, 8)} TX: ${sig}`);
          return json({ ok: true, txSig: sig, message: '手動開倉成功' });
        }
        return json({ ok: false, message: '開倉未執行（執行器忙碌或失敗）' });
      } catch (err: any) {
        logger.error(MODULE, `Manual open error: ${err.message}`);
        return json({ ok: false, message: '開倉失敗: ' + err.message });
      }
    });
  }

  // POST /api/actions/claim-now — manual trigger for copy bonus claim
  if (method === 'POST' && pathname === '/api/actions/claim-now') {
    logger.info(MODULE, '手動領取複製獎勵觸發');
    claimCopyBonus()
      .then((result) => {
        if (result.error) {
          logger.warn(MODULE, `手動領取結果: ${result.error}`);
        } else {
          logger.info(
            MODULE,
            `手動領取完成: ${result.totalPools} pools, ${result.txSignatures.length} txs`,
          );
        }
      })
      .catch((err) => {
        logger.error(MODULE, `手動領取錯誤: ${err.message}`);
      });
    return json({ ok: true, message: '領取已觸發，請查看日誌' });
  }

  // POST /api/actions/close-position
  if (method === 'POST' && pathname === '/api/actions/close-position') {
    return readBody(req, async (body) => {
      const { ourNftMint } = body;
      if (!ourNftMint) return json({ error: 'ourNftMint required' }, 400);
      try {
        // Check which DEX this position belongs to
        const targetNft = ctx.positionMap.findByOurNft(ourNftMint);
        const dex = targetNft ? ctx.positionMap.getDex(targetNft) : undefined;
        const isOrca = dex === 'orca';
        const isMeteora = dex === 'meteora';
        const isPcs = dex === 'pancakeswap';
        const isDammv2 = dex === 'dammv2';

        const sig = await ctx.opQueue.executeNow(`manual-close(${ourNftMint.slice(0, 8)})`, () => {
          if (isOrca && ctx.orcaExecutor) {
            return ctx.orcaExecutor.manualClosePosition(ourNftMint);
          }
          if (isMeteora && ctx.meteoraExecutor) {
            return ctx.meteoraExecutor.manualClosePosition(ourNftMint);
          }
          if (isPcs && ctx.pcsExecutor) {
            return ctx.pcsExecutor.manualClosePosition(ourNftMint);
          }
          if (isDammv2 && ctx.dammv2Executor) {
            return ctx.dammv2Executor.manualClosePosition(ourNftMint);
          }
          return ctx.executor.manualClosePosition(ourNftMint);
        });
        if (sig) {
          logger.info(MODULE, `Manual close done: ${ourNftMint.slice(0, 8)}... TX: ${sig}`);
          return json({ ok: true, txSig: sig, message: '關倉成功' });
        }
        if (targetNft && !ctx.positionMap.findByOurNft(ourNftMint)) {
          return json({
            ok: true,
            message: 'Position already gone on-chain; local mapping removed',
          });
        }
        if (isOrca && !ctx.orcaExecutor) {
          return json({ ok: false, message: 'Orca 執行器未啟用，無法關閉 Orca 倉位' });
        }
        if (isMeteora && !ctx.meteoraExecutor) {
          return json({ ok: false, message: 'Meteora 執行器未啟用，無法關閉 Meteora 倉位' });
        }
        if (isPcs && !ctx.pcsExecutor) {
          return json({ ok: false, message: 'PancakeSwap 執行器未啟用，無法關閉 PCS 倉位' });
        }
        if (isDammv2 && !ctx.dammv2Executor) {
          return json({ ok: false, message: 'DAMM v2 執行器未啟用，無法關閉 DAMM v2 倉位' });
        }
        return json({ ok: false, message: '關倉未執行（執行器忙碌或無倉位）' });
      } catch (err: any) {
        logger.error(MODULE, `Manual close error: ${err.message}`);
        return json({ ok: false, message: '關倉失敗: ' + err.message });
      }
    });
  }

  // POST /api/actions/batch-close
  if (method === 'POST' && pathname === '/api/actions/batch-close') {
    return readBody(req, async (body) => {
      const { nftMints } = body;
      if (!Array.isArray(nftMints) || nftMints.length === 0)
        return json({ error: 'nftMints[] required' }, 400);
      if (nftMints.length > 50) return json({ error: '最多 50 個倉位' }, 400);

      const results: { nft: string; ok: boolean; txSig?: string; message: string }[] = [];
      for (const ourNft of nftMints) {
        try {
          const targetNft = ctx.positionMap.findByOurNft(ourNft);
          const dex = targetNft ? ctx.positionMap.getDex(targetNft) : undefined;
          const sig = await ctx.opQueue.executeNow(`batch-close(${ourNft.slice(0, 8)})`, () => {
            if (dex === 'orca' && ctx.orcaExecutor)
              return ctx.orcaExecutor.manualClosePosition(ourNft);
            if (dex === 'meteora' && ctx.meteoraExecutor)
              return ctx.meteoraExecutor.manualClosePosition(ourNft);
            if (dex === 'pancakeswap' && ctx.pcsExecutor)
              return ctx.pcsExecutor.manualClosePosition(ourNft);
            if (dex === 'dammv2' && ctx.dammv2Executor)
              return ctx.dammv2Executor.manualClosePosition(ourNft);
            return ctx.executor.manualClosePosition(ourNft);
          });
          if (!sig && targetNft && !ctx.positionMap.findByOurNft(ourNft)) {
            results.push({
              nft: ourNft,
              ok: true,
              message: 'Position already gone on-chain; local mapping removed',
            });
            continue;
          }
          if (sig) {
            logger.info(MODULE, `Batch close done: ${ourNft.slice(0, 8)}... TX: ${sig}`);
            results.push({ nft: ourNft, ok: true, txSig: sig, message: '關倉成功' });
          } else {
            results.push({ nft: ourNft, ok: false, message: '關倉未執行（忙碌或無倉位）' });
          }
        } catch (err: any) {
          logger.error(MODULE, `Batch close error for ${ourNft.slice(0, 8)}: ${err.message}`);
          results.push({ nft: ourNft, ok: false, message: err.message });
        }
      }
      const ok = results.filter((r) => r.ok).length;
      const fail = results.length - ok;
      return json({ ok: fail === 0, results, summary: `成功 ${ok} / 失敗 ${fail}` });
    });
  }

  // POST /api/actions/claim-all-byreal-fees — claim all LP fees + offchain rewards via Byreal API (matches webpage's 領取全部 flow)
  if (method === 'POST' && pathname === '/api/actions/claim-all-byreal-fees') {
    return readBody(req, async () => {
      try {
        logger.info(MODULE, '手動領取全部手續費觸發 (offchain API flow)');
        const conn = ctx.getConnection();
        const result = await ctx.opQueue.executeNow('claim-all-byreal-offchain', () =>
          claimLpFeesOffchain(conn),
        );
        const failCount = result.failures.length;
        const okCount = result.txSignatures.length;
        const tokenSummary = result.claimedTokens
          .map((t) => `${(t.amount / Math.pow(10, t.decimals)).toFixed(6)} ${t.symbol}`)
          .join(', ');
        logger.info(
          MODULE,
          `手動領取完成: ${okCount} txs 成功 / ${failCount} 失敗 — ${tokenSummary}`,
        );
        return json({
          ok: failCount === 0,
          totalItems: result.totalItems,
          txCount: okCount,
          failures: result.failures,
          claimedTokens: result.claimedTokens,
          summary:
            result.totalItems === 0
              ? '沒有可領取的手續費'
              : `${result.totalItems} 筆交易 (成功 ${okCount} / 失敗 ${failCount})${tokenSummary ? ' — ' + tokenSummary : ''}`,
        });
      } catch (err: any) {
        logger.error(MODULE, `手動領取失敗: ${err.message}`);
        return json({ ok: false, message: '領取失敗: ' + err.message }, 500);
      }
    });
  }

  // POST /api/actions/force-swap
  if (method === 'POST' && pathname === '/api/actions/force-swap') {
    return readBody(req, async (body) => {
      const { inputMint } = body;
      if (!inputMint) return json({ error: 'inputMint required' }, 400);
      const parsedBatchHighPrioritySeq = Number(body.batchHighPrioritySeq);
      const hasBatchHighPrioritySeq = Number.isFinite(parsedBatchHighPrioritySeq);
      const batchHighPrioritySeq = hasBatchHighPrioritySeq ? parsedBatchHighPrioritySeq : undefined;
      if (batchHighPrioritySeq !== undefined) {
        if (ctx.opQueue.hasHighPriorityActivityAfter(batchHighPrioritySeq)) {
          return json({
            ok: false,
            paused: true,
            message: 'Close/decrease work is pending; swap paused',
          });
        }
      } else if (ctx.opQueue.isHighPriorityRunningOrPending()) {
        return json({
          ok: false,
          paused: true,
          message: 'Close/decrease work is pending; swap paused',
        });
      }
      try {
        const result = await ctx.opQueue.enqueueWithResult(
          `force-swap(${inputMint.slice(0, 8)})`,
          'NORMAL',
          () => ctx.executor.swapTokenToUSDC(inputMint),
        );
        if (result) {
          ctx.executor.invalidateAssetCaches();
          logger.info(MODULE, `Force swap done: ${inputMint.slice(0, 8)}... TX: ${result.sig}`);
          // Same push the bot's own Jupiter path uses, so this route no longer
          // keeps a second copy of the history that could overwrite the first.
          pushSwap({
            ts: Date.now(),
            inputMint,
            txSig: result.sig,
            inputAmountRaw: result.amountRaw,
            outputAmountRaw: result.outputRaw,
          });
          return json({ ok: true, txSig: result.sig, message: '交換成功' });
        }
        return json({ ok: false, message: '交換未執行（餘額不足或被跳過）' });
      } catch (err: any) {
        logger.error(MODULE, `Force swap error: ${err.message}`);
        return json({ ok: false, message: '交換失敗: ' + err.message });
      }
    });
  }

  // GET /api/token-meta/:mint — proxy Jupiter V2 token metadata (avoids CORS)
  if (method === 'GET' && pathname.startsWith('/api/token-meta/')) {
    const mint = pathname.slice('/api/token-meta/'.length);
    if (!mint) return json({ error: 'Missing mint' }, 400);
    (async () => {
      try {
        const headers: Record<string, string> = {};
        if (config.jupApiKey) headers['x-api-key'] = config.jupApiKey;
        const jupRes = await fetch(`https://api.jup.ag/tokens/v2/search?query=${mint}`, {
          headers,
        });
        if (jupRes.ok) {
          const arr: any[] = (await jupRes.json()) as any;
          const t = arr?.[0];
          if (t && t.symbol) {
            // Cache for resolveTokenName/resolveLogoURI
            tokenInfoCache.set(mint, {
              symbol: t.symbol,
              decimals: t.decimals || 6,
              logoURI: t.icon || '',
            });
            return json({ symbol: t.symbol, logoURI: t.icon || '' });
          }
        }
      } catch {
        /* fall through */
      }
      json({ symbol: null, logoURI: '' });
    })();
    return;
  }

  // GET /api/pump-pending — poll Worker KV + return list (synchronous)
  if (method === 'GET' && pathname === '/api/pump-pending') {
    (async () => {
      await pollApprovals();
      json(getPumpPendingList());
    })();
    return;
  }

  // POST /api/pump-pending/test — simulate a pump token detection (dev/test only)
  if (method === 'POST' && pathname === '/api/pump-pending/test') {
    return readBody(req, (body) => {
      const { mint, symbol, pool, targetWallet } = body;
      if (!mint) return json({ error: 'Missing mint' }, 400);
      let sym = symbol;
      if (!sym) {
        try {
          const raw = fs.readFileSync('./data/token-names.json', 'utf-8');
          const cache = JSON.parse(raw);
          sym = cache[mint]?.symbol || mint;
        } catch {
          sym = mint;
        }
      }
      const pl = pool || mint + '/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
      addPumpPending({
        mint,
        symbol: sym,
        pool: pl,
        targetWallet: targetWallet || 'test',
        detectedAt: Date.now(),
      });
      queuePumpNotify(mint, sym, pl);
      logger.info(MODULE, `[TEST] Simulated pump token: ${mint}`);
      return json({ ok: true, mint });
    });
  }

  // POST /api/pump-pending/resolve — manually approve/reject from Dashboard
  if (method === 'POST' && pathname === '/api/pump-pending/resolve') {
    return readBody(req, (body) => {
      const { mint, action } = body;
      if (!mint || !['approved', 'rejected', 'delete'].includes(action)) {
        return json({ error: 'Missing mint or action (approved/rejected/delete)' }, 400);
      }
      if (action === 'delete') {
        deletePumpEntry(mint);
        logger.info(MODULE, `Pump entry ${mint} deleted via Dashboard`);
        return json({ ok: true, mint, action });
      }
      // Resolve symbol from pump-pending or token-names cache
      const pendingList = getPumpPendingList();
      const entry = pendingList.find((e) => e.mint === mint);
      let sym = entry?.symbol || '';
      if (!sym) {
        try {
          const raw = fs.readFileSync('./data/token-names.json', 'utf-8');
          const cache = JSON.parse(raw);
          sym = cache[mint]?.symbol || mint;
        } catch {
          sym = mint;
        }
      }
      resolvePump(mint, action);
      logger.info(MODULE, `Pump token ${sym} (${mint}) manually ${action} via Dashboard`);

      // Edit Discord notification message to show "已審批" (best effort, non-blocking)
      const workerUrl = (config as any).discordNotifyUrl?.replace('/notify', '') || '';
      const apiKey = (config as any).discordApiKey || '';
      if (workerUrl && apiKey) {
        const wallet = getUserAddress().toBase58();
        fetch(`${workerUrl}/pump-resolve/${wallet}/${mint}`, {
          method: 'POST',
          headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, symbol: sym }),
        }).catch((e: any) => logger.warn(MODULE, `Discord message edit failed: ${e.message}`));
      }

      return json({ ok: true, mint, action, symbol: sym });
    });
  }

  // -----------------------------------------------------------------------
  // DAC (Daily Auto-Convert) endpoints
  // -----------------------------------------------------------------------

  // GET /api/dac/status
  if (method === 'GET' && pathname === '/api/dac/status') {
    const history = getDacHistory();
    const last = history.length > 0 ? history[history.length - 1] : null;
    return json({
      enabled: config.dacEnabled,
      amountUsd: config.dacAmountUsd,
      thresholdMultiplier: config.dacThresholdMultiplier,
      executeHour: config.dacExecuteHour,
      executeMinute: config.dacExecuteMinute,
      transferTo: config.dacTransferTo,
      targetToken: config.dacTargetToken,
      targetSymbol: config.dacTargetSymbol,
      targetMint: config.dacTargetMint,
      tokenOptions: DAC_TOKEN_OPTIONS,
      cbbtcMint: config.dacCbbtcMint,
      xbtcMint: config.dacXbtcMint,
      nextScheduledTime: getDacNextScheduledTime(),
      lastRecord: last,
      totalRecords: history.length,
    });
  }

  // GET /api/dac/history
  if (method === 'GET' && pathname === '/api/dac/history') {
    return json(getDacHistory());
  }

  // POST /api/dac/config — update DAC settings
  if (method === 'POST' && pathname === '/api/dac/config') {
    return readBody(req, (body) => {
      const envUpdates: Record<string, string> = {};

      if (body.enabled !== undefined) {
        config.dacEnabled = !!body.enabled;
        envUpdates.DAC_ENABLED = String(config.dacEnabled);
      }
      if (body.amountUsd !== undefined) {
        const v = parseFloat(body.amountUsd);
        if (!isNaN(v) && v > 0) {
          config.dacAmountUsd = v;
          envUpdates.DAC_AMOUNT_USD = String(v);
        }
      }
      if (body.thresholdMultiplier !== undefined) {
        const v = parseFloat(body.thresholdMultiplier);
        if (!isNaN(v) && v > 0) {
          config.dacThresholdMultiplier = v;
          envUpdates.DAC_THRESHOLD_MULTIPLIER = String(v);
        }
      }
      if (body.executeHour !== undefined) {
        const v = parseInt(body.executeHour);
        if (!isNaN(v) && v >= 0 && v <= 23) {
          config.dacExecuteHour = v;
          envUpdates.DAC_EXECUTE_HOUR = String(v);
        }
      }
      if (body.executeMinute !== undefined) {
        const v = parseInt(body.executeMinute);
        if (!isNaN(v) && v >= 0 && v <= 59) {
          config.dacExecuteMinute = v;
          envUpdates.DAC_EXECUTE_MINUTE = String(v);
        }
      }
      if (body.transferTo !== undefined) {
        const addr = String(body.transferTo).trim();
        if (addr) {
          try {
            new PublicKey(addr);
          } catch {
            return json({ error: `Invalid Solana address: ${addr}` }, 400);
          }
        }
        config.dacTransferTo = addr;
        envUpdates.DAC_TRANSFER_TO = addr;
      }
      if (body.targetToken !== undefined) {
        const targetToken = normalizeDacTargetToken(body.targetToken);
        config.dacTargetToken = targetToken;
        envUpdates.DAC_TARGET_TOKEN = targetToken;
      }

      const needsReschedule =
        envUpdates.DAC_ENABLED !== undefined ||
        envUpdates.DAC_EXECUTE_HOUR !== undefined ||
        envUpdates.DAC_EXECUTE_MINUTE !== undefined;

      if (Object.keys(envUpdates).length > 0) {
        updateEnvFile(envUpdates);
        logger.info(MODULE, `DAC config updated: ${JSON.stringify(envUpdates)}`);
      }

      // Restart scheduler if schedule-related settings changed
      if (needsReschedule) {
        stopDacScheduler();
        startDacScheduler(ctx.getConnection());
      }

      return json({
        ok: true,
        config: {
          enabled: config.dacEnabled,
          amountUsd: config.dacAmountUsd,
          thresholdMultiplier: config.dacThresholdMultiplier,
          executeHour: config.dacExecuteHour,
          executeMinute: config.dacExecuteMinute,
          transferTo: config.dacTransferTo,
          targetToken: config.dacTargetToken,
          targetSymbol: config.dacTargetSymbol,
          targetMint: config.dacTargetMint,
        },
      });
    });
  }

  // POST /api/dac/trigger — manually trigger DAC (skip profit check)
  if (method === 'POST' && pathname === '/api/dac/trigger') {
    logger.info(MODULE, '手動觸發 DAC');
    const connection = ctx.getConnection();
    triggerDac(connection, true)
      .then((record) => {
        logger.info(MODULE, `手動 DAC 完成: ${record.status}`);
      })
      .catch((err) => {
        logger.error(MODULE, `手動 DAC 錯誤: ${err.message}`);
      });
    return json({ ok: true, message: 'DAC 已觸發，請查看日誌' });
  }

  // POST /api/actions/upgrade-signer — migrate from plaintext key to encrypted signer mode
  if (method === 'POST' && pathname === '/api/actions/upgrade-signer') {
    if (config.signerSocketPath) {
      return json({ ok: false, error: '已在簽名服務模式' }, 400);
    }
    if (!config.privateKey) {
      return json({ ok: false, error: '找不到 PRIVATE_KEY' }, 400);
    }

    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const { password } = JSON.parse(body);
        if (!password) return json({ ok: false, error: '請設定密碼' }, 400);

        const crypto = require('crypto');
        const signerDir = path.resolve(__dirname, '../../signer');
        const keyfilePath = path.join(signerDir, 'keyfile.enc.json');

        // Step 1: Encrypt the private key
        const salt = crypto.randomBytes(32);
        const iv = crypto.randomBytes(16);
        const key = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const enc = Buffer.concat([cipher.update(config.privateKey, 'utf-8'), cipher.final()]);
        const tag = cipher.getAuthTag();

        fs.writeFileSync(
          keyfilePath,
          JSON.stringify(
            {
              salt: salt.toString('hex'),
              iv: iv.toString('hex'),
              tag: tag.toString('hex'),
              data: enc.toString('hex'),
            },
            null,
            2,
          ),
        );
        logger.info(MODULE, 'Encrypted keyfile written');

        // Step 2: Update bot .env
        const envPath = path.resolve(__dirname, '../../.env');
        let envContent = fs.readFileSync(envPath, 'utf-8');

        // Remove PRIVATE_KEY line entirely
        envContent = envContent.replace(/^PRIVATE_KEY=.*\n?/m, '');

        // Add signer config if not present
        const wallet = getUserAddress().toBase58();
        if (!envContent.includes('WALLET_PUBLIC_KEY=')) {
          envContent += `\nWALLET_PUBLIC_KEY=${wallet}`;
        }
        if (!envContent.includes('SIGNER_SOCKET_PATH=')) {
          envContent += '\nSIGNER_SOCKET_PATH=/tmp/byreal-signer.sock';
        }
        if (!envContent.includes('SIGNER_UNLOCK_PORT=')) {
          envContent += '\nSIGNER_UNLOCK_PORT=3848';
        }

        fs.writeFileSync(envPath, envContent);
        logger.info(MODULE, 'Bot .env updated for signer mode');

        // Step 2b: Create signer .env (use Alchemy RPC for simulation, fall back to main RPC)
        const signerEnvPath = path.join(signerDir, '.env');
        const signerRpc = config.rpcUrl;
        const signerEnvContent = `# Signer Service — auto-generated by dashboard upgrade
SIGNER_RPC_URL=${signerRpc}
SIGNER_SOCKET_PATH=/tmp/byreal-signer.sock
SIGNER_UNLOCK_PORT=3848
SIGNER_DEST_WHITELIST=
SIGNER_LOG_LEVEL=info
`;
        fs.writeFileSync(signerEnvPath, signerEnvContent);
        logger.info(MODULE, 'Signer .env created');

        // Step 2c: Install signer's own node_modules (minimal deps, no DEX SDKs)
        try {
          execSync('npm install --silent', { cwd: signerDir, timeout: 60000 });
          logger.info(MODULE, 'Signer node_modules installed');
        } catch (err: any) {
          logger.warn(
            MODULE,
            `Signer npm install failed (will fall back to parent): ${err.message}`,
          );
        }

        // Step 3: Install systemd service
        try {
          const unitContent = `[Unit]
Description=Byreal TX Signer Service
After=network.target
Before=copybot.service

[Service]
Type=simple
User=${process.env.USER || 'solana'}
WorkingDirectory=${signerDir}
ExecStart=${signerDir}/start-signer.sh
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
`;
          execSync(
            `echo '${unitContent.replace(/'/g, "'\\''")}' | sudo tee /etc/systemd/system/byreal-signer.service > /dev/null`,
          );
          execSync('sudo systemctl daemon-reload');
          execSync('sudo systemctl enable byreal-signer');
          logger.info(MODULE, 'Signer systemd service installed');
        } catch (err: any) {
          logger.warn(MODULE, `Systemd setup failed (non-fatal): ${err.message}`);
        }

        // Step 4: Start signer, then restart bot
        try {
          execSync('sudo systemctl start byreal-signer');
          logger.info(MODULE, 'Signer service started');
        } catch (err: any) {
          logger.warn(MODULE, `Signer start failed: ${err.message}`);
        }

        json({ ok: true, message: '升級完成 — 簽名服務已啟動，Bot 即將重啟' });

        // Restart bot after response
        setTimeout(() => process.exit(0), 2000);
      } catch (err: any) {
        logger.error(MODULE, `Signer upgrade failed: ${err.message}`);
        json({ ok: false, error: err.message }, 500);
      }
    });
    return;
  }

  // GET /api/signer-status — check if signer service is running and unlocked
  if (method === 'GET' && pathname === '/api/signer-status') {
    if (!config.signerSocketPath) {
      return json({ enabled: false });
    }
    // Try connecting to the signer socket
    const net = require('net') as typeof import('net');
    const sock = net.createConnection(config.signerSocketPath);
    const timeout = setTimeout(() => {
      sock.destroy();
      json({ enabled: true, unlocked: false });
    }, 2000);
    sock.on('connect', () => {
      clearTimeout(timeout);
      sock.destroy();
      json({ enabled: true, unlocked: true });
    });
    sock.on('error', () => {
      clearTimeout(timeout);
      json({ enabled: true, unlocked: false });
    });
    return;
  }

  // POST /api/unlock-signer — proxy password to signer's unlock HTTP endpoint
  if (method === 'POST' && pathname === '/api/unlock-signer') {
    if (!config.signerSocketPath) {
      return json({ ok: false, error: 'Signer not enabled' }, 400);
    }
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', async () => {
      try {
        const unlockPort = parseInt(process.env.SIGNER_UNLOCK_PORT || '3848');
        const proxyRes = await fetch(`http://127.0.0.1:${unlockPort}/unlock`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        const result = await proxyRes.json();
        json(result, proxyRes.status);
      } catch (err: any) {
        json({ ok: false, error: '無法連線簽名服務 — 請確認 signer 已啟動' }, 502);
      }
    });
    return;
  }

  json({ error: 'Not found' }, 404);
}

// updateEnvFile moved to ../utils/env.ts

// --- Read JSON body ---
function readBody(req: http.IncomingMessage, cb: (body: any) => void): void {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      cb(body);
    } catch {
      cb({});
    }
  });
}
