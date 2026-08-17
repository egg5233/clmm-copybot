import assert from 'assert';
import BN from 'bn.js';

const { classifyByrealReconcilePosition } = require('../src/executor/reconcile-status') as typeof import('../src/executor/reconcile-status');

assert.deepStrictEqual(
  classifyByrealReconcilePosition(null, 'target'),
  { isOrphan: true, status: 'orphan', detail: 'target position returned null' },
);

assert.deepStrictEqual(
  classifyByrealReconcilePosition({ rawPositionInfo: { liquidity: new BN(0) } }, 'target'),
  { isOrphan: true, status: 'orphan', detail: 'target liquidity is zero' },
);

assert.deepStrictEqual(
  classifyByrealReconcilePosition({ rawPositionInfo: { liquidity: new BN(123) } }, 'target'),
  { isOrphan: false, status: 'active', detail: 'target liquidity=123' },
);

assert.deepStrictEqual(
  classifyByrealReconcilePosition(null, 'our'),
  { isOrphan: true, status: 'orphan', detail: 'our position returned null' },
);

assert.deepStrictEqual(
  classifyByrealReconcilePosition({ rawPositionInfo: { liquidity: new BN(0) } }, 'our'),
  { isOrphan: true, status: 'orphan', detail: 'our liquidity is zero' },
);
