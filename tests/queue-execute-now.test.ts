import { describe, expect, it } from 'vitest';

import { OperationQueue } from '../src/executor/queue';

describe('OperationQueue.executeNow', () => {
  it('serializes two concurrent executeNow calls', async () => {
    const queue = new OperationQueue();
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];

    const op = (name: string, ms: number) => async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push(`start:${name}`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`end:${name}`);
      active--;
      return name;
    };

    // Both fired in the same tick — the regression was that both passed the
    // busy check together and ran concurrently.
    const [a, b] = await Promise.all([
      queue.executeNow('a', op('a', 120)),
      queue.executeNow('b', op('b', 30)),
    ]);

    expect(a).toBe('a');
    expect(b).toBe('b');
    expect(maxActive).toBe(1);
    // Whichever ran first must have ended before the other started.
    expect(order[1].startsWith('end:')).toBe(true);
  });

  it('is not starved by a queue backlog — runs after the current item, before pending ones', async () => {
    // Regression: the event-driven drain dequeued the next pending item before
    // the 200ms poller woke, so with a backlog executeNow waited for the whole
    // queue instead of just the current item.
    const queue = new OperationQueue();
    const order: string[] = [];

    queue.enqueue('A', 'HIGH', async () => {
      order.push('A');
      await new Promise((r) => setTimeout(r, 300));
    });
    queue.enqueue('B', 'HIGH', async () => {
      order.push('B');
    });
    await new Promise((r) => setTimeout(r, 50)); // let A start; B stays pending

    await queue.executeNow('immediate', async () => {
      order.push('immediate');
    });
    expect(order).toEqual(['A', 'immediate']);

    // Queue resumes afterwards: B still runs.
    await new Promise((r) => setTimeout(r, 400));
    expect(order).toEqual(['A', 'immediate', 'B']);
  });

  it('waits for a running queued item before executing', async () => {
    const queue = new OperationQueue();
    const order: string[] = [];

    queue.enqueue('queued', 'HIGH', async () => {
      order.push('queued:start');
      await new Promise((r) => setTimeout(r, 100));
      order.push('queued:end');
    });
    // Give the queued item time to start draining.
    await new Promise((r) => setTimeout(r, 20));

    await queue.executeNow('immediate', async () => {
      order.push('immediate');
    });

    expect(order).toEqual(['queued:start', 'queued:end', 'immediate']);
  });
});
