import { describe, expect, it } from 'vitest';

import { OperationQueue } from '../src/executor/queue';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
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

describe('OperationQueue priority handling', () => {
  it('resolves the operation result from enqueueWithResult', async () => {
    const queue = new OperationQueue();

    await expect(queue.enqueueWithResult('result-test', 'NORMAL', async () => 'ok')).resolves.toBe(
      'ok',
    );
  });

  it('reports high-priority work as running or pending only once it is queued', async () => {
    const queue = new OperationQueue();
    const holdNormal = deferred();
    const order: string[] = [];

    queue.enqueue('normal-running', 'NORMAL', async () => {
      order.push('normal-running');
      await holdNormal.promise;
    });
    await waitFor(() => order.includes('normal-running'), 'normal did not start');
    expect(queue.isHighPriorityRunningOrPending()).toBe(false);

    queue.enqueue('high-pending', 'HIGH', async () => {
      order.push('high-pending');
    });
    expect(queue.isHighPriorityRunningOrPending()).toBe(true);

    holdNormal.resolve();
    await waitFor(() => order.includes('high-pending'), 'high did not run');
  });

  it('advances the high-priority sequence when high-priority work is enqueued', async () => {
    const queue = new OperationQueue();
    const seq = queue.getHighPrioritySeq();

    expect(queue.hasHighPriorityActivityAfter(seq)).toBe(false);

    queue.enqueue('high-seq', 'HIGH', async () => {});
    expect(queue.hasHighPriorityActivityAfter(seq)).toBe(true);

    await waitFor(() => queue.lastCompletedAt > 0, 'high seq item did not complete');
  });

  it('runs high-priority work ahead of an already-pending normal item', async () => {
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
    expect(order).toEqual(['normal-1', 'high-1', 'normal-2']);
  });
});
