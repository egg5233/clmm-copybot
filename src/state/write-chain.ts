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
 * A repository call that fails is logged and dropped. Letting it reject into
 * whatever the bot happened to be doing would turn a database hiccup into a
 * failed close, and the store rewrites the same row on its next mutation anyway.
 *
 * Writes stay disabled until enable() is called, which the stores do at the end
 * of their init(). A store that was never initialised — every unit test that
 * builds one — is then a plain in-memory structure instead of a source of
 * connection errors.
 */

import { logger } from '../utils/logger';

export class WriteChain {
  private tail: Promise<void> = Promise.resolve();
  private enabled = false;

  constructor(private readonly module: string) {}

  enable(): void {
    this.enabled = true;
  }

  /** Queue one repository call. `what` names the write in the error log. */
  push(what: string, write: () => Promise<void>): void {
    if (!this.enabled) return;
    this.tail = this.tail.then(write).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(this.module, `Could not persist ${what}: ${message}`);
    });
  }

  /** Resolves once every queued write has finished. For shutdown and for tests. */
  async drain(): Promise<void> {
    await this.tail;
  }
}
