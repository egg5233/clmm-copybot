/**
 * Operation Queue — serializes all Solana write operations to prevent
 * concurrent TX conflicts. Single-threaded: only one operation runs at a time.
 *
 * Priority levels:
 * - HIGH: WS copy events (time-sensitive, must execute ASAP)
 * - NORMAL: reconcile orphan closes (can wait behind HIGH items)
 *
 * Special execution modes:
 * - executeNow(): Pauses queue draining, runs an operation immediately,
 *   then resumes. Used for dashboard manual-close where the
 *   frontend needs a synchronous response.
 *
 * Bypassed entirely:
 * - Read-only RPC calls (getWalletTokenBalances, balance checks)
 * - Auto-claim (Byreal HTTP API, no Solana RPC)
 */

import { logger } from '../utils/logger';

const MODULE = 'Queue';

export type QueuePriority = 'HIGH' | 'NORMAL';

export interface QueueItem {
  id: string;
  label: string;
  priority: QueuePriority;
  fn: () => Promise<void>;
  enqueuedAt: number;
}

export interface QueueStatus {
  running: QueueItem | null;
  pending: { id: string; label: string; priority: QueuePriority; enqueuedAt: number }[];
  immediateRunning: boolean;
}

export class OperationQueue {
  private highQueue: QueueItem[] = [];
  private normalQueue: QueueItem[] = [];
  private running: QueueItem | null = null;
  private immediateRunning = false;
  private draining = false;
  private idCounter = 0;
  private highPrioritySeq = 0;

  /** Enqueue an operation. HIGH priority items execute before NORMAL. */
  enqueue(label: string, priority: QueuePriority, fn: () => Promise<void>): string {
    const id = `q-${++this.idCounter}`;
    const item: QueueItem = { id, label, priority, fn, enqueuedAt: Date.now() };

    if (priority === 'HIGH') {
      this.highPrioritySeq += 1;
      this.highQueue.push(item);
    } else {
      this.normalQueue.push(item);
    }

    const totalPending = this.highQueue.length + this.normalQueue.length;
    logger.debug(MODULE, `Enqueued [${priority}] ${label} (id=${id}, pending=${totalPending})`);

    // Kick the drain loop if not already running
    this.scheduleDrain();

    return id;
  }

  /** Enqueue an operation and resolve/reject with its result when it runs. */
  enqueueWithResult<T>(label: string, priority: QueuePriority, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.enqueue(label, priority, async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (err) {
          reject(err);
          throw err;
        }
      });
    });
  }

  /**
   * Execute an operation immediately, bypassing the queue.
   * Waits for any currently running queued item to finish first,
   * then pauses queue draining, runs the operation, and resumes.
   *
   * Returns the operation's result. Used for manual-close
   * where the dashboard needs a synchronous response (TX signature).
   */
  async executeNow<T>(label: string, fn: () => Promise<T>): Promise<T> {
    // Wait for any currently running item to finish
    while (this.running) {
      logger.info(MODULE, `executeNow(${label}): waiting for running item "${this.running.label}" to finish...`);
      await new Promise(r => setTimeout(r, 200));
    }

    // Block queue draining while we run
    this.immediateRunning = true;
    logger.info(MODULE, `executeNow(${label}): executing immediately`);

    try {
      return await fn();
    } finally {
      this.immediateRunning = false;
      logger.debug(MODULE, `executeNow(${label}): done, resuming queue`);
      // Resume draining
      this.scheduleDrain();
    }
  }

  /** Get current queue status for dashboard display. */
  getStatus(): QueueStatus {
    const pending = [
      ...this.highQueue.map(i => ({ id: i.id, label: i.label, priority: i.priority, enqueuedAt: i.enqueuedAt })),
      ...this.normalQueue.map(i => ({ id: i.id, label: i.label, priority: i.priority, enqueuedAt: i.enqueuedAt })),
    ];
    return {
      running: this.running ? {
        id: this.running.id,
        label: this.running.label,
        priority: this.running.priority,
        fn: this.running.fn,
        enqueuedAt: this.running.enqueuedAt,
      } : null,
      pending,
      immediateRunning: this.immediateRunning,
    };
  }

  /** Total items waiting (not including currently running). */
  get pendingCount(): number {
    return this.highQueue.length + this.normalQueue.length;
  }

  /** Monotonic sequence that changes whenever a HIGH item is enqueued. */
  getHighPrioritySeq(): number {
    return this.highPrioritySeq;
  }

  /** Whether close/decrease priority work is currently running or waiting. */
  isHighPriorityRunningOrPending(): boolean {
    return this.running?.priority === 'HIGH' || this.highQueue.length > 0;
  }

  /** Whether HIGH work appeared after a caller's snapshot or is still active. */
  hasHighPriorityActivityAfter(seq: number): boolean {
    return this.highPrioritySeq > seq || this.isHighPriorityRunningOrPending();
  }

  /** Whether any operation (queued or immediate) is currently executing. */
  get isExecuting(): boolean {
    return this.running !== null || this.immediateRunning;
  }

  /** Timestamp (epoch ms) when the last operation completed, or 0 if none. */
  lastCompletedAt: number = 0;

  // --- Internal ---

  private scheduleDrain(): void {
    if (this.draining) return;
    setImmediate(() => this.drain());
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    try {
      while (this.highQueue.length > 0 || this.normalQueue.length > 0) {
        // Pause if an immediate operation is running
        if (this.immediateRunning) {
          break;
        }

        // Pick next item: HIGH first, then NORMAL
        const item = this.highQueue.length > 0
          ? this.highQueue.shift()!
          : this.normalQueue.shift()!;

        this.running = item;
        const waitMs = Date.now() - item.enqueuedAt;

        if (waitMs > 1000) {
          logger.info(MODULE, `Running [${item.priority}] ${item.label} (waited ${(waitMs / 1000).toFixed(1)}s)`);
        } else {
          logger.debug(MODULE, `Running [${item.priority}] ${item.label}`);
        }

        try {
          await item.fn();
        } catch (err: any) {
          logger.error(MODULE, `Queue item "${item.label}" threw: ${err.message}`);
        }

        this.running = null;
        this.lastCompletedAt = Date.now();
      }
    } finally {
      this.draining = false;
    }

    // Check if new items were added while we were finishing
    if ((this.highQueue.length > 0 || this.normalQueue.length > 0) && !this.immediateRunning) {
      this.scheduleDrain();
    }
  }
}
