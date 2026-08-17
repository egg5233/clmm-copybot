import { logger } from '../utils/logger';
import { config } from '../config';

const MODULE = 'JupTvl';

// mint → { liquidity, fetchedAt }
const cache = new Map<string, { liquidity: number; fetchedAt: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 min
const NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min for "not found"
const BATCH_DELAY_MS = 50; // wait 50ms to collect concurrent requests into one batch
const CHUNK_SIZE = 30; // max mints per API call (URL length safe)
const CHUNK_INTERVAL_MS = 300; // 300ms between chunks to avoid 429

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Batch queue: concurrent callers are merged into one batch ───────────

interface PendingRequest {
  mint: string;
  resolve: (value: number | null) => void;
}

let pendingBatch: PendingRequest[] = [];
let batchTimer: ReturnType<typeof setTimeout> | null = null;

function enqueueMint(mint: string): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    pendingBatch.push({ mint, resolve });
    if (!batchTimer) {
      batchTimer = setTimeout(flushBatch, BATCH_DELAY_MS);
    }
  });
}

async function flushBatch(): Promise<void> {
  batchTimer = null;
  const batch = pendingBatch;
  pendingBatch = [];
  if (batch.length === 0) return;

  const mintSet = new Set(batch.map((b) => b.mint));
  const mints = Array.from(mintSet);

  try {
    const results = await fetchBulk(mints);
    for (const req of batch) {
      req.resolve(results.get(req.mint) ?? null);
    }
  } catch (err: any) {
    logger.warn(MODULE, `Batch fetch failed: ${err.message}`);
    for (const req of batch) {
      req.resolve(null);
    }
  }
}

/**
 * Fetch liquidity for multiple mints using comma-separated search query.
 * Splits into chunks of CHUNK_SIZE to stay within URL length limits.
 */
async function fetchBulk(mints: string[]): Promise<Map<string, number | null>> {
  const results = new Map<string, number | null>();
  const headers: Record<string, string> = {};
  if (config.jupApiKey) headers['x-api-key'] = config.jupApiKey;

  // Split into chunks
  const chunks: string[][] = [];
  for (let i = 0; i < mints.length; i += CHUNK_SIZE) {
    chunks.push(mints.slice(i, i + CHUNK_SIZE));
  }

  logger.debug(MODULE, `Fetching ${mints.length} mints in ${chunks.length} chunk(s)`);

  for (let c = 0; c < chunks.length; c++) {
    if (c > 0) await sleep(CHUNK_INTERVAL_MS);
    const chunk = chunks[c];
    const query = chunk.join(',');

    try {
      const res = await fetch(`https://api.jup.ag/tokens/v2/search?query=${query}`, { headers });

      if (res.status === 429) {
        await sleep(2000);
        const retry = await fetch(`https://api.jup.ag/tokens/v2/search?query=${query}`, {
          headers,
        });
        if (!retry.ok) {
          for (const m of chunk) results.set(m, null);
          continue;
        }
        parseResponse(await retry.text(), chunk, results);
        continue;
      }

      if (!res.ok) {
        logger.warn(MODULE, `API ${res.status} for chunk ${c + 1}`);
        for (const m of chunk) results.set(m, null);
        continue;
      }

      parseResponse(await res.text(), chunk, results);
    } catch (err: any) {
      logger.warn(MODULE, `Chunk ${c + 1} error: ${err.message}`);
      for (const m of chunk) results.set(m, null);
    }
  }

  return results;
}

function parseResponse(text: string, mints: string[], results: Map<string, number | null>): void {
  try {
    // Response may be NDJSON (multiple lines) — take first line
    const firstLine = text.split('\n')[0];
    const arr = JSON.parse(firstLine) as any[];
    if (!Array.isArray(arr)) {
      for (const m of mints) results.set(m, null);
      return;
    }

    const now = Date.now();
    const byId = new Map<string, any>();
    for (const t of arr) {
      if (t.id) byId.set(t.id, t);
    }

    for (const mint of mints) {
      const token = byId.get(mint);
      if (token && typeof token.liquidity === 'number' && token.liquidity >= 0) {
        cache.set(mint, { liquidity: token.liquidity, fetchedAt: now });
        results.set(mint, token.liquidity);
      } else {
        cache.set(mint, { liquidity: -1, fetchedAt: now });
        results.set(mint, null);
      }
    }
  } catch {
    for (const m of mints) results.set(m, null);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Fetch token liquidity from Jupiter API.
 * Concurrent callers are batched into comma-separated bulk queries.
 */
export async function getJupiterLiquidity(mint: string): Promise<number | null> {
  const cached = cache.get(mint);
  if (cached) {
    const ttl = cached.liquidity >= 0 ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;
    if (Date.now() - cached.fetchedAt < ttl) {
      return cached.liquidity >= 0 ? cached.liquidity : null;
    }
  }

  return enqueueMint(mint);
}

export function getJupiterLiquidityCached(mint: string): number | null {
  const cached = cache.get(mint);
  if (!cached || cached.liquidity < 0) return null;
  if (Date.now() - cached.fetchedAt > CACHE_TTL_MS) return null;
  return cached.liquidity;
}

export function getJupiterCacheInfo(): { size: number } {
  return { size: cache.size };
}
