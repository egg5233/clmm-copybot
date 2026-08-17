import assert from 'assert';
import { OperationQueue } from '../src/executor/queue';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 1000) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(message);
}

async function testEnqueueWithResultResolves(): Promise<void> {
  const queue = new OperationQueue();
  const result = await queue.enqueueWithResult('result-test', 'NORMAL', async () => 'ok');
  assert.strictEqual(result, 'ok');
}

async function testHighPriorityRunningOrPending(): Promise<void> {
  const queue = new OperationQueue();
  const holdNormal = deferred();
  const order: string[] = [];

  queue.enqueue('normal-running', 'NORMAL', async () => {
    order.push('normal-running');
    await holdNormal.promise;
  });
  await waitFor(() => order.includes('normal-running'), 'normal did not start');
  assert.strictEqual(queue.isHighPriorityRunningOrPending(), false);

  queue.enqueue('high-pending', 'HIGH', async () => {
    order.push('high-pending');
  });
  assert.strictEqual(queue.isHighPriorityRunningOrPending(), true);

  holdNormal.resolve();
  await waitFor(() => order.includes('high-pending'), 'high did not run');
}

async function testHighPrioritySequence(): Promise<void> {
  const queue = new OperationQueue();
  const seq = queue.getHighPrioritySeq();
  assert.strictEqual(queue.hasHighPriorityActivityAfter(seq), false);
  queue.enqueue('high-seq', 'HIGH', async () => {});
  assert.strictEqual(queue.hasHighPriorityActivityAfter(seq), true);
  await waitFor(() => queue.lastCompletedAt > 0, 'high seq item did not complete');
}

async function testHighOutranksPendingNormal(): Promise<void> {
  const queue = new OperationQueue();
  const holdFirst = deferred();
  const order: string[] = [];

  queue.enqueue('normal-1', 'NORMAL', async () => {
    order.push('normal-1');
    await holdFirst.promise;
  });
  await waitFor(() => order.includes('normal-1'), 'normal-1 did not start');

  queue.enqueue('normal-2', 'NORMAL', async () => {
    order.push('normal-2');
  });
  queue.enqueue('high-1', 'HIGH', async () => {
    order.push('high-1');
  });

  holdFirst.resolve();
  await waitFor(() => order.length === 3, 'queued items did not complete');
  assert.deepStrictEqual(order, ['normal-1', 'high-1', 'normal-2']);
}

async function main(): Promise<void> {
  await testEnqueueWithResultResolves();
  await testHighPriorityRunningOrPending();
  await testHighPrioritySequence();
  await testHighOutranksPendingNormal();
  console.log('queue-priority tests passed');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
