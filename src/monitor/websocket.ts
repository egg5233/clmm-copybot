import { Connection, Logs, PublicKey } from '@solana/web3.js';
import { config } from '../config';
import { logger } from '../utils/logger';

const MODULE = 'WebSocket';

export type TxCallback = (signature: string, logs: string[], targetWallet: PublicKey) => Promise<void>;

export class WebSocketMonitor {
  private connection: Connection;
  private subscriptionIds: number[] = [];
  private retryCount = 0;
  private maxRetries = 20;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private callback: TxCallback | null = null;
  private lastEventTime = Date.now();
  private connectionListeners: ((conn: Connection) => void)[] = [];
  private reconnecting = false;

  constructor() {
    this.connection = new Connection(config.rpcUrl, {
      wsEndpoint: config.wsUrl,
      commitment: 'confirmed',
    });
  }

  getConnection(): Connection {
    return this.connection;
  }

  onConnectionChange(listener: (conn: Connection) => void): void {
    this.connectionListeners.push(listener);
  }

  async start(callback: TxCallback): Promise<void> {
    this.callback = callback;
    await this.subscribe();
    this.startHeartbeat();
    for (const w of this.getAllMonitoredWallets()) {
      const addr = w.toBase58();
      const tag = config.closeOnlyWallets.has(addr) ? ' [CLOSE-ONLY]' : '';
      logger.info(MODULE, `Monitoring wallet: ${addr}${tag}`);
    }
  }

  /** Build unique list of all wallets to monitor (targetWallets + closeOnlyWallets + orcaTargetWallets + orcaCloseOnlyWallets). */
  private getAllMonitoredWallets(): PublicKey[] {
    const seen = new Set<string>();
    const wallets: PublicKey[] = [];
    for (const w of config.targetWallets) {
      const addr = w.toBase58();
      if (!seen.has(addr)) { seen.add(addr); wallets.push(w); }
    }
    for (const addr of config.closeOnlyWallets) {
      if (!seen.has(addr)) { seen.add(addr); wallets.push(new PublicKey(addr)); }
    }
    // Orca target wallets
    for (const w of config.orcaTargetWallets) {
      const addr = w.toBase58();
      if (!seen.has(addr)) { seen.add(addr); wallets.push(w); }
    }
    for (const addr of config.orcaCloseOnlyWallets) {
      if (!seen.has(addr)) { seen.add(addr); wallets.push(new PublicKey(addr)); }
    }
    // Meteora target wallets
    for (const w of config.meteoraTargetWallets) {
      const addr = w.toBase58();
      if (!seen.has(addr)) { seen.add(addr); wallets.push(w); }
    }
    for (const addr of config.meteoraCloseOnlyWallets) {
      if (!seen.has(addr)) { seen.add(addr); wallets.push(new PublicKey(addr)); }
    }
    // PancakeSwap target wallets
    for (const w of config.pcsTargetWallets) {
      const addr = w.toBase58();
      if (!seen.has(addr)) { seen.add(addr); wallets.push(w); }
    }
    for (const addr of config.pcsCloseOnlyWallets) {
      if (!seen.has(addr)) { seen.add(addr); wallets.push(new PublicKey(addr)); }
    }
    // DAMM v2 target wallets
    for (const w of config.dammv2TargetWallets) {
      const addr = w.toBase58();
      if (!seen.has(addr)) { seen.add(addr); wallets.push(w); }
    }
    for (const addr of config.dammv2CloseOnlyWallets) {
      if (!seen.has(addr)) { seen.add(addr); wallets.push(new PublicKey(addr)); }
    }
    return wallets;
  }

  private async subscribe(): Promise<void> {
    try {
      // Remove existing subscriptions
      this.removeAllSubscriptions();

      // Subscribe to each monitored wallet (targets + close-only)
      const allWallets = this.getAllMonitoredWallets();
      for (const wallet of allWallets) {
        const subId = this.connection.onLogs(
          wallet,
          (logInfo: Logs) => {
            this.lastEventTime = Date.now();
            this.retryCount = 0;

            if (logInfo.err) {
              logger.debug(MODULE, `TX failed (skipping): ${logInfo.signature}`);
              return;
            }

            if (this.callback) {
              this.callback(logInfo.signature, logInfo.logs, wallet).catch(err => {
                logger.error(MODULE, `Callback error: ${err.message}`);
              });
            }
          },
          'confirmed',
        );
        this.subscriptionIds.push(subId);
      }

      logger.info(MODULE, `WebSocket subscriptions established (${this.subscriptionIds.length} wallets)`);
      this.retryCount = 0;
    } catch (err: any) {
      logger.error(MODULE, `Subscription failed: ${err.message}`);
      await this.reconnect();
    }
  }

  private removeAllSubscriptions(): void {
    for (const subId of this.subscriptionIds) {
      try {
        this.connection.removeOnLogsListener(subId);
      } catch { /* ignore */ }
    }
    this.subscriptionIds = [];
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting) {
      logger.debug(MODULE, 'Reconnect already in progress, skipping');
      return;
    }
    this.reconnecting = true;

    try {
      if (this.retryCount >= this.maxRetries) {
        logger.error(MODULE, `Max retries (${this.maxRetries}) reached. Exiting.`);
        process.exit(1);
      }

      this.retryCount++;
      const delay = Math.min(1000 * Math.pow(2, this.retryCount), 60000);
      const jitter = delay * 0.1 * Math.random();
      const totalDelay = Math.floor(delay + jitter);

      logger.warn(MODULE, `Reconnecting in ${totalDelay}ms (attempt ${this.retryCount}/${this.maxRetries})`);

      // Clean up all old subscriptions
      this.removeAllSubscriptions();

      await new Promise(resolve => setTimeout(resolve, totalDelay));

      // Create fresh connection
      this.connection = new Connection(config.rpcUrl, {
        wsEndpoint: config.wsUrl,
        commitment: 'confirmed',
      });

      for (const listener of this.connectionListeners) {
        listener(this.connection);
      }

      await this.subscribe();
    } finally {
      this.reconnecting = false;
    }
  }

  private startHeartbeat(): void {
    // Helius WS subscriptions can go zombie (no close event, but notifications stop).
    // @solana/web3.js only auto-reconnects on clean close, so we force a reconnect after
    // SILENCE_RECONNECT_MIN of silence. Check every 5 min.
    const SILENCE_RECONNECT_MIN = 20;
    this.heartbeatTimer = setInterval(() => {
      const silentMin = Math.floor((Date.now() - this.lastEventTime) / 60000);
      if (silentMin >= SILENCE_RECONNECT_MIN && !this.reconnecting) {
        logger.warn(MODULE, `No events for ${silentMin}min — forcing reconnect (zombie-sub guard)`);
        this.lastEventTime = Date.now();
        this.reconnect().catch(err => logger.error(MODULE, `Forced reconnect failed: ${err.message}`));
      } else if (silentMin >= 10) {
        logger.debug(MODULE, `No events for ${silentMin}min`);
      }
    }, 300_000);
  }

  /** Resubscribe after config changed (called from dashboard). */
  async resubscribe(): Promise<void> {
    const allWallets = this.getAllMonitoredWallets();
    logger.info(MODULE, `Resubscribing to ${allWallets.length} wallets...`);
    await this.subscribe();
    for (const w of allWallets) {
      const addr = w.toBase58();
      const tag = config.closeOnlyWallets.has(addr) ? ' [CLOSE-ONLY]' : '';
      logger.info(MODULE, `Monitoring wallet: ${addr}${tag}`);
    }
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.removeAllSubscriptions();
    logger.info(MODULE, 'WebSocket monitor stopped');
  }
}
