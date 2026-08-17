import { Connection, PublicKey } from '@solana/web3.js';
import { WebSocketMonitor } from '../monitor/websocket';
import { ByrealPositionExecutor } from '../executor/byreal-position';
import { OrcaPositionExecutor } from '../executor/orca-position';
import { MeteoraPositionExecutor } from '../executor/meteora-position';
import { PcsPositionExecutor } from '../executor/pancakeswap-position';
import { DammV2PositionExecutor } from '../executor/dammv2-position';
import { PositionMap } from '../state/position-map';
import { OperationQueue } from '../executor/queue';

export interface EventLogEntry {
  ts: number;
  type: string;       // 'OPEN' | 'CLOSE' | 'INCREASE' | 'DECREASE' | 'SWAP' | 'SKIP'
  targetWallet: string;
  targetNft?: string;
  ourNft?: string;
  txSig?: string;
  success: boolean;
  error?: string;
  pool?: string;      // e.g. "mintA/mintB" — for OPEN/CLOSE/SWAP
  dex?: string;       // 'byreal' | 'orca' | 'meteora' | 'pancakeswap' | 'dammv2'
}

export interface SwapHistoryEntry {
  ts: number;
  inputMint: string;
  txSig: string;
  inputAmountRaw?: string;
  inputDecimals?: number;
  outputAmountRaw?: string; // USDC received (raw, 6 decimals)
}

export interface BotContext {
  monitor: WebSocketMonitor;
  executor: ByrealPositionExecutor;
  orcaExecutor: OrcaPositionExecutor | null;
  meteoraExecutor: MeteoraPositionExecutor | null;
  pcsExecutor: PcsPositionExecutor | null;
  dammv2Executor: DammV2PositionExecutor | null;
  positionMap: PositionMap;
  getConnection: () => Connection;

  // Runtime state
  opQueue: OperationQueue;

  // Disk-persisted event log & swap history
  eventLog: EventLogEntry[];
  swapHistory: SwapHistoryEntry[];

  // Uptime
  startedAt: number;
}
