/**
 * Write-through ordering for the Postgres-backed state stores.
 *
 * Each store keeps its authoritative copy in memory and serves every read from
 * it synchronously, exactly as the JSON-file version did. Persistence is a
 * consequence rather than a step: a mutation updates memory and hands the
 * matching repository call to this chain, which runs the queued calls one at a
 * time, in the order they were made. No trading path ever awaits a round trip to
 * the database.
 *
 * A repository call that fails is retried a few times with backoff (riding out
 * connection blips and restarts), then logged and dropped. Letting it reject
 * into whatever the bot happened to be doing would turn a database hiccup into
 * a failed close. Residual risk after the retries are exhausted: an upsert is
 * healed by the row's next mutation, but a dropped DELETE means the entry can
 * reappear after a restart — reconciliation audits are the backstop for that.
 *
 * Writes stay disabled until enable() is called, which the stores do at the end
 * of their init(). A store that was never initialised — every unit test that
 * builds one — is then a plain in-memory structure instead of a source of
 * connection errors.
 */

import { logger } from '../utils/logger';

const RETRY_DELAYS_MS = [500, 2000, 5000];

export class WriteChain {
  private tail: Promise<void> = Promise.resolve();
  private enabled = false;

  constructor(
    private readonly module: string,
    private readonly retryDelaysMs: readonly number[] = RETRY_DELAYS_MS,
  ) {}

  enable(): void {
    this.enabled = true;
  }

  /** Queue one repository call. `what` names the write in the error log. */
  push(what: string, write: () => Promise<void>): void {
    if (!this.enabled) return;
    this.tail = this.tail.then(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          await write();
          return;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          if (attempt >= this.retryDelaysMs.length) {
            logger.error(
              this.module,
              `Could not persist ${what} after ${attempt + 1} attempts, dropping: ${message}`,
            );
            return;
          }
          logger.warn(
            this.module,
            `Persist ${what} failed (attempt ${attempt + 1}), retrying: ${message}`,
          );
          await new Promise((r) => setTimeout(r, this.retryDelaysMs[attempt]));
        }
      }
    });
  }

  /** Resolves once every queued write has finished. For shutdown and for tests. */
  async drain(): Promise<void> {
    await this.tail;
  }
}
