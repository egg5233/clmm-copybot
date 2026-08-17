/**
 * End-to-end checks for milestone M6 of the Rust signer: the unlock flow.
 *
 * M3 and M5 hand the daemon its password on stdin. This one starts it the way
 * systemd does — stdin is a pipe, not a terminal, and `SIGNER_UNLOCK_PORT` is
 * set — so the daemon comes up *locked*, serving nothing but a page on
 * 127.0.0.1 and waiting for someone to type the password into a browser.
 *
 * What is being pinned down is the observable contract of that page, because the
 * dashboard proxies it verbatim (`src/dashboard/server.ts`) and the page's own
 * JavaScript branches on the JSON bodies. Every status code, `Content-Type` and
 * body below is what `signer/index.ts:96-153` puts on the wire, and the page
 * itself is compared against the `UNLOCK_HTML` template literal read out of that
 * file at run time — a transcription slip in the Rust copy fails this run rather
 * than shipping a page that renders differently.
 *
 * Two things here have no TypeScript counterpart:
 *
 *   * Wrong passwords are rate limited, so the third refusal is measurably
 *     slower than the first.
 *   * The unlock port closes for good once the daemon is unlocked, rather than
 *     lingering as a password endpoint next to a signer that is already signing.
 *
 * The run ends by proving the unlock actually produced a signer: the socket
 * appears only after the correct password, and the key behind it signs the
 * `v0_no_alt` golden vector to the same bytes `@solana/web3.js` produced.
 *
 * Everything is offline. `SIGNER_RPC_URL` points at a dead port and the
 * fixtures' destination is whitelisted, exactly as in `run-m3.ts`.
 *
 * Run from `signer-rs/`:  npx ts-node --project e2e/tsconfig.json e2e/run-m6.ts
 * Or from `signer-rs/e2e/`:  npm run e2e:m6
 */
import fs from 'fs';
import http from 'http';
import net from 'net';
import path from 'path';
import { signRequest } from './client';
import {
  buildDaemon,
  check,
  Daemon,
  expectEqual,
  expectSigned,
  FIXTURES,
  PASSWORD,
  prepareWorkspace,
  report,
  spawnDaemon,
  stopDaemon,
  waitForSocket,
} from './harness';

const VECTORS = path.join(FIXTURES, 'tx_vectors.json');

/** The shipping signer, read for its unlock page rather than imported. */
const SIGNER_INDEX = path.resolve(__dirname, '..', '..', 'signer', 'index.ts');

/** Nothing listens here. An unreachable RPC must not change the outcome. */
const DEAD_RPC = 'http://127.0.0.1:1';

// The four JSON bodies, spelled exactly as `signer/index.ts` writes them:
// unescaped UTF-8, `ok` first, no spaces.
const UNLOCKED_BODY = '{"ok":true}'; // index.ts:126
const WRONG_PASSWORD_BODY = '{"ok":false,"error":"密碼錯誤 Wrong password"}'; // index.ts:134
const EMPTY_PASSWORD_BODY = '{"ok":false,"error":"請輸入密碼"}'; // index.ts:118
const INVALID_REQUEST_BODY = '{"ok":false,"error":"Invalid request"}'; // index.ts:138

/** A line of the page no other file in the repo contains. */
const DISTINCTIVE_ZH_TW = '輸入密碼以解鎖簽名服務';

/**
 * How much slower the third refusal must be than the first, in milliseconds.
 *
 * The backoff is 250ms then 500ms then 1s, so the real gap is ~750ms; scrypt
 * costs both attempts the same ~100ms and drops out of the difference. The
 * margin is deliberately loose — this is a check that the delay grows at all,
 * not a benchmark of a shared CI box.
 */
const BACKOFF_MARGIN_MS = 300;

interface TxVector {
  name: string;
  kind: 'legacy' | 'versioned';
  unsigned_b64: string;
  ts_signed_b64: string;
}

interface VectorFile {
  _fixed_material: { signer_pubkey: string; dest_ata: string };
  vectors: TxVector[];
}

// ── HTTP ────────────────────────────────────────────────────────────────────

interface HttpReply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  /** Round trip in milliseconds, which is what makes the backoff observable. */
  ms: number;
}

function request(port: number, method: string, target: string, body?: string): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const payload = body === undefined ? null : Buffer.from(body, 'utf-8');

    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: target,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
            ms: Date.now() - started,
          }),
        );
      },
    );

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether anything is still accepting connections on a port. */
function accepting(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** A port the daemon can have to itself: taken, read back, released. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not read back an ephemeral port'));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

// ── Assertions ──────────────────────────────────────────────────────────────

/**
 * Compares a response body byte for byte.
 *
 * The length is checked separately because the text comparison alone would pass
 * for a body that is UTF-8 in Rust and something else on the wire — the zh-TW
 * errors are the whole reason this run exists.
 */
function expectBody(reply: HttpReply, expected: string, what: string): void {
  expectEqual(reply.body.toString('utf-8'), expected, what);
  expectEqual(reply.body.length, Buffer.byteLength(expected, 'utf-8'), `${what} byte length`);
}

function expectReply(
  reply: HttpReply,
  status: number,
  contentType: string | undefined,
  what: string,
): void {
  expectEqual(reply.status, status, `${what} status`);
  expectEqual(reply.headers['content-type'], contentType, `${what} Content-Type`);
}

/** The `UNLOCK_HTML` template literal, straight out of the shipping signer. */
function unlockPageFromTypeScript(): string {
  const source = fs.readFileSync(SIGNER_INDEX, 'utf-8');
  const match = /const UNLOCK_HTML = `([\s\S]*?)`;\n/.exec(source);
  if (!match) throw new Error(`could not find UNLOCK_HTML in ${SIGNER_INDEX}`);
  return match[1];
}

// ── Daemon lifecycle ────────────────────────────────────────────────────────

/** Waits for the locked daemon to start answering on its unlock port. */
async function waitForUnlockPage(daemon: Daemon, port: number, waitMs = 30_000): Promise<void> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const exited = daemon.exited();
    if (exited !== null) {
      throw new Error(`daemon exited with code ${exited} before serving\n${daemon.stderr()}`);
    }
    try {
      await request(port, 'GET', '/');
      return;
    } catch {
      if (Date.now() > deadline) {
        daemon.process.kill('SIGKILL');
        throw new Error(`no unlock page on ${port} within ${waitMs}ms\n${daemon.stderr()}`);
      }
      await sleep(50);
    }
  }
}

async function main(): Promise<void> {
  buildDaemon();

  const fixture = JSON.parse(fs.readFileSync(VECTORS, 'utf-8')) as VectorFile;
  const vector = fixture.vectors.find((candidate) => candidate.name === 'v0_no_alt');
  if (!vector) throw new Error(`fixture vector v0_no_alt is missing from ${VECTORS}`);

  const expectedPage = unlockPageFromTypeScript();
  const workspace = prepareWorkspace('byreal-signer-m6-', fixture._fixed_material.signer_pubkey);
  const port = await freePort();
  console.log(`Unlock:  http://127.0.0.1:${port}\n`);

  const daemon = spawnDaemon({
    workspace,
    rpcUrl: DEAD_RPC,
    env: {
      SIGNER_UNLOCK_PORT: String(port),
      SIGNER_DEST_WHITELIST: fixture._fixed_material.dest_ata,
    },
  });

  try {
    await waitForUnlockPage(daemon, port);
    console.log('\nChecks:');

    await check('the daemon comes up locked, in browser-only unlock mode', async () => {
      if (fs.existsSync(workspace.socketPath)) {
        throw new Error('the signing socket exists before any password was supplied');
      }

      const log = daemon.stderr();
      for (const line of [
        'Unlock mode: browser only (no TTY)',
        `Unlock page: http://127.0.0.1:${port}`,
        'Waiting for password...',
      ]) {
        if (!log.includes(line)) throw new Error(`the daemon never logged ${JSON.stringify(line)}`);
      }
      return 'no socket, page on loopback only';
    });

    for (const target of ['/', '/unlock']) {
      await check(`GET ${target} serves UNLOCK_HTML verbatim`, async () => {
        const reply = await request(port, 'GET', target);
        expectReply(reply, 200, 'text/html; charset=utf-8', `GET ${target}`);
        expectBody(reply, expectedPage, `GET ${target} body`);
        if (!reply.body.toString('utf-8').includes(DISTINCTIVE_ZH_TW)) {
          throw new Error(`the page is missing ${DISTINCTIVE_ZH_TW}`);
        }
        return `${reply.body.length} bytes, identical to signer/index.ts`;
      });
    }

    await check('wrong passwords are refused, each more slowly than the last', async () => {
      const attempts: HttpReply[] = [];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const reply = await request(port, 'POST', '/unlock', '{"password":"not-the-password"}');
        expectReply(reply, 401, 'application/json', `attempt ${attempt}`);
        expectBody(reply, WRONG_PASSWORD_BODY, `attempt ${attempt} body`);
        attempts.push(reply);
      }

      const [first, , third] = attempts;
      if (third.ms < first.ms + BACKOFF_MARGIN_MS) {
        throw new Error(
          `the backoff is not observable: attempt 1 took ${first.ms}ms, attempt 3 took ${third.ms}ms ` +
            `(wanted at least ${first.ms + BACKOFF_MARGIN_MS}ms)`,
        );
      }
      return `401 ×3, ${attempts.map((reply) => `${reply.ms}ms`).join(' → ')}`;
    });

    await check('an empty password asks for one instead of guessing', async () => {
      const reply = await request(port, 'POST', '/unlock', '{"password":""}');
      expectReply(reply, 400, 'application/json', 'empty password');
      expectBody(reply, EMPTY_PASSWORD_BODY, 'empty password body');
      return 'HTTP 400 請輸入密碼';
    });

    await check('a malformed body is rejected as an invalid request', async () => {
      const reply = await request(port, 'POST', '/unlock', 'not json at all');
      expectReply(reply, 400, 'application/json', 'malformed body');
      expectBody(reply, INVALID_REQUEST_BODY, 'malformed body');
      return 'HTTP 400 Invalid request';
    });

    await check('an unknown route is a bare 404', async () => {
      const reply = await request(port, 'GET', '/keyfile.enc.json');
      expectReply(reply, 404, undefined, 'unknown route');
      expectEqual(reply.body.length, 0, 'unknown route body length');
      return 'HTTP 404, no body, no Content-Type';
    });

    await check('the correct password unlocks the daemon and starts the signer', async () => {
      const reply = await request(port, 'POST', '/unlock', JSON.stringify({ password: PASSWORD }));
      expectReply(reply, 200, 'application/json', 'unlock');
      expectBody(reply, UNLOCKED_BODY, 'unlock body');

      await waitForSocket(daemon, workspace.socketPath, 10_000);
      const result = await signRequest(workspace.socketPath, {
        type: vector.kind,
        tx: vector.unsigned_b64,
      });
      return `${expectSigned(result, vector.ts_signed_b64, 'signed transaction')} after a browser unlock`;
    });

    await check('the unlock port closes once the daemon is unlocked', async () => {
      const deadline = Date.now() + 5_000;
      while (await accepting(port)) {
        if (Date.now() > deadline) {
          throw new Error(`the unlock page still accepts connections on ${port}`);
        }
        await sleep(50);
      }
      return `nothing listening on ${port}`;
    });
  } finally {
    const code = await stopDaemon(daemon);
    console.log(`\nDaemon exited with code ${code} on SIGTERM.`);
    workspace.cleanup();
  }

  report();
}

main().catch((err) => {
  console.error(`\ne2e harness failed: ${err instanceof Error ? err.stack : err}`);
  process.exitCode = 1;
});
