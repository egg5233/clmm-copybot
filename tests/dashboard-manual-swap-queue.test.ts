import assert from 'assert';
import fs from 'fs';

function read(path: string): string {
  return fs.readFileSync(path, 'utf-8');
}

function blockBetween(source: string, start: string, end: string): string {
  const startIdx = source.indexOf(start);
  assert.notStrictEqual(startIdx, -1, `missing block start: ${start}`);
  const endIdx = source.indexOf(end, startIdx + start.length);
  assert.notStrictEqual(endIdx, -1, `missing block end after: ${start}`);
  return source.slice(startIdx, endIdx);
}

function assertBefore(source: string, first: string, second: string): void {
  const firstIdx = source.indexOf(first);
  const secondIdx = source.indexOf(second);
  assert.notStrictEqual(firstIdx, -1, `missing first marker: ${first}`);
  assert.notStrictEqual(secondIdx, -1, `missing second marker: ${second}`);
  assert(firstIdx < secondIdx, `${first} should appear before ${second}`);
}

const server = read('src/dashboard/server.ts');
const html = read('public/index.html');
const index = read('src/index.ts');

const forceSwapBlock = blockBetween(
  server,
  "pathname === '/api/actions/force-swap'",
  "// GET /api/token-meta/:mint",
);
assert(!forceSwapBlock.includes('executeNow'), 'force-swap must not use executeNow');
assert(forceSwapBlock.includes('enqueueWithResult'), 'force-swap must use enqueueWithResult');
assert(forceSwapBlock.includes("'NORMAL'"), 'force-swap must enqueue as NORMAL');
assert(forceSwapBlock.includes('swapTokenToUSDC'), 'force-swap must call swapTokenToUSDC');
assert(forceSwapBlock.includes('paused: true'), 'force-swap must return paused:true');
assert(forceSwapBlock.includes('ok: false'), 'force-swap must handle false/null result');
assert(forceSwapBlock.includes('isHighPriorityRunningOrPending()'), 'force-swap must check active/pending HIGH without snapshot');
assert(forceSwapBlock.includes('hasHighPriorityActivityAfter(batchHighPrioritySeq)'), 'force-swap must check HIGH activity after batch snapshot');
assert(forceSwapBlock.includes('Number.isFinite'), 'force-swap must validate batchHighPrioritySeq');
assertBefore(forceSwapBlock, 'ctx.executor.invalidateAssetCaches()', 'json({ ok: true');

const walletBalancesBlock = blockBetween(
  server,
  "pathname === '/api/wallet-balances'",
  "// GET /api/asset-breakdown",
);
assert(walletBalancesBlock.includes("url.searchParams.get('refresh') === '1'"), 'wallet balances must handle refresh=1');
assertBefore(walletBalancesBlock, 'ctx.executor.invalidateAssetCaches()', 'ctx.executor.getWalletTokenBalances()');

const queueSeqBlock = blockBetween(
  server,
  "pathname === '/api/queue/high-priority-seq'",
  "// GET /api/wallet-balances",
);
assert(queueSeqBlock.includes('ctx.opQueue.getHighPrioritySeq()'), 'queue seq route must return getHighPrioritySeq');
assert(queueSeqBlock.includes('highPriorityActive'), 'queue seq route must expose highPriorityActive');
assert(queueSeqBlock.includes('ctx.opQueue.isHighPriorityRunningOrPending()'), 'queue seq route must report HIGH activity');

assert(html.includes('loadWalletBalances(true)'), 'frontend must use forced wallet balance refresh');
assert(html.includes('/api/queue/high-priority-seq'), 'batch swap must fetch queue high-priority seq');
assert(html.includes('batchHighPrioritySeq'), 'batch swap must send batchHighPrioritySeq');
assert(html.includes('res.paused'), 'frontend must handle paused response');
assert(html.includes('res.ok === false'), 'frontend must handle ok:false response');
assert(html.includes('waitForBatchSwapResume'), 'batch swap must wait for priority work before resuming');
assert(!html.includes('pauseTimedOut'), 'batch swap must not timeout a selected mint just because close/decrease work is pending');

const batchSwapBlock = blockBetween(
  html,
  'function doBatchSwap()',
  '//  SWAP HISTORY',
);
const waitForResumeBlock = blockBetween(
  html,
  'async function waitForBatchSwapResume()',
  'function doBatchSwap()',
);
assert(!waitForResumeBlock.includes('attempt <'), 'batch swap resume wait must not have a finite attempt limit');
assert(!waitForResumeBlock.includes('return null'), 'batch swap resume wait must not give up and return null');
const pausedBranch = blockBetween(
  batchSwapBlock,
  'if (res && res.paused)',
  'if (res && res.ok)',
);
assert(pausedBranch.includes('waitForBatchSwapResume()'), 'paused branch must wait for HIGH queue to clear');
assert(pausedBranch.includes('batchHighPrioritySeq = resumeSeq'), 'paused branch must refresh batchHighPrioritySeq');
assert(pausedBranch.includes('i--'), 'paused branch must retry the same mint after resume');
assert(pausedBranch.includes('continue'), 'paused branch must continue the loop');
assert(!pausedBranch.includes('fail++'), 'paused branch must not count close/decrease waiting as a failed selected mint');
assert(!pausedBranch.includes('break'), 'paused branch must not end the whole batch');
const finalStatusBlock = blockBetween(
  batchSwapBlock,
  'if (fail === 0)',
  'confirmBtn.textContent',
);
assert(finalStatusBlock.includes("fail === 0"), 'final status must report success when resumed pauses finish cleanly');
assert(!finalStatusBlock.includes('if (paused)'), 'final status must not treat any resumed pause as still paused');
assert(!finalStatusBlock.includes('pauseTimedOut'), 'final status must not expose close/decrease wait timeout failure');

assert(index.includes('opQueue.enqueue('), 'src/index.ts should retain existing enqueue path');
assert(!index.includes('event-priority'), 'src/index.ts must not import event-priority');
assert(!index.includes('getEventQueuePriority'), 'src/index.ts must not call getEventQueuePriority');

console.log('dashboard-manual-swap-queue tests passed');
