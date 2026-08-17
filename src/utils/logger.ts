import { EventEmitter } from 'events';

type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  module: string;
  message: string;
  data?: Record<string, unknown>;
}

const MAX_RECENT = 5000;
const recentLogs: LogEntry[] = [];
const logEmitter = new EventEmitter();
logEmitter.setMaxListeners(50);

function log(level: LogLevel, module: string, message: string, data?: Record<string, unknown>) {
  const entry: LogEntry = { ts: Date.now(), level, module, message, data };

  // Console output
  const line = `[${new Date(entry.ts).toISOString()}] [${level}] [${module}] ${message}`;
  if (data) {
    console.log(line, JSON.stringify(data));
  } else {
    console.log(line);
  }

  // Ring buffer
  recentLogs.push(entry);
  if (recentLogs.length > MAX_RECENT) recentLogs.shift();

  // Emit for dashboard WebSocket
  logEmitter.emit('log', entry);
}

export function getRecentLogs(): LogEntry[] {
  return recentLogs;
}

export { logEmitter };

export const logger = {
  info: (module: string, message: string, data?: Record<string, unknown>) =>
    log('INFO', module, message, data),
  warn: (module: string, message: string, data?: Record<string, unknown>) =>
    log('WARN', module, message, data),
  error: (module: string, message: string, data?: Record<string, unknown>) =>
    log('ERROR', module, message, data),
  debug: (module: string, message: string, data?: Record<string, unknown>) =>
    log('DEBUG', module, message, data),
};
