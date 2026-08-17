import BN from 'bn.js';
import { describe, expect, it } from 'vitest';

import { classifyByrealReconcilePosition } from '../src/executor/reconcile-status';

describe('classifyByrealReconcilePosition', () => {
  describe('target side', () => {
    it('flags a null position as an orphan', () => {
      expect(classifyByrealReconcilePosition(null, 'target')).toEqual({
        isOrphan: true,
        status: 'orphan',
        detail: 'target position returned null',
      });
    });

    it('flags zero liquidity as an orphan', () => {
      expect(
        classifyByrealReconcilePosition({ rawPositionInfo: { liquidity: new BN(0) } }, 'target'),
      ).toEqual({
        isOrphan: true,
        status: 'orphan',
        detail: 'target liquidity is zero',
      });
    });

    it('reports non-zero liquidity as active', () => {
      expect(
        classifyByrealReconcilePosition({ rawPositionInfo: { liquidity: new BN(123) } }, 'target'),
      ).toEqual({
        isOrphan: false,
        status: 'active',
        detail: 'target liquidity=123',
      });
    });
  });

  describe('our side', () => {
    it('flags a null position as an orphan', () => {
      expect(classifyByrealReconcilePosition(null, 'our')).toEqual({
        isOrphan: true,
        status: 'orphan',
        detail: 'our position returned null',
      });
    });

    it('flags zero liquidity as an orphan', () => {
      expect(
        classifyByrealReconcilePosition({ rawPositionInfo: { liquidity: new BN(0) } }, 'our'),
      ).toEqual({
        isOrphan: true,
        status: 'orphan',
        detail: 'our liquidity is zero',
      });
    });
  });
});
