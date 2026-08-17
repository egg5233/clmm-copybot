import BN from 'bn.js';
import { config } from '../config';

/**
 * Returns the effective amount ratio for a given wallet.
 * Uses the per-wallet override if set, otherwise falls back to the global AMOUNT_RATIO.
 */
export function getAmountRatio(walletAddress?: string): number {
  if (walletAddress) {
    const perWallet = config.walletAmountRatios.get(walletAddress);
    if (perWallet !== undefined) return perWallet;
  }
  return config.amountRatio;
}

/**
 * Scale an amount by the effective ratio for the given wallet.
 * Default ratio=1.0 means 100% mirror (same amount as target).
 */
export function scaleAmount(amount: BN, walletAddress?: string): BN {
  const ratio = getAmountRatio(walletAddress);
  if (ratio === 1.0) return amount;
  // Multiply by ratio * 10000, then divide by 10000 for precision
  const ratioBps = Math.floor(ratio * 10000);
  return amount.mul(new BN(ratioBps)).div(new BN(10000));
}

/**
 * Scale a number amount (e.g. from Jupiter) by the effective ratio for the given wallet.
 */
export function scaleNumericAmount(amount: number, walletAddress?: string): number {
  return Math.floor(amount * getAmountRatio(walletAddress));
}
