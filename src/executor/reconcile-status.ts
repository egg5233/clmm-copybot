import BN from 'bn.js';
import { ReconcileScanStatus } from './reconcile-log';

export interface ByrealReconcileTargetStatus {
  isOrphan: boolean;
  status: ReconcileScanStatus;
  detail: string;
}

export function classifyByrealReconcilePosition(
  position: { rawPositionInfo?: { liquidity?: BN } } | null,
  side: 'target' | 'our',
): ByrealReconcileTargetStatus {
  if (!position) {
    return { isOrphan: true, status: 'orphan', detail: `${side} position returned null` };
  }

  const liquidity = position.rawPositionInfo?.liquidity;
  if (liquidity && liquidity.isZero()) {
    return { isOrphan: true, status: 'orphan', detail: `${side} liquidity is zero` };
  }

  return {
    isOrphan: false,
    status: 'active',
    detail: liquidity ? `${side} liquidity=${liquidity.toString()}` : `${side} liquidity unknown`,
  };
}

export function classifyByrealReconcileTarget(
  position: { rawPositionInfo?: { liquidity?: BN } } | null,
): ByrealReconcileTargetStatus {
  return classifyByrealReconcilePosition(position, 'target');
}
