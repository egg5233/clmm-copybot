/**
 * End-to-end checks for milestone M3 of the Rust signer.
 *
 * Builds a real encrypted keyfile with the TypeScript `encryptKey`, starts the
 * Rust daemon against it, and drives it over the Unix socket with the bot's own
 * client code (`client.ts`). The two signing checks compare the bytes that come
 * back against `ts_signed_b64` from the golden vectors — the exact output of
 * `@solana/web3.js` — so a pass means the Rust daemon is byte-for-byte
 * substitutable for `signer/index.ts` on those transactions, not merely that it
 * returned something plausible.
 *
 * Everything is offline and deterministic: the signing key comes from the fixed
 * `[0x42; 32]` seed the fixtures use, the transactions come from the fixtures,
 * and `SIGNER_RPC_URL` points at a port nothing listens on to prove the daemon
 * never dials it. The keyfile lives in a temp directory that is removed on the
 * way out, and the daemon is started there so no `.env` file on this machine can
 * reach it.
 *
 * Run from `signer-rs/`:  npx ts-node --project e2e/tsconfig.json e2e/run-m3.ts
 * Or from `signer-rs/e2e/`:  npm run e2e:m3
 */
import { spawn, spawnSync, ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { encryptKey } from '../../signer/crypto';
import { sendFrameExpectingClose, sendRawJson, signRequest, SignerResult } from './client';

// ── Fixed material ──────────────────────────────────────────────────────────

const WORKSPACE = path.resolve(__dirname, '..');
const DAEMON_BIN = path.join(WORKSPACE, 'target', 'debug', 'signer-daemon');
const VECTORS = path.join(
  WORKSPACE,
  'crates',
  'signer-core',
  'tests',
  'fixtures',
  'tx_vectors.json',
);

/** Same throwaway seed as `crypto_vectors.json` and `tx_vectors.json`. */
const SIGNER_SEED = 0x42;
const PASSWORD = 'test-password-123';

/** Nothing listens here. The daemon must not need an RPC to sign. */
const DEAD_RPC = 'http://127.0.0.1:1';

const SOCKET_WAIT_MS = 30_000;

interface TxVector {
  name: string;
  kind: 'legacy' | 'versioned';
  unsigned_b64: string;
  ts_signed_b64: string;
  description: string;
}

interface VectorFile {
  _fixed_material: { signer_pubkey: string };
  vectors: TxVector[];
}

// ── Check bookkeeping ───────────────────────────────────────────────────────

interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

const results: CheckResult[] = [];

async function check(name: string, run: () => Promise<string>): Promise<void> {
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

function expectEqual(actual: unknown, expected: unknown, what: string): void {
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

function expectRejected(result: SignerResult, expectedError: string): string {
  expectEqual(result.ok, false, 'ok');
  expectEqual(result.error, expectedError, 'error');
  return `error = ${JSON.stringify(expectedError)}`;
}

// ── Daemon lifecycle ────────────────────────────────────────────────────────

function buildDaemon(): void {
  console.log('Building signer-daemon…');
  const build = spawnSync('cargo', ['build', '-p', 'signer-daemon'], {
    cwd: WORKSPACE,
    stdio: 'inherit',
  });
  if (build.status !== 0) {
    throw new Error(`cargo build failed with status ${build.status}`);
  }
}

interface Daemon {
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

/**
 * Starts the daemon and waits for its socket to appear.
 *
 * The built binary is spawned directly rather than through `cargo run`: killing
 * `cargo run` leaves the child it spawned alive, and an orphaned signer holding
 * the socket would poison every later run.
 */
async function startDaemon(keyfilePath: string, socketPath: string, cwd: string): Promise<Daemon> {
  const child = spawn(DAEMON_BIN, {
    cwd,
    env: {
      PATH: process.env.PATH,
      SIGNER_KEYFILE_PATH: keyfilePath,
      SIGNER_SOCKET_PATH: socketPath,
      SIGNER_RPC_URL: DEAD_RPC,
      SIGNER_UNLOCK_PORT: '0',
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
  while (!fs.existsSync(socketPath)) {
    if (exited !== null) {
      throw new Error(`daemon exited with code ${exited} before binding\n${stderr}`);
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`daemon did not bind ${socketPath} within ${SOCKET_WAIT_MS}ms\n${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  return { process: child, stderr: () => stderr };
}

function stopDaemon(daemon: Daemon): Promise<number | null> {
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

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  buildDaemon();

  const fixture = JSON.parse(fs.readFileSync(VECTORS, 'utf-8')) as VectorFile;
  const vector = (name: string): TxVector => {
    const found = fixture.vectors.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`fixture vector ${name} is missing from ${VECTORS}`);
    return found;
  };

  // Same key the fixtures were signed with, so `ts_signed_b64` is the oracle.
  const keypair = Keypair.fromSeed(Uint8Array.from(new Array(32).fill(SIGNER_SEED)));
  if (keypair.publicKey.toBase58() !== fixture._fixed_material.signer_pubkey) {
    throw new Error(
      `seed 0x${SIGNER_SEED.toString(16)} derives ${keypair.publicKey.toBase58()}, ` +
        `but the fixtures were built with ${fixture._fixed_material.signer_pubkey}`,
    );
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'byreal-signer-m3-'));
  const keyfilePath = path.join(workDir, 'keyfile.enc.json');
  const socketPath = path.join(workDir, 'sig.sock');

  fs.writeFileSync(
    keyfilePath,
    JSON.stringify(encryptKey(bs58.encode(keypair.secretKey), PASSWORD), null, 2),
    { mode: 0o600 },
  );
  console.log(`Wallet:  ${keypair.publicKey.toBase58()}`);
  console.log(`Keyfile: ${keyfilePath}`);
  console.log(`Socket:  ${socketPath}\n`);

  const daemon = await startDaemon(keyfilePath, socketPath, workDir);
  console.log('\nChecks:');

  try {
    for (const name of ['v0_no_alt', 'legacy_spl_transfer']) {
      const tx = vector(name);
      await check(`${name} signs to the byte-identical web3.js output`, async () => {
        const result = await signRequest(socketPath, { type: tx.kind, tx: tx.unsigned_b64 });
        if (!result.ok) throw new Error(`signer rejected it: ${result.error}`);
        expectEqual(result.tx, tx.ts_signed_b64, 'signed transaction');
        return `${tx.kind}, ${Buffer.from(tx.ts_signed_b64, 'base64').length} bytes`;
      });
    }

    await check('a request with no type reports the TypeScript wording', async () =>
      expectRejected(
        await sendRawJson(socketPath, '{"tx":"AQID"}'),
        'Invalid request: missing type or tx',
      ),
    );

    await check('an unknown type is echoed back verbatim', async () =>
      expectRejected(
        await signRequest(socketPath, { type: 'bogus', tx: 'AQID' }),
        'Invalid type: bogus',
      ),
    );

    await check('a 70 KiB frame is refused and the server hangs up', async () => {
      const oversize = Buffer.alloc(70 * 1024, 0x78);
      const { result, serverClosed } = await sendFrameExpectingClose(socketPath, oversize);
      if (!result) throw new Error('the server closed without answering');
      expectRejected(result, 'Frame too large: 71680 bytes exceeds the 65536-byte limit');
      if (!serverClosed) throw new Error('the server left the connection open');
      return 'refused, then closed';
    });
  } finally {
    const code = await stopDaemon(daemon);
    console.log(`\nDaemon exited with code ${code} on SIGTERM.`);

    await check('SIGTERM unlinks the socket', async () => {
      if (fs.existsSync(socketPath)) throw new Error(`${socketPath} was left behind`);
      return 'socket removed';
    });

    fs.rmSync(workDir, { recursive: true, force: true });
  }

  const failed = results.filter((result) => !result.passed);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) {
    for (const result of failed) console.log(`  FAILED: ${result.name}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`\ne2e harness failed: ${err instanceof Error ? err.stack : err}`);
  process.exitCode = 1;
});
