/**
 * The bot's Prometheus registry.
 *
 * Everything here is a leaf: this module imports prom-client and nothing else
 * from the bot. The producers — the activity log, the operation queue, the
 * signer client, the WebSocket monitor — call into it, never the other way
 * round. That one-directional rule is what lets the signer client and the
 * monitor stay free of dashboard imports, and it keeps the registry importable
 * from a test without dragging five DEX SDKs along.
 *
 * The gauges come in two flavours. `copybot_ws_connected` is push-based: the
 * monitor knows the moment its socket opens or closes, so it sets the value.
 * `copybot_queue_depth` is pull-based: the queue never announces its own depth,
 * so a provider registered at startup is read during each scrape instead.
 */

import client, { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { EventLogEntry } from './context';

/** The registry `GET /metrics` serves. Separate from the global default one. */
export const register = new Registry();

client.collectDefaultMetrics({ register });

/**
 * Copied operations, by what happened and where.
 *
 * `type` is the parser's verb (OPEN/CLOSE/INCREASE/DECREASE/SWAP/SKIP), `dex`
 * the venue, `success` whether the mirror trade landed. Events that never reach
 * a DEX (a skip, a swap) carry `dex="none"` rather than being dropped, so the
 * counter totals match the event feed the dashboard renders.
 */
const eventsTotal = new Counter({
  name: 'copybot_events_total',
  help: 'Copy-trade events appended to the activity log, by type, DEX and outcome',
  labelNames: ['type', 'dex', 'success'] as const,
  registers: [register],
});

let queueDepthProvider: (() => number) | null = null;

// Underscore-prefixed because nothing reads the binding: the gauge is driven
// entirely by its own collect() hook, and the registry holds the reference.
const _queueDepth = new Gauge({
  name: 'copybot_queue_depth',
  help: 'Operations waiting in the executor queue (the running one is not counted)',
  registers: [register],
  collect() {
    if (queueDepthProvider) this.set(queueDepthProvider());
  },
});

/**
 * Round-trip time of one remote signing call.
 *
 * Bounded above by the signer client's own 30s socket timeout, so the +Inf
 * bucket is where a hung signer shows up. Legacy in-process signing is not
 * observed: it never leaves the process and has nothing to wait on.
 */
const signerSignSeconds = new Histogram({
  name: 'copybot_signer_sign_seconds',
  help: 'Time spent waiting for the remote signer to return a signed transaction',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

const wsConnected = new Gauge({
  name: 'copybot_ws_connected',
  help: 'Whether the target-wallet log subscription socket is open (1) or not (0)',
  registers: [register],
});

/** Mirrors the gauge so `/health` can report the same fact without a scrape. */
let wsConnectedState = false;

/** Count one activity-log append. Called from state/activity-log.ts. */
export function recordEvent(entry: EventLogEntry): void {
  eventsTotal.inc({
    type: entry.type,
    dex: entry.dex || 'none',
    success: String(entry.success),
  });
}

/** Register the function each scrape reads the queue depth from. */
export function setQueueDepthProvider(provider: () => number): void {
  queueDepthProvider = provider;
}

/** Observe one completed remote signing call. Called from utils/wallet.ts. */
export function observeSignerSign(seconds: number): void {
  signerSignSeconds.observe(seconds);
}

/** Record the monitor's socket state. Called from monitor/websocket.ts. */
export function setWsConnected(connected: boolean): void {
  wsConnectedState = connected;
  wsConnected.set(connected ? 1 : 0);
}

/** The last state the monitor reported. Read by the health endpoint. */
export function isWsConnected(): boolean {
  return wsConnectedState;
}

/** The registry rendered in Prometheus text format. */
export function metricsText(): Promise<string> {
  return register.metrics();
}

/** The content type Prometheus expects for the text exposition format. */
export const metricsContentType = register.contentType;
