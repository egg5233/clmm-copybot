/**
 * The token PnL store's write-through: reads answered from memory before the
 * row has landed, and a fresh boot finding what the last one wrote.
 */

import { describe, expect, it } from 'vitest';

import { tokenPnl } from '../src/state/repo';
import {
  allTokenPnl,
  countTokenPnl,
  flushTokenPnl,
  getTokenPnl,
  initTokenPnl,
  setTokenPnl,
} from '../src/state/token-pnl-store';
import { canRunRepoTests, useOwnTestDatabase } from './repo/setup';

describe.skipIf(!canRunRepoTests)('token PnL store', () => {
  useOwnTestDatabase('copybot_token_pnl_store', ['token_pnl']);

  it('serves a record from memory before the write has landed', async () => {
    await initTokenPnl();

    setTokenPnl('mint-a', { totalPnl: -4, tradeCount: 1 });

    // No await: recordTokenPnl() runs on the close path and must not wait on a
    // round trip.
    expect(getTokenPnl('mint-a')).toEqual({ totalPnl: -4, tradeCount: 1 });
    expect(countTokenPnl()).toBe(1);
    await flushTokenPnl();
  });

  it('reloads what it persisted', async () => {
    await initTokenPnl();
    setTokenPnl('mint-a', { totalPnl: -4, tradeCount: 1, lastTradeAt: 1_700_000_000_000 });
    setTokenPnl('mint-b', { totalPnl: 9.5, tradeCount: 2 });
    await flushTokenPnl();

    await initTokenPnl();

    expect(allTokenPnl()).toEqual({
      'mint-a': { totalPnl: -4, tradeCount: 1, lastTradeAt: 1_700_000_000_000 },
      'mint-b': { totalPnl: 9.5, tradeCount: 2 },
    });
  });

  it('replaces a record rather than merging into it', async () => {
    await initTokenPnl();
    setTokenPnl('mint-a', { totalPnl: -4, tradeCount: 1, lastLossPnl: -4 });
    setTokenPnl('mint-a', { totalPnl: 0, tradeCount: 2 });
    await flushTokenPnl();

    expect(await tokenPnl.get('mint-a')).toEqual({ totalPnl: 0, tradeCount: 2 });
  });

  it('hands out a copy, so the dashboard enriching its result cannot reach the store', async () => {
    await initTokenPnl();
    setTokenPnl('mint-a', { totalPnl: -4 });

    const enriched = allTokenPnl();
    enriched['mint-b'] = { symbol: 'BBB' };

    expect(countTokenPnl()).toBe(1);
    await flushTokenPnl();
  });
});
