/**
 * Covers the metrics registry and the /health payload builder.
 *
 * Both are exercised through their public surface — the producers' hooks in,
 * the Prometheus registry out — rather than by booting an HTTP server. The
 * routes themselves are two thin adapters inside startDashboard()'s closure in
 * server.ts, which imports five DEX SDKs at module load; testing them at the
 * HTTP level would cost a full dashboard boot to assert on JSON that
 * buildHealth() already produces here.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { EventLogEntry } from '../src/dashboard/context';
import {
  isWsConnected,
  metricsText,
  observeSignerSign,
  recordEvent,
  register,
  setQueueDepthProvider,
  setWsConnected,
} from '../src/dashboard/metrics';
import { buildHealth } from '../src/dashboard/health';
import { pushEvent } from '../src/state/activity-log';
import { closePool } from '../src/state/db';

function event(over: Partial<EventLogEntry> = {}): EventLogEntry {
  return {
    ts: Date.now(),
    type: 'OPEN',
    targetWallet: 'TargetWallet1111111111111111111111111111111',
    success: true,
    ...over,
  };
}

/** One sample's value, or 0 when no series with those labels exists yet. */
async function sample(name: string, labels: Record<string, string> = {}): Promise<number> {
  const metrics = (await register.getMetricsAsJSON()) as any[];
  const metric = metrics.find((m) => m.name === name);
  const match = metric?.values.find((v: any) =>
    Object.entries(labels).every(([k, want]) => String(v.labels[k]) === want),
  );
  return match ? match.value : 0;
}

/** A histogram's derived series, e.g. `_count`, `_sum`, or a bucket. */
async function histogramValues(name: string): Promise<any[]> {
  const metrics = (await register.getMetricsAsJSON()) as any[];
  return metrics.find((m) => m.name === name)?.values ?? [];
}

beforeEach(() => {
  register.resetMetrics();
  setQueueDepthProvider(() => 0);
  setWsConnected(false);
});

afterAll(async () => {
  // buildHealth's db probe opens the shared pool when DATABASE_URL is set;
  // without this the vitest worker stays alive on the idle connection.
  await closePool();
});

describe('copybot_events_total', () => {
  it('counts an event under its type, dex and outcome', async () => {
    recordEvent(event({ type: 'OPEN', dex: 'byreal', success: true }));

    expect(
      await sample('copybot_events_total', { type: 'OPEN', dex: 'byreal', success: 'true' }),
    ).toBe(1);
  });

  it('keeps outcomes and DEXes on separate series', async () => {
    recordEvent(event({ type: 'CLOSE', dex: 'orca', success: true }));
    recordEvent(event({ type: 'CLOSE', dex: 'orca', success: false }));
    recordEvent(event({ type: 'CLOSE', dex: 'orca', success: false }));
    recordEvent(event({ type: 'CLOSE', dex: 'meteora', success: false }));

    expect(
      await sample('copybot_events_total', { type: 'CLOSE', dex: 'orca', success: 'true' }),
    ).toBe(1);
    expect(
      await sample('copybot_events_total', { type: 'CLOSE', dex: 'orca', success: 'false' }),
    ).toBe(2);
    expect(
      await sample('copybot_events_total', { type: 'CLOSE', dex: 'meteora', success: 'false' }),
    ).toBe(1);
  });

  it('labels DEX-less events rather than dropping them', async () => {
    // A SKIP never reaches a venue; it must still show up in the totals.
    recordEvent(event({ type: 'SKIP', success: false }));

    expect(
      await sample('copybot_events_total', { type: 'SKIP', dex: 'none', success: 'false' }),
    ).toBe(1);
  });
});

describe('event counter wiring', () => {
  it('counts an append made through the activity log, not just a direct hook call', async () => {
    // The store's write chain stays disabled until initActivityLog(), so this
    // exercises the real append path without needing a database.
    pushEvent(event({ type: 'INCREASE', success: true }), 'pancakeswap');

    // The dex label comes from pushEvent's own auto-tagging, which is what the
    // per-DEX wrapper in index.ts relies on.
    expect(
      await sample('copybot_events_total', {
        type: 'INCREASE',
        dex: 'pancakeswap',
        success: 'true',
      }),
    ).toBe(1);
  });
});

describe('copybot_queue_depth', () => {
  it('reads the registered provider at scrape time', async () => {
    let depth = 4;
    setQueueDepthProvider(() => depth);

    expect(await sample('copybot_queue_depth')).toBe(4);

    // The gauge is pull-based: a later scrape must see the new depth without
    // anything having pushed it.
    depth = 0;
    expect(await sample('copybot_queue_depth')).toBe(0);
  });
});

describe('copybot_signer_sign_seconds', () => {
  it('observes durations into count, sum and buckets', async () => {
    observeSignerSign(0.2);
    observeSignerSign(7);

    const values = await histogramValues('copybot_signer_sign_seconds');
    const count = values.find((v) => v.metricName === 'copybot_signer_sign_seconds_count');
    const sum = values.find((v) => v.metricName === 'copybot_signer_sign_seconds_sum');
    const fastBucket = values.find(
      (v) => v.metricName === 'copybot_signer_sign_seconds_bucket' && v.labels.le === 0.25,
    );

    expect(count.value).toBe(2);
    expect(sum.value).toBeCloseTo(7.2, 6);
    expect(fastBucket.value).toBe(1);
  });

  it('bounds the buckets at 10s so a hung signer lands in +Inf', async () => {
    observeSignerSign(25);

    const values = await histogramValues('copybot_signer_sign_seconds');
    const tenSec = values.find(
      (v) => v.metricName === 'copybot_signer_sign_seconds_bucket' && v.labels.le === 10,
    );
    const inf = values.find(
      (v) => v.metricName === 'copybot_signer_sign_seconds_bucket' && v.labels.le === '+Inf',
    );

    expect(tenSec.value).toBe(0);
    expect(inf.value).toBe(1);
  });
});

describe('copybot_ws_connected', () => {
  it('tracks the monitor socket state for both the gauge and /health', async () => {
    setWsConnected(true);
    expect(await sample('copybot_ws_connected')).toBe(1);
    expect(isWsConnected()).toBe(true);

    setWsConnected(false);
    expect(await sample('copybot_ws_connected')).toBe(0);
    expect(isWsConnected()).toBe(false);
  });
});

describe('metrics exposition', () => {
  it('renders the bot metrics and the default process metrics', async () => {
    recordEvent(event({ dex: 'byreal' }));
    observeSignerSign(0.3);
    const text = await metricsText();

    expect(text).toContain('copybot_events_total');
    expect(text).toContain('copybot_queue_depth');
    expect(text).toContain('copybot_signer_sign_seconds_bucket');
    expect(text).toContain('copybot_ws_connected');
    expect(text).toContain('process_cpu_seconds_total');
  });
});

describe('buildHealth', () => {
  it('returns the documented shape', async () => {
    const health = await buildHealth(Date.now() - 5_000);

    expect(Object.keys(health).sort()).toEqual([
      'db',
      'signer',
      'status',
      'uptime_s',
      'ws_connected',
    ]);
    expect(health.uptime_s).toBe(5);
    expect(['ok', 'error', 'off']).toContain(health.db);
  });

  it('reports a dependency the deployment does not use as off, not error', async () => {
    // SIGNER_SOCKET_PATH is unset under vitest, so the bot is in legacy mode.
    const health = await buildHealth(Date.now());

    expect(health.signer).toBe('off');
    if (!process.env.DATABASE_URL) expect(health.db).toBe('off');
  });

  it('is degraded while the target-wallet socket is down', async () => {
    setWsConnected(false);
    const health = await buildHealth(Date.now());

    expect(health.ws_connected).toBe(false);
    expect(health.status).toBe('degraded');
  });

  it('is ok once the socket is up and the database answers', async () => {
    setWsConnected(true);
    const health = await buildHealth(Date.now());

    expect(health.ws_connected).toBe(true);
    // 'off' when the suite runs without a database; 'ok' when global-setup
    // provided one. Either way the bot is not degraded.
    expect(health.db).not.toBe('error');
    expect(health.status).toBe('ok');
  });

  it('probes the database live when one is configured', async () => {
    if (!process.env.DATABASE_URL) return;

    const health = await buildHealth(Date.now());
    expect(health.db).toBe('ok');
  });
});
