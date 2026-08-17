/**
 * The payload behind `GET /health`.
 *
 * Kept out of server.ts so it can be exercised without booting the dashboard:
 * server.ts is a ~2700-line closure that pulls in every DEX SDK on import,
 * while this module needs only the config, the pg pool and the metrics state.
 *
 * Both dependency probes are live — a real `SELECT 1`, a real connect() to the
 * signer socket — because the failure this endpoint exists to catch is a
 * dependency that died while the bot kept running. Each is bounded at one
 * second so a hung dependency cannot hang the health check with it.
 */

import net from 'net';
import { config } from '../config';
import { query } from '../state/db';
import { isWsConnected } from './metrics';

/** How long either dependency probe may take before it counts as unreachable. */
const PROBE_TIMEOUT_MS = 1000;

/** `off` means "not configured for this deployment", not "broken". */
export type DependencyStatus = 'ok' | 'error' | 'off';

export interface HealthPayload {
  status: 'ok' | 'degraded';
  uptime_s: number;
  ws_connected: boolean;
  db: DependencyStatus;
  signer: DependencyStatus;
}

/** Reject with the given reason if `promise` has not settled in time. */
function withTimeout<T>(promise: Promise<T>, ms: number, reason: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(reason)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * `SELECT 1` against the shared pool.
 *
 * The pool's own connectionTimeoutMillis is 10s, which is the right patience
 * for a trade write and far too much for a health check, hence the outer bound.
 */
export async function checkDb(): Promise<DependencyStatus> {
  if (!process.env.DATABASE_URL) return 'off';
  try {
    await withTimeout(query('SELECT 1'), PROBE_TIMEOUT_MS, 'db probe timed out');
    return 'ok';
  } catch {
    return 'error';
  }
}

/**
 * Connect to the signer's Unix socket and hang up.
 *
 * Deliberately not a sign request: a health check must not ask the signer to
 * touch the key, and a daemon that accepts connections while locked is still
 * reachable. Reachability is all this reports.
 */
export function checkSigner(): Promise<DependencyStatus> {
  if (!config.signerSocketPath) return Promise.resolve('off');

  return new Promise<DependencyStatus>((resolve) => {
    let settled = false;
    const done = (status: DependencyStatus) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(status);
    };

    const sock = net.createConnection(config.signerSocketPath);
    sock.setTimeout(PROBE_TIMEOUT_MS, () => done('error'));
    sock.on('connect', () => done('ok'));
    sock.on('error', () => done('error'));
  });
}

/**
 * Probe every dependency and fold the results into one verdict.
 *
 * `degraded` means the bot is up but cannot do its job: a dead database loses
 * state, a closed socket means target trades are going unseen. A signer that is
 * down does not degrade the check — the bot in DRY_RUN or legacy mode has no
 * signer to reach, and `signer: "error"` is already in the payload for anyone
 * who cares.
 *
 * @param startedAt epoch ms the bot came up, from BotContext.startedAt
 */
export async function buildHealth(startedAt: number): Promise<HealthPayload> {
  const [db, signer] = await Promise.all([checkDb(), checkSigner()]);
  const ws_connected = isWsConnected();

  return {
    status: db === 'error' || !ws_connected ? 'degraded' : 'ok',
    uptime_s: Math.round((Date.now() - startedAt) / 1000),
    ws_connected,
    db,
    signer,
  };
}
