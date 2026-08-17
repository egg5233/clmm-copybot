import assert from 'assert';
import fs from 'fs';
import path from 'path';

process.env.RPC_URL ||= 'http://127.0.0.1:8899';
process.env.WS_URL ||= 'ws://127.0.0.1:8900';
process.env.BOT2_WALLET ||= '11111111111111111111111111111111';

const { ByrealPositionExecutor } = require('../src/executor/byreal-position') as typeof import('../src/executor/byreal-position');
const { diffByrealNftAudit } = require('../src/executor/byreal-nft-audit') as typeof import('../src/executor/byreal-nft-audit');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'executor', 'byreal-position.ts'), 'utf-8');
const auditStart = source.indexOf('  async auditByrealNftsOnChain()');
const estimateStart = source.indexOf('  /** Estimate how many positions can be opened', auditStart);
assert.ok(auditStart >= 0 && estimateStart > auditStart, 'legacy audit method body should be found');
const auditBody = source.slice(auditStart, estimateStart);
assert.ok(
  !auditBody.includes('queueImportedByrealAuditCloses') && !auditBody.includes('.enqueue('),
  'legacy auditByrealNftsOnChain should remain non-closing and should not enqueue close tasks',
);

const enqueued: { label: string; priority: string; fn: () => Promise<void> }[] = [];
const closed: string[] = [];
const queue = {
  enqueue(label: string, priority: 'HIGH' | 'NORMAL', fn: () => Promise<void>): string {
    enqueued.push({ label, priority, fn });
    return `q-${enqueued.length}`;
  },
};
const fakeExecutor = {
  manualClosePosition: async (nft: string): Promise<string> => {
    closed.push(nft);
    return `tx-${nft}`;
  },
};

const result = diffByrealNftAudit([], ['AuditNft111111111111111111111111111111111']);
result.importedToMapping.push('AuditNft111111111111111111111111111111111');

const updated = (ByrealPositionExecutor.prototype as any).queueImportedByrealAuditCloses.call(
  fakeExecutor,
  result,
  queue,
);

assert.deepStrictEqual(updated.closeQueued, ['AuditNft111111111111111111111111111111111']);
assert.deepStrictEqual(updated.enqueueFailed, []);
assert.strictEqual(enqueued.length, 1);
assert.strictEqual(enqueued[0].priority, 'NORMAL');
assert.ok(enqueued[0].label.includes('AuditNft'), 'queue label should include NFT prefix');

enqueued[0].fn().then(() => {
  assert.deepStrictEqual(closed, ['AuditNft111111111111111111111111111111111']);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
