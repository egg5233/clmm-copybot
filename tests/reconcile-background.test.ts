import assert from 'assert';
import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'executor', 'byreal-position.ts'), 'utf-8');
const indexSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf-8');
const configSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'config.ts'), 'utf-8');
const enqueueStart = source.indexOf('  enqueueReconcile(queue: OperationQueue): void {');
const closeOrphanStart = source.indexOf('  /** Close a single orphan position. */', enqueueStart);
assert.ok(enqueueStart >= 0 && closeOrphanStart > enqueueStart, 'enqueueReconcile block should be found');

const enqueueBody = source.slice(enqueueStart, closeOrphanStart);

const targetLookup = 'this.chain.getPositionInfoByNftMint(new PublicKey(tgtNft))';
const ourLookup = 'this.chain.getPositionInfoByNftMint(new PublicKey(ourNft))';
assert.ok(
  enqueueBody.includes(targetLookup),
  'background reconcile should check the mapped target NFT',
);
assert.ok(
  enqueueBody.includes(ourLookup),
  'background reconcile should check only the mapped our NFT after target is orphan',
);
assert.ok(
  enqueueBody.indexOf(ourLookup) > enqueueBody.indexOf(targetLookup),
  'mapped our NFT lookup should happen after target NFT lookup',
);

assert.ok(
  !enqueueBody.includes('getParsedTokenAccountsByOwner'),
  'background reconcile must not scan all wallet token accounts',
);

assert.ok(
  !enqueueBody.includes('auditByrealNftsOnChain'),
  'background reconcile must not run manual Byreal NFT audit',
);

assert.ok(
  !enqueueBody.includes('auditByrealNftsOnChainAndQueueClose'),
  'background reconcile must not run manual Byreal NFT audit with queued closes',
);

assert.ok(
  !enqueueBody.includes("status: 'checking'"),
  'background reconcile should not emit per-position checking logs',
);

const auditStart = source.indexOf('  async auditByrealNftsOnChain()');
assert.ok(auditStart > closeOrphanStart, 'manual Byreal NFT audit should remain available');
const auditBody = source.slice(auditStart);
assert.ok(
  auditBody.includes('this.chain.getPositionInfoByNftMint'),
  'manual Byreal NFT audit should remain the path that filters own NFTs on-chain',
);

assert.ok(
  configSource.includes("process.env.RECONCILE_INTERVAL_MINUTES || '360'"),
  'background reconcile interval should default to 360 minutes to reduce RPC usage',
);

assert.ok(
  indexSource.includes('config.reconcileIntervalMinutes') && indexSource.includes('reconcileIntervalMs'),
  'background reconcile timer should use the configurable reconcile interval',
);

assert.ok(
  !indexSource.includes('}, 30 * 60 * 1000);'),
  'background reconcile timer must not be hardcoded to 30 minutes',
);
