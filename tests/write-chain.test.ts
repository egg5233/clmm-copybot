import { describe, expect, it } from 'vitest';

import { WriteChain } from '../src/state/write-chain';

function chain(): WriteChain {
  // Millisecond retry delays so the backoff path runs without slowing the suite.
  const c = new WriteChain('Test', [1, 1, 1]);
  c.enable();
  return c;
}

describe('WriteChain', () => {
  it('runs writes strictly in order', async () => {
    const c = chain();
    const seen: number[] = [];
    c.push('a', async () => {
      await new Promise((r) => setTimeout(r, 10));
      seen.push(1);
    });
    c.push('b', async () => {
      seen.push(2);
    });
    await c.drain();
    expect(seen).toEqual([1, 2]);
  });

  it('retries a failing write and succeeds without surfacing the failure', async () => {
    const c = chain();
    let attempts = 0;
    c.push('flaky', async () => {
      attempts++;
      if (attempts < 3) throw new Error('connection reset');
    });
    await c.drain();
    expect(attempts).toBe(3);
  });

  it('drops a write after exhausting retries and keeps the chain alive', async () => {
    const c = chain();
    let attempts = 0;
    let laterRan = false;
    c.push('doomed', async () => {
      attempts++;
      throw new Error('always fails');
    });
    c.push('later', async () => {
      laterRan = true;
    });
    await c.drain();
    expect(attempts).toBe(4); // 1 initial + 3 retries
    expect(laterRan).toBe(true);
  });

  it('does nothing before enable()', async () => {
    const c = new WriteChain('Test', [1]);
    let ran = false;
    c.push('ignored', async () => {
      ran = true;
    });
    await c.drain();
    expect(ran).toBe(false);
  });
});
