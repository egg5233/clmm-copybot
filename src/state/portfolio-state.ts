/**
 * Lightweight shared state for portfolio metrics.
 * Written by asset-trend.ts after each snapshot; read by byreal-position.ts
 * for the concentration filter — avoids circular import through server.ts.
 */

let _latestTotalUsd = 0;

export function setLatestTotalUsd(value: number): void {
  _latestTotalUsd = value;
}

export function getLatestTotalUsd(): number {
  return _latestTotalUsd;
}
