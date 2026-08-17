/**
 * Shared plumbing for the end-to-end runs: build, start, drive, stop, report.
 *
 * Extracted when the second run (`run-m5.ts`) needed the same daemon lifecycle
 * as the first. None of it is milestone-specific — what a run contributes is its
 * environment and its checks — and two copies of "spawn the binary, feed it a
 * password, wait for the socket" would be two things to keep in step with the
 * daemon's startup sequence.
 *
 * The signing key is the fixed `[0x42; 32]` seed the fixtures were generated
 * with, so `ts_signed_b64` from `tx_vectors.json` is a usable oracle: bytes that
 * come back from the daemon can be compared against what `@solana/web3.js`
 * produced for the same transaction.
 */
import { spawn, spawnSync, ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { encryptKey } from '../../signer/crypto';
import { SignerResult } from './client';

export const WORKSPACE = path.resolve(__dirname, '..');
export const DAEMON_BIN = path.join(WORKSPACE, 'target', 'debug', 'signer-daemon');
export const FIXTURES = path.join(WORKSPACE, 'crates', 'signer-core', 'tests', 'fixtures');

/** Same throwaway seed as `crypto_vectors.json` and `tx_vectors.json`. */
const SIGNER_SEED = 0x42;
const PASSWORD = 'test-password-123';

const SOCKET_WAIT_MS = 30_000;

// ── Check bookkeeping ───────────────────────────────────────────────────────

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: CheckResult[] = [];

export async function check(name: string, run: () => Promise<string>): Promise<void> {
  try {
    const detail = await run();
    results.push({ name, passed: true, detail });
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, detail });
    console.log(`  FAIL  ${name}\n        ${detail.replace(/\n/g, '\n        ')}`);
  }
}

/** Prints the tally and sets a non-zero exit code if anything failed. */
export function report(): void {
  const failed = results.filter((result) => !result.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) {
    for (const result of failed) console.log(`  FAILED: ${result.name}`);
    process.exitCode = 1;
  }
}

export function expectEqual(actual: unknown, expected: unknown, what: string): void {
  if (actual === expected) return;

  if (typeof actual === 'string' && typeof expected === 'string') {
    let at = 0;
    while (at < actual.length && at < expected.length && actual[at] === expected[at]) at += 1;
    throw new Error(
      `${what} differs at index ${at} (got ${actual.length} chars, want ${expected.length})\n` +
        `  got:  …${actual.slice(Math.max(0, at - 12), at + 12)}…\n` +
        `  want: …${expected.slice(Math.max(0, at - 12), at + 12)}…`,
    );
  }
  throw new Error(`${what}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

export function expectRejected(result: SignerResult, expectedError: string): string {
  expectEqual(result.ok, false, 'ok');
  expectEqual(result.error, expectedError, 'error');
  return `error = ${JSON.stringify(expectedError)}`;
}

export function expectSigned(result: SignerResult, expectedTx: string, what: string): string {
  if (!result.ok) throw new Error(`signer rejected it: ${result.error}`);
  expectEqual(result.tx, expectedTx, what);
  return `${Buffer.from(expectedTx, 'base64').length} bytes, byte-identical`;
}

// ── Workspace ───────────────────────────────────────────────────────────────

export interface Workspace {
  /** Temp directory holding the keyfile and the socket; removed by `cleanup`. */
  dir: string;
  keyfilePath: string;
  socketPath: string;
  /** The wallet the daemon will sign with. */
  keypair: Keypair;
  cleanup: () => void;
}

/**
 * Writes a real encrypted keyfile with the TypeScript `encryptKey`.
 *
 * The daemon has to decrypt something the shipping implementation produced, not
 * a re-encoding of it — that is half of what these runs are for.
 */
export function prepareWorkspace(prefix: string, expectedPubkey?: string): Workspace {
  const keypair = Keypair.fromSeed(Uint8Array.from(new Array(32).fill(SIGNER_SEED)));
  if (expectedPubkey && keypair.publicKey.toBase58() !== expectedPubkey) {
    throw new Error(
      `seed 0x${SIGNER_SEED.toString(16)} derives ${keypair.publicKey.toBase58()}, ` +
        `but the fixtures were built with ${expectedPubkey}`,
    );
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const keyfilePath = path.join(dir, 'keyfile.enc.json');
  const socketPath = path.join(dir, 'sig.sock');

  fs.writeFileSync(
    keyfilePath,
    JSON.stringify(encryptKey(bs58.encode(keypair.secretKey), PASSWORD), null, 2),
    { mode: 0o600 },
  );

  console.log(`Wallet:  ${keypair.publicKey.toBase58()}`);
  console.log(`Keyfile: ${keyfilePath}`);
  console.log(`Socket:  ${socketPath}`);

  return {
    dir,
    keyfilePath,
    socketPath,
    keypair,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// ── Daemon lifecycle ────────────────────────────────────────────────────────

export function buildDaemon(): void {
  console.log('Building signer-daemon…');
  const build = spawnSync('cargo', ['build', '-p', 'signer-daemon'], {
    cwd: WORKSPACE,
    stdio: 'inherit',
  });
  if (build.status !== 0) {
    throw new Error(`cargo build failed with status ${build.status}`);
  }
}

export interface Daemon {
  process: ChildProcessWithoutNullStreams;
  stderr: () => string;
}

/**
 * Echoes a child stream line by line, holding back partial lines.
 *
 * A chunk boundary lands wherever the pipe buffer happens to fill, so splitting
 * each chunk on its own would tear log lines in half and make the transcript
 * look like the daemon emitted them that way.
 */
function tee(stream: NodeJS.ReadableStream, prefix: string): void {
  let pending = '';
  stream.on('data', (chunk: Buffer) => {
    const lines = (pending + chunk.toString()).split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) console.log(`  ${prefix} ${line}`);
    }
  });
  stream.on('end', () => {
    if (pending.trim()) console.log(`  ${prefix} ${pending}`);
  });
}

export interface DaemonOptions {
  workspace: Workspace;
  /** What the daemon should use as `SIGNER_RPC_URL`. */
  rpcUrl: string;
  /** Extra environment, e.g. `SIGNER_DEST_WHITELIST`. */
  env?: Record<string, string>;
}

/**
 * Starts the daemon and waits for its socket to appear.
 *
 * The built binary is spawned directly rather than through `cargo run`: killing
 * `cargo run` leaves the child it spawned alive, and an orphaned signer holding
 * the socket would poison every later run.
 *
 * The environment is built from nothing but these variables, and the daemon is
 * started inside the temp workspace, so no `.env` file on the machine running
 * this can reach it.
 */
export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const { workspace, rpcUrl, env = {} } = options;

  const child = spawn(DAEMON_BIN, {
    cwd: workspace.dir,
    env: {
      PATH: process.env.PATH,
      SIGNER_KEYFILE_PATH: workspace.keyfilePath,
      SIGNER_SOCKET_PATH: workspace.socketPath,
      SIGNER_RPC_URL: rpcUrl,
      SIGNER_UNLOCK_PORT: '0',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  tee(child.stderr, '[daemon]');
  tee(child.stdout, '[daemon:stdout]');

  let exited: number | null = null;
  child.on('exit', (code) => {
    exited = code ?? -1;
  });

  child.stdin.write(`${PASSWORD}\n`);
  child.stdin.end();

  const deadline = Date.now() + SOCKET_WAIT_MS;
  while (!fs.existsSync(workspace.socketPath)) {
    if (exited !== null) {
      throw new Error(`daemon exited with code ${exited} before binding\n${stderr}`);
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(
        `daemon did not bind ${workspace.socketPath} within ${SOCKET_WAIT_MS}ms\n${stderr}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return { process: child, stderr: () => stderr };
}

export function stopDaemon(daemon: Daemon): Promise<number | null> {
  return new Promise((resolve) => {
    if (daemon.process.exitCode !== null) {
      resolve(daemon.process.exitCode);
      return;
    }
    const kill = setTimeout(() => daemon.process.kill('SIGKILL'), 5_000);
    daemon.process.on('exit', (code) => {
      clearTimeout(kill);
      resolve(code);
    });
    daemon.process.kill('SIGTERM');
  });
}
