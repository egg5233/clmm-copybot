import { describe, expect, it } from 'vitest';
import * as tokenPnl from '../../src/state/repo/tokenPnl';
import { canRunRepoTests, useTestDatabase } from './setup';

const MINT_A = 'So11111111111111111111111111111111111111112';
const MINT_B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe.skipIf(!canRunRepoTests)('tokenPnl repository', () => {
  useTestDatabase(['token_pnl']);

  it('round-trips a record', async () => {
    await tokenPnl.upsert(MINT_A, {
      totalPnl: -12.5,
      tradeCount: 3,
      lastLossPnl: -5.25,
      lastTradeAt: 1_700_000_000_000,
    });

    expect(await tokenPnl.get(MINT_A)).toEqual({
      totalPnl: -12.5,
      tradeCount: 3,
      lastLossPnl: -5.25,
      lastTradeAt: 1_700_000_000_000,
    });
  });

  it('returns undefined for an unknown mint', async () => {
    expect(await tokenPnl.get('nope')).toBeUndefined();
  });

  it('replaces the record on re-upsert', async () => {
    await tokenPnl.upsert(MINT_A, { totalPnl: 1, tradeCount: 1 });
    await tokenPnl.upsert(MINT_A, { totalPnl: 2, tradeCount: 2 });

    expect(await tokenPnl.get(MINT_A)).toEqual({ totalPnl: 2, tradeCount: 2 });
  });

  it('keys every record by mint', async () => {
    await tokenPnl.upsert(MINT_A, { totalPnl: 1 });
    await tokenPnl.upsert(MINT_B, { totalPnl: 2 });

    expect(await tokenPnl.all()).toEqual({
      [MINT_A]: { totalPnl: 1 },
      [MINT_B]: { totalPnl: 2 },
    });
  });

  it('lists with update timestamps', async () => {
    await tokenPnl.upsert(MINT_A, { totalPnl: 1 });

    const rows = await tokenPnl.list();
    expect(rows).toHaveLength(1);
    expect(rows[0].mint).toBe(MINT_A);
    expect(rows[0].updatedAt).toBeGreaterThan(0);
  });

  it('deletes one mint', async () => {
    await tokenPnl.upsert(MINT_A, { totalPnl: 1 });
    await tokenPnl.upsert(MINT_B, { totalPnl: 2 });

    await tokenPnl.delete(MINT_A);

    expect(await tokenPnl.get(MINT_A)).toBeUndefined();
    expect(await tokenPnl.get(MINT_B)).toEqual({ totalPnl: 2 });
  });

  it('keeps concurrent writers to different mints independent', async () => {
    const mints = Array.from({ length: 20 }, (_, i) => `mint${i}`);
    await Promise.all(mints.map((mint, i) => tokenPnl.upsert(mint, { totalPnl: i })));

    const all = await tokenPnl.all();
    expect(Object.keys(all)).toHaveLength(20);
    expect(all.mint7).toEqual({ totalPnl: 7 });
  });
});
