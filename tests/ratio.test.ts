import BN from 'bn.js';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { config } from '../src/config';
import { getAmountRatio, scaleAmount, scaleNumericAmount } from '../src/utils/ratio';

const WALLET_A = 'WalletAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const WALLET_B = 'WalletBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

describe('ratio', () => {
  let originalAmountRatio: number;
  let originalWalletRatios: [string, number][];

  beforeEach(() => {
    originalAmountRatio = config.amountRatio;
    originalWalletRatios = [...config.walletAmountRatios];
    config.walletAmountRatios.clear();
  });

  afterEach(() => {
    config.amountRatio = originalAmountRatio;
    config.walletAmountRatios.clear();
    for (const [k, v] of originalWalletRatios) config.walletAmountRatios.set(k, v);
  });

  describe('getAmountRatio', () => {
    it('falls back to the global ratio when no wallet is given', () => {
      config.amountRatio = 0.25;
      expect(getAmountRatio()).toBe(0.25);
    });

    it('prefers a per-wallet override over the global ratio', () => {
      config.amountRatio = 1.0;
      config.walletAmountRatios.set(WALLET_A, 0.5);

      expect(getAmountRatio(WALLET_A)).toBe(0.5);
    });

    it('falls back to the global ratio for a wallet with no override', () => {
      config.amountRatio = 2.0;
      config.walletAmountRatios.set(WALLET_A, 0.5);

      expect(getAmountRatio(WALLET_B)).toBe(2.0);
    });

    it('treats an empty wallet string as "no wallet" and skips the override lookup', () => {
      config.amountRatio = 2.0;
      config.walletAmountRatios.set('', 0.1);

      expect(getAmountRatio('')).toBe(2.0);
    });

    it('keeps per-wallet overrides independent of each other', () => {
      config.amountRatio = 1.0;
      config.walletAmountRatios.set(WALLET_A, 0.3);
      config.walletAmountRatios.set(WALLET_B, 1.75);

      expect(getAmountRatio(WALLET_A)).toBe(0.3);
      expect(getAmountRatio(WALLET_B)).toBe(1.75);
      expect(getAmountRatio()).toBe(1.0);
    });
  });

  describe('scaleAmount', () => {
    it('returns the exact same BN instance at ratio 1.0', () => {
      config.amountRatio = 1.0;
      const amount = new BN('123456789');

      expect(scaleAmount(amount)).toBe(amount);
    });

    it('halves the amount at ratio 0.5', () => {
      config.amountRatio = 0.5;

      expect(scaleAmount(new BN('1000000')).toString()).toBe('500000');
    });

    it('scales above 1.0 for wallets copied larger than the target', () => {
      config.amountRatio = 2.5;

      expect(scaleAmount(new BN(100)).toString()).toBe('250');
    });

    it('applies the per-wallet override', () => {
      config.amountRatio = 1.0;
      config.walletAmountRatios.set(WALLET_A, 0.25);

      expect(scaleAmount(new BN(1000), WALLET_A).toString()).toBe('250');
      expect(scaleAmount(new BN(1000), WALLET_B).toString()).toBe('1000');
    });

    it('scales zero to zero', () => {
      config.amountRatio = 0.5;

      expect(scaleAmount(new BN(0)).toString()).toBe('0');
    });

    it('truncates rather than rounds, so dust amounts collapse to zero', () => {
      config.amountRatio = 0.5;

      // 3 * 5000 / 10000 = 1.5 -> 1; 1 * 5000 / 10000 = 0.5 -> 0
      expect(scaleAmount(new BN(3)).toString()).toBe('1');
      expect(scaleAmount(new BN(1)).toString()).toBe('0');
    });

    it('truncates toward zero for negative amounts', () => {
      config.amountRatio = 0.5;

      // -101 * 5000 / 10000 = -50.5, truncated toward zero by BN.div
      expect(scaleAmount(new BN(-101)).toString()).toBe('-50');
    });

    it('silently zeroes the result when the ratio is finer than 1 bps', () => {
      // ratioBps = floor(0.00005 * 10000) = 0, so any amount scales to 0
      config.amountRatio = 0.00005;

      expect(scaleAmount(new BN('1000000000000')).toString()).toBe('0');
    });

    it('drops ratio precision below 1 bps instead of rounding it up', () => {
      // floor(0.12349 * 10000) = 1234 bps, not 1235
      config.amountRatio = 0.12349;

      expect(scaleAmount(new BN('10000')).toString()).toBe('1234');
    });

    it('keeps full precision on u64-scale amounts', () => {
      config.amountRatio = 0.5;

      // Exceeds Number.MAX_SAFE_INTEGER — proves BN math, not float math
      expect(scaleAmount(new BN('18446744073709551615')).toString()).toBe('9223372036854775807');
    });
  });

  describe('scaleNumericAmount', () => {
    it('floors even at ratio 1.0, unlike scaleAmount which short-circuits', () => {
      config.amountRatio = 1.0;

      expect(scaleNumericAmount(100.9)).toBe(100);
      expect(scaleAmount(new BN(100)).toString()).toBe('100');
    });

    it('scales and floors with the global ratio', () => {
      config.amountRatio = 0.5;

      expect(scaleNumericAmount(1000)).toBe(500);
      expect(scaleNumericAmount(1001)).toBe(500);
    });

    it('applies the per-wallet override', () => {
      config.amountRatio = 1.0;
      config.walletAmountRatios.set(WALLET_A, 0.1);

      expect(scaleNumericAmount(1000, WALLET_A)).toBe(100);
      expect(scaleNumericAmount(1000, WALLET_B)).toBe(1000);
    });

    it('floors float-multiplication error down to zero', () => {
      config.amountRatio = 0.3;

      // 3 * 0.3 === 0.8999999999999999 in IEEE-754
      expect(scaleNumericAmount(3)).toBe(0);
    });

    it('floors away from zero for negatives, diverging from scaleAmount', () => {
      config.amountRatio = 0.5;

      expect(scaleNumericAmount(-101)).toBe(-51);
      expect(scaleAmount(new BN(-101)).toString()).toBe('-50');
    });

    it('scales zero to zero', () => {
      config.amountRatio = 0.5;

      expect(scaleNumericAmount(0)).toBe(0);
    });

    it('does not use the raw ratio without the bps rounding scaleAmount applies', () => {
      // scaleNumericAmount multiplies by the raw ratio, so sub-bps precision survives
      config.amountRatio = 0.00005;

      expect(scaleNumericAmount(1_000_000)).toBe(50);
      expect(scaleAmount(new BN(1_000_000)).toString()).toBe('0');
    });
  });
});
