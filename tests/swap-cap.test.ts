import { describe, expect, it } from 'vitest';

import { computeSwapCapRaw } from '../src/utils/ratio';

/**
 * Regression for the copied-swap sizing bug: a cap that scales to zero used to
 * become `undefined`, which the executor reads as "swap the full wallet
 * balance" — so a dust-sized target swap liquidated the bot's entire holding
 * of that token. Null now means "skip the swap".
 */
describe('computeSwapCapRaw', () => {
  it('scales a normal amount by the ratio', () => {
    expect(computeSwapCapRaw('1000000', 0.5)).toBe('500000');
    expect(computeSwapCapRaw('1000000', 1)).toBe('1000000');
    expect(computeSwapCapRaw('1000000', 5)).toBe('5000000');
  });

  it('returns null instead of an uncapped swap when the scaled amount is zero', () => {
    expect(computeSwapCapRaw('1', 0.5)).toBeNull(); // dust truncates to zero
    expect(computeSwapCapRaw('1000000', 0.00005)).toBeNull(); // sub-1bps ratio
    expect(computeSwapCapRaw('0', 1)).toBeNull();
  });

  it('returns null when the target amount is missing or unparseable', () => {
    expect(computeSwapCapRaw(undefined, 1)).toBeNull();
    expect(computeSwapCapRaw('', 1)).toBeNull();
  });

  it('truncates rather than rounds', () => {
    expect(computeSwapCapRaw('3', 0.5)).toBe('1');
  });
});
