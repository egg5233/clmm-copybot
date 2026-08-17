import dotenv from 'dotenv';
import { PublicKey } from '@solana/web3.js';
import { parseWalletSet } from './utils/byreal-allow-same-tick';
import { parseMintSet } from './utils/pool-age-whitelist';

dotenv.config();

export type DacTargetToken = 'cbbtc' | 'xbtc';

export const DAC_TOKEN_OPTIONS: Record<DacTargetToken, { symbol: string; mint: string }> = {
  cbbtc: { symbol: 'cbBTC', mint: 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij' },
  xbtc: { symbol: 'xBTC', mint: 'CtzPWv73Sn1dMGVU3ZtLv9yWSyUAanBni19YWDaznnkn' },
};

export const MIN_SDK_PRIORITY_FEE_MICROLAMPORTS = 1;

export function normalizeDacTargetToken(value: unknown): DacTargetToken {
  const raw = String(value || '')
    .trim()
    .toLowerCase();
  return raw === 'xbtc' ? 'xbtc' : 'cbbtc';
}

export function normalizeByrealMaxOpenPositions(value: unknown): number {
  if (value === undefined || value === null) return 0;
  const raw = String(value).trim();
  if (raw.length === 0) return 0;
  if (!/^\d+$/.test(raw)) return 0;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

/**
 * The Postgres URL, demanded at the point the state stores are initialised
 * rather than at import time: the unit tests import this module without a
 * database and must keep doing so.
 */
export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. The bot keeps its positions, event log, swap history and ' +
        'pending swaps in Postgres, so it cannot start without one. Start the bundled ' +
        'database with `docker compose up -d postgres` (see docker-compose.yml), apply the ' +
        'schema with `npm run migrate`, then copy the DATABASE_URL line from .env.example ' +
        'into your .env — or point it at a Postgres server you already run.',
    );
  }
  return url;
}

// Parse TARGET_WALLETS with optional per-wallet ratio suffix: "WalletA:0.5,WalletB,WalletC:1.5"
// Base58 addresses never contain ':', so ':' is a safe delimiter.
function parseTargetWallets(raw: string): { wallets: PublicKey[]; ratios: Map<string, number> } {
  const ratios = new Map<string, number>();
  const wallets = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const colonIdx = s.lastIndexOf(':');
      if (colonIdx > 0) {
        const addr = s.slice(0, colonIdx).trim();
        const ratio = parseFloat(s.slice(colonIdx + 1).trim());
        if (!isNaN(ratio) && ratio > 0) ratios.set(addr, ratio);
        return new PublicKey(addr);
      }
      return new PublicKey(s);
    });
  return { wallets, ratios };
}

const { wallets: parsedTargetWallets, ratios: parsedWalletRatios } = parseTargetWallets(
  process.env.TARGET_WALLETS || requireEnv('BOT2_WALLET'),
);

const { wallets: parsedOrcaTargetWallets, ratios: parsedOrcaWalletRatios } = parseTargetWallets(
  process.env.ORCA_TARGET_WALLETS || '',
);

const { wallets: parsedMeteoraTargetWallets, ratios: parsedMeteoraWalletRatios } =
  parseTargetWallets(process.env.METEORA_TARGET_WALLETS || '');

const { wallets: parsedPcsTargetWallets, ratios: parsedPcsWalletRatios } = parseTargetWallets(
  process.env.PCS_TARGET_WALLETS || '',
);

const { wallets: parsedDammv2TargetWallets, ratios: parsedDammv2WalletRatios } = parseTargetWallets(
  process.env.DAMMV2_TARGET_WALLETS || '',
);

export const config = {
  // Wallet — PRIVATE_KEY is optional when using the signer service
  privateKey: process.env.PRIVATE_KEY || '',
  // Public key of the bot wallet (required when PRIVATE_KEY is absent, i.e. signer mode)
  walletPublicKey: process.env.WALLET_PUBLIC_KEY || '',
  // Signer service Unix socket path (empty = disabled, sign in-process)
  signerSocketPath: process.env.SIGNER_SOCKET_PATH || '',

  // RPC (Helius = WebSocket + send TX, Alchemy = read balance/TX)
  rpcUrl: requireEnv('RPC_URL'),
  wsUrl: requireEnv('WS_URL'),
  readRpcUrl: process.env.ALCHEMY_RPC_URL || '',
  // For per-position LP token price chart (comma-separated, used round-robin)
  rpcUrlsFree: (process.env.RPC_URL_FREE || 'https://api.mainnet-beta.solana.com')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0),

  // Monitor targets (parsed from TARGET_WALLETS with optional :ratio suffix)
  targetWallets: parsedTargetWallets,
  // Per-wallet amount ratio overrides; fallback to amountRatio when not set
  walletAmountRatios: parsedWalletRatios,

  // Close-only targets: only process CLOSE/DECREASE/SWAP, ignore OPEN/INCREASE
  closeOnlyWallets: new Set(
    (process.env.CLOSE_ONLY_WALLETS || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  ),

  // Strategy
  amountRatio: parseFloat(process.env.AMOUNT_RATIO || '1.0'),
  slippageBps: parseInt(process.env.SLIPPAGE_BPS || '200'),
  maxRetry: parseInt(process.env.MAX_RETRY || '3'),
  // Retained for Jupiter maxLamports / legacy Dashboard config only.
  // Pancake SDK local transactions use MIN_SDK_PRIORITY_FEE_MICROLAMPORTS.
  // Byreal local transactions intentionally use zero priority fee.
  priorityFeeLamports: parseInt(process.env.PRIORITY_FEE_LAMPORTS || '50000'),

  // Byreal
  byrealSkipSol: process.env.BYREAL_SKIP_SOL !== 'false', // default true
  byrealMaxOpenPositions: normalizeByrealMaxOpenPositions(process.env.BYREAL_MAX_OPEN_POSITIONS),
  byrealProgramId: new PublicKey(
    process.env.BYREAL_PROGRAM_ID || 'REALQqNEomY6cQGZJUGwywTBD2UmDT32rZcNnfxQ5N2',
  ),

  // Jupiter
  jupiterProgramId: new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'),
  jupiterApiBase: 'https://api.jup.ag/swap/v1',
  jupApiKey: process.env.JUP_API_KEY || '',
  jupSwapMode: (process.env.JUP_SWAP_MODE || 'ultra') as 'metis' | 'ultra',

  // Memo
  memoProgramId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),

  // Mode
  dryRun: process.env.DRY_RUN === 'true',
  allowSameWalletReopen: process.env.ALLOW_SAME_WALLET_REOPEN === 'true',
  skipSameTickRange: process.env.SKIP_SAME_TICK_RANGE === 'true',
  byrealAllowSameTickWallets: parseWalletSet(process.env.BYREAL_ALLOW_SAME_TICK_WALLETS || ''),
  byrealAllowOpenAfterOthersWallets: parseWalletSet(
    process.env.BYREAL_ALLOW_OPEN_AFTER_OTHERS_WALLETS || '',
  ),
  // Pump token filter: 'off' | 'full' (block all) | 'discord' (notify & approve)
  // Backward compat: if PUMP_FILTER_MODE not set, fall back to IGNORE_PUMP_TOKENS
  pumpFilterMode:
    (process.env.PUMP_FILTER_MODE as 'off' | 'full' | 'discord') ||
    (process.env.IGNORE_PUMP_TOKENS === 'true' ? 'full' : 'off'),
  minPoolAgeDays: parseInt(process.env.MIN_POOL_AGE_DAYS || '0'),
  poolAgeWhitelist: parseMintSet(process.env.POOL_AGE_WHITELIST || ''),
  skipPreflight: process.env.SKIP_PREFLIGHT === 'true',
  reconcileIntervalMinutes: parseFloat(process.env.RECONCILE_INTERVAL_MINUTES || '360'),

  // Coin concentration filter (0 = disabled)
  maxCoinConcentrationUsd: parseFloat(process.env.MAX_COIN_CONCENTRATION_USD || '0'),
  maxCoinConcentrationPct: parseFloat(process.env.MAX_COIN_CONCENTRATION_PCT || '0'),
  coinConcentrationOverrides: new Map<string, { usd: number; pct: number }>(), // loaded from file by server.ts

  // Pool TVL filter (0 = disabled)
  minPoolTvl: parseFloat(process.env.MIN_POOL_TVL || '0'),
  poolTvlWhitelist: new Set(
    (process.env.POOL_TVL_WHITELIST || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  ),
  poolTvlRefreshMinutes: parseFloat(process.env.POOL_TVL_REFRESH_MINUTES || '60'),
  tvlSource: (process.env.TVL_SOURCE || 'dex') as 'dex' | 'jupiter',

  // Risk management
  drawdownThresholdPct: parseFloat(process.env.DRAWDOWN_THRESHOLD_PCT || '20'),
  tokenLossStreakLimit: parseInt(process.env.TOKEN_LOSS_STREAK_LIMIT || '3'),
  tokenCooldownMinutes: parseInt(process.env.TOKEN_COOLDOWN_MINUTES || '60'),
  tokenBlacklist: new Set(
    (process.env.TOKEN_BLACKLIST || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  ),
  tokenWhitelist: new Set(
    (process.env.TOKEN_WHITELIST || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  ),

  // Auto-Claim
  autoClaimEnabled: process.env.AUTO_CLAIM_ENABLED === 'true',

  // DAC (Daily Auto-Convert to BTC)
  dacEnabled: process.env.DAC_ENABLED === 'true',
  dacAmountUsd: parseFloat(process.env.DAC_AMOUNT_USD || '10'),
  dacThresholdMultiplier: parseFloat(process.env.DAC_THRESHOLD_MULTIPLIER || '1'),
  dacExecuteHour: parseInt(process.env.DAC_EXECUTE_HOUR || '0'),
  dacExecuteMinute: parseInt(process.env.DAC_EXECUTE_MINUTE || '0'),
  dacTransferTo: process.env.DAC_TRANSFER_TO || '',
  dacTargetToken: normalizeDacTargetToken(process.env.DAC_TARGET_TOKEN),
  dacCbbtcMint: DAC_TOKEN_OPTIONS.cbbtc.mint,
  dacXbtcMint: DAC_TOKEN_OPTIONS.xbtc.mint,
  get dacTargetSymbol() {
    return DAC_TOKEN_OPTIONS[this.dacTargetToken].symbol;
  },
  get dacTargetMint() {
    return DAC_TOKEN_OPTIONS[this.dacTargetToken].mint;
  },

  // Dashboard
  dashboardPort: parseInt(process.env.DASHBOARD_PORT || '3847'),
  dashboardPassword: process.env.DASHBOARD_PASSWORD || '',
  dashboardIP: process.env.DASHBOARD_IP || '127.0.0.1',

  // Discord Notifications
  discordNotifyUrl: process.env.DISCORD_NOTIFY_URL || '',
  discordApiKey: process.env.DISCORD_API_KEY || '',

  // Orca Whirlpool
  orcaSkipSol: process.env.ORCA_SKIP_SOL !== 'false', // default true
  orcaProgramId: new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'),
  orcaTargetWallets: parsedOrcaTargetWallets,
  orcaWalletAmountRatios: parsedOrcaWalletRatios,
  orcaEnabled: parsedOrcaTargetWallets.length > 0,
  orcaCloseOnlyWallets: new Set(
    (process.env.ORCA_CLOSE_ONLY_WALLETS || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  ),

  // Meteora DLMM
  meteoraSkipSol: process.env.METEORA_SKIP_SOL !== 'false', // default true
  meteoraProgramId: new PublicKey('LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo'),
  meteoraTargetWallets: parsedMeteoraTargetWallets,
  meteoraWalletAmountRatios: parsedMeteoraWalletRatios,
  meteoraEnabled: parsedMeteoraTargetWallets.length > 0,
  meteoraCloseOnlyWallets: new Set(
    (process.env.METEORA_CLOSE_ONLY_WALLETS || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  ),

  // PancakeSwap CLMM (Raydium fork)
  pcsSkipSol: process.env.PCS_SKIP_SOL !== 'false', // default true
  pcsProgramId: new PublicKey('HpNfyc2Saw7RKkQd8nEL4khUcuPhQ7WwY1B2qjx8jxFq'),
  pcsTargetWallets: parsedPcsTargetWallets,
  pcsWalletAmountRatios: parsedPcsWalletRatios,
  pcsEnabled: parsedPcsTargetWallets.length > 0,
  pcsCloseOnlyWallets: new Set(
    (process.env.PCS_CLOSE_ONLY_WALLETS || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  ),

  // Meteora DAMM v2 (Constant Product AMM)
  dammv2SkipSol: process.env.DAMMV2_SKIP_SOL !== 'false', // default true
  dammv2ProgramId: new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG'),
  dammv2TargetWallets: parsedDammv2TargetWallets,
  dammv2WalletAmountRatios: parsedDammv2WalletRatios,
  dammv2Enabled: parsedDammv2TargetWallets.length > 0,
  dammv2CloseOnlyWallets: new Set(
    (process.env.DAMMV2_CLOSE_ONLY_WALLETS || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  ),

  // DATABASE_URL is deliberately absent here: src/state/db.ts reads it at
  // connect time and requireDatabaseUrl() validates it at store init, so a
  // frozen copy taken at import could only ever disagree with them.

  // Paths
  // Legacy JSON location. The bot no longer reads or writes it; it is where the
  // one-off importer looks for state to carry into Postgres.
  positionMapFile: process.env.POSITION_MAP_FILE || './data/position-map.json',
};
