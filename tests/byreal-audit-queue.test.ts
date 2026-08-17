import { describe, expect, it } from 'vitest';

import { diffByrealNftAudit } from '../src/executor/byreal-nft-audit';
import { ByrealPositionExecutor } from '../src/executor/byreal-position';
import type { OperationQueue, QueuePriority } from '../src/executor/queue';

const AUDIT_NFT = 'AuditNft111111111111111111111111111111111';

type Enqueued = { label: string; priority: QueuePriority; fn: () => Promise<void> };

function recordingQueue(options: { failOnEnqueue?: boolean } = {}) {
  const enqueued: Enqueued[] = [];
  const queue = {
    enqueue(label: string, priority: QueuePriority, fn: () => Promise<void>): string {
      if (options.failOnEnqueue) throw new Error('queue is full');
      enqueued.push({ label, priority, fn });
      return `q-${enqueued.length}`;
    },
  };
  return { enqueued, queue: queue as unknown as OperationQueue };
}

function executorClosing(closed: string[]) {
  const executor = {
    manualClosePosition: async (nft: string): Promise<string> => {
      closed.push(nft);
      return `tx-${nft}`;
    },
  };
  return executor as unknown as ByrealPositionExecutor;
}

function queueImportedCloses(
  executor: ByrealPositionExecutor,
  result: ReturnType<typeof diffByrealNftAudit>,
  queue: OperationQueue,
) {
  return ByrealPositionExecutor.prototype.queueImportedByrealAuditCloses.call(
    executor,
    result,
    queue,
  );
}

describe('queueImportedByrealAuditCloses', () => {
  it('queues a NORMAL-priority close for each NFT imported into the mapping', () => {
    const result = diffByrealNftAudit([], [AUDIT_NFT]);
    result.importedToMapping.push(AUDIT_NFT);
    const { enqueued, queue } = recordingQueue();

    const updated = queueImportedCloses(executorClosing([]), result, queue);

    expect(updated.closeQueued).toEqual([AUDIT_NFT]);
    expect(updated.enqueueFailed).toEqual([]);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].priority).toBe('NORMAL');
    expect(enqueued[0].label).toContain(AUDIT_NFT.slice(0, 8));
  });

  it('closes the imported position when the queued task actually runs', async () => {
    const result = diffByrealNftAudit([], [AUDIT_NFT]);
    result.importedToMapping.push(AUDIT_NFT);
    const closed: string[] = [];
    const { enqueued, queue } = recordingQueue();

    queueImportedCloses(executorClosing(closed), result, queue);
    await enqueued[0].fn();

    expect(closed).toEqual([AUDIT_NFT]);
  });

  it('queues nothing for an audit that imported no NFTs, so a plain audit stays non-closing', () => {
    const result = diffByrealNftAudit(['MappedNft1111111111111111111111111111111'], [AUDIT_NFT]);
    const { enqueued, queue } = recordingQueue();

    const updated = queueImportedCloses(executorClosing([]), result, queue);

    expect(result.unmappedOnChain).toEqual([AUDIT_NFT]);
    expect(enqueued).toEqual([]);
    expect(updated.closeQueued).toEqual([]);
  });

  it('records an enqueue failure instead of throwing, so one bad NFT cannot abort the audit', () => {
    const result = diffByrealNftAudit([], [AUDIT_NFT]);
    result.importedToMapping.push(AUDIT_NFT);
    const { queue } = recordingQueue({ failOnEnqueue: true });

    const updated = queueImportedCloses(executorClosing([]), result, queue);

    expect(updated.closeQueued).toEqual([]);
    expect(updated.enqueueFailed).toEqual([{ nft: AUDIT_NFT, message: 'queue is full' }]);
  });
});
