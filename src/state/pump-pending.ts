import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';
import { updateEnvFile } from '../utils/env';
import { notifyPumpExpired } from '../discord/notify';

const MODULE = 'PumpPending';
const DATA_FILE = path.resolve('./data/pump-pending.json');
const EXPIRY_MS = 60 * 60 * 1000; // 1 hour

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PumpPendingEntry {
  mint: string;
  symbol: string;
  pool: string;
  targetWallet: string;
  detectedAt: number;
  status: 'pending' | 'approved' | 'rejected';
  notifiedAt?: number;
  resolvedAt?: number;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let pendingMap: Record<string, PumpPendingEntry> = {};

function loadFromDisk(): void {
  try {
    if (fs.existsSync(DATA_FILE)) {
      pendingMap = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    }
  } catch {
    logger.warn(MODULE, 'Could not load pump-pending.json, starting fresh');
    pendingMap = {};
  }
}

function saveToDisk(): void {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(pendingMap, null, 2));
  } catch (err: any) {
    logger.warn(MODULE, `Could not save pump-pending.json: ${err.message}`);
  }
}

// Load on module init
loadFromDisk();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function isPumpPending(mint: string): boolean {
  const entry = pendingMap[mint];
  if (!entry || entry.status !== 'pending') return false;
  // Auto-expire after 1h
  if (Date.now() - entry.detectedAt > EXPIRY_MS) return false;
  return true;
}

export function isPumpApproved(mint: string): boolean {
  return pendingMap[mint]?.status === 'approved';
}

export function isPumpRejected(mint: string): boolean {
  return pendingMap[mint]?.status === 'rejected';
}

export function addPumpPending(entry: Omit<PumpPendingEntry, 'status'>): void {
  pendingMap[entry.mint] = { ...entry, status: 'pending' };
  saveToDisk();
  logger.info(MODULE, `Added pending pump token: ${entry.symbol} (${entry.mint})`);
}

export function resolvePump(mint: string, status: 'approved' | 'rejected'): void {
  const entry = pendingMap[mint];
  if (!entry) return;
  entry.status = status;
  entry.resolvedAt = Date.now();
  saveToDisk();
  logger.info(MODULE, `Resolved pump token ${entry.symbol}: ${status}`);

  // Persist symbol to token-names.json so Dashboard can enrich blacklist/whitelist
  try {
    const tnFile = path.resolve('./data/token-names.json');
    const tnCache = fs.existsSync(tnFile) ? JSON.parse(fs.readFileSync(tnFile, 'utf-8')) : {};
    if (!tnCache[mint]) tnCache[mint] = {};
    tnCache[mint].symbol = entry.symbol;
    fs.writeFileSync(tnFile, JSON.stringify(tnCache));
  } catch { /* best effort */ }

  // Only rejected → blacklist. Approved stays in pump-pending state only
  // (isPumpApproved() check in byreal-position.ts handles trading logic)
  if (status === 'rejected') {
    config.tokenBlacklist.add(mint);
    config.tokenWhitelist.delete(mint);
    updateEnvFile({
      TOKEN_WHITELIST: Array.from(config.tokenWhitelist).join(','),
      TOKEN_BLACKLIST: Array.from(config.tokenBlacklist).join(','),
    });
  }
}

export function deletePumpEntry(mint: string): void {
  delete pendingMap[mint];
  saveToDisk();
  logger.info(MODULE, `Deleted pump entry: ${mint}`);
}

export function getPumpPendingList(): PumpPendingEntry[] {
  return Object.values(pendingMap);
}

// ---------------------------------------------------------------------------
// Poll Worker KV for Discord approval results (called by Dashboard API)
// ---------------------------------------------------------------------------

let pollerWallet = '';

export function setPumpPollerWallet(wallet: string): void {
  pollerWallet = wallet;
}

export async function pollApprovals(): Promise<void> {
  // Auto-expire pending entries older than 1h → treat as rejected + notify
  const now = Date.now();
  for (const [mint, entry] of Object.entries(pendingMap)) {
    if (entry.status === 'pending' && now - entry.detectedAt > EXPIRY_MS) {
      logger.info(MODULE, `Pump token ${entry.symbol} expired after 1h — auto-rejected`);
      resolvePump(mint, 'rejected');
      await notifyPumpExpired(mint, entry.symbol);
    }
  }

  const hasPending = Object.values(pendingMap).some(e => e.status === 'pending');
  if (!hasPending) return;

  const url = (config as any).discordNotifyUrl?.replace('/notify', '') || '';
  const apiKey = (config as any).discordApiKey || '';
  if (!url) return;

  try {
    const res = await fetch(`${url}/pump-approvals/${pollerWallet}`, {
      headers: { 'X-API-Key': apiKey },
    });
    if (!res.ok) {
      if (res.status !== 404) logger.warn(MODULE, `Poll failed: ${res.status}`);
      return;
    }
    const data = await res.json() as Record<string, { status: string; timestamp: number }>;

    for (const [mint, result] of Object.entries(data)) {
      const entry = pendingMap[mint];
      if (!entry || entry.status !== 'pending') continue;

      if (result.status === 'approved' || result.status === 'rejected') {
        if (result.timestamp && result.timestamp < entry.detectedAt) {
          logger.debug(MODULE, `Stale KV result for ${entry.symbol} (KV: ${result.timestamp} < detected: ${entry.detectedAt}), ignoring`);
          continue;
        }
        resolvePump(mint, result.status);
        logger.info(MODULE, `Discord approval: ${entry.symbol} → ${result.status}`);

        // Clean up KV entry
        try {
          await fetch(`${url}/pump-approvals/${pollerWallet}`, {
            method: 'DELETE',
            headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ mint }),
          });
        } catch { /* best effort */ }
      }
    }
  } catch (err: any) {
    logger.warn(MODULE, `Poll error: ${err.message}`);
  }
}
