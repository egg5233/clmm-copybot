/**
 * The bot's signer client, standing on its own.
 *
 * `sendToSigner` below is a copy of `src/utils/wallet.ts:58-101` with the socket
 * path passed in instead of read from `config`. It is deliberately a *copy* and
 * not an import: pulling in `src/utils/wallet.ts` would drag in `../config` and
 * with it the whole environment the bot needs to boot, and the point of these
 * checks is to prove the Rust daemon satisfies the framing code that actually
 * ships — chunk reassembly, length prefix, 30-second timeout, one request per
 * connection, destroy on response — rather than a tidied-up reimplementation.
 *
 * If the client in `src/utils/wallet.ts` changes, this copy has to change with
 * it or the e2e stops testing the thing it claims to.
 */
import net from 'net';

/** What a signer reply looks like once parsed (`signer/index.ts:258`). */
export interface SignerResult {
  ok: boolean;
  tx?: string;
  error?: string;
}

// ── Verbatim from src/utils/wallet.ts ───────────────────────────────────────

/**
 * Send an unsigned transaction to the signer service and receive it back signed.
 * Protocol: 4-byte big-endian length prefix + JSON payload.
 * Request:  { type: "versioned"|"legacy", tx: "<base64 serialized unsigned TX>" }
 * Response: { ok: true, tx: "<base64 serialized signed TX>" }
 *       or  { ok: false, error: "reason" }
 */
export function sendToSigner(socketPath: string, payload: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath, () => {
      // Length-prefixed framing
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeUInt32BE(payload.length, 0);
      sock.write(lenBuf);
      sock.write(payload);
    });

    const chunks: Buffer[] = [];
    let expectedLen = -1;
    let received = 0;

    sock.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      received += chunk.length;

      // Read length prefix from first 4 bytes
      if (expectedLen < 0 && received >= 4) {
        const header = Buffer.concat(chunks);
        expectedLen = header.readUInt32BE(0);
        // Re-buffer without the 4-byte prefix
        chunks.length = 0;
        chunks.push(header.slice(4));
        received -= 4;
      }

      if (expectedLen >= 0 && received >= expectedLen) {
        sock.destroy();
        resolve(Buffer.concat(chunks).slice(0, expectedLen));
      }
    });

    sock.on('error', (err) => {
      reject(new Error(`Signer service error: ${err.message}`));
    });

    sock.setTimeout(30_000, () => {
      sock.destroy();
      reject(new Error('Signer service timeout (30s)'));
    });
  });
}

// ── Thin wrappers for the checks ────────────────────────────────────────────

/** One request/response exchange, parsed. */
export async function signRequest(socketPath: string, request: unknown): Promise<SignerResult> {
  const payload = Buffer.from(JSON.stringify(request), 'utf-8');
  const response = await sendToSigner(socketPath, payload);
  return JSON.parse(response.toString('utf-8')) as SignerResult;
}

/** Sends a payload that is not JSON at all, for the malformed-request checks. */
export async function sendRawJson(socketPath: string, json: string): Promise<SignerResult> {
  const response = await sendToSigner(socketPath, Buffer.from(json, 'utf-8'));
  return JSON.parse(response.toString('utf-8')) as SignerResult;
}

/** Outcome of a frame the server is expected to refuse and then hang up on. */
export interface RefusedExchange {
  /** The response frame, if one arrived before the close. */
  result: SignerResult | null;
  /** Whether the server ended the connection rather than leaving it open. */
  serverClosed: boolean;
}

/**
 * Writes one frame and waits for the server to close the connection.
 *
 * Separate from `sendToSigner` because that one hangs up the moment it has a
 * response, which is exactly what must *not* happen when the question is whether
 * the server hung up first. Two details keep this from being flaky:
 *
 * * The header and payload go out in a single `write`, so an oversize frame is
 *   fully buffered by the kernel before the server can refuse it. Written as two
 *   writes, the second can land on an already-closing socket and fail with
 *   EPIPE, hiding the response.
 * * The server does not drain the payload it refused, so the kernel aborts the
 *   connection: Linux reports that as ECONNRESET rather than a clean FIN. Both
 *   count as "the server closed", and neither is treated as a failure once a
 *   response has been read.
 */
export function sendFrameExpectingClose(
  socketPath: string,
  payload: Buffer,
): Promise<RefusedExchange> {
  return new Promise((resolve, reject) => {
    const framed = Buffer.alloc(4 + payload.length);
    framed.writeUInt32BE(payload.length, 0);
    payload.copy(framed, 4);

    const sock = net.createConnection(socketPath, () => {
      sock.write(framed);
    });

    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (serverClosed: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();

      const received = Buffer.concat(chunks);
      let result: SignerResult | null = null;
      if (received.length >= 4) {
        const expectedLen = received.readUInt32BE(0);
        if (received.length >= 4 + expectedLen) {
          result = JSON.parse(received.slice(4, 4 + expectedLen).toString('utf-8'));
        }
      }
      resolve({ result, serverClosed });
    };

    sock.on('data', (chunk: Buffer) => chunks.push(chunk));
    sock.on('end', () => finish(true));
    sock.on('close', () => finish(true));

    sock.on('error', (err) => {
      // A reset is the server hanging up on an undrained payload; anything else
      // this early is a real failure worth surfacing.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ECONNRESET' || code === 'EPIPE') {
        finish(true);
        return;
      }
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(new Error(`Signer service error: ${err.message}`));
    });

    sock.setTimeout(30_000, () => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(new Error('Signer service timeout (30s) waiting for the server to close'));
    });
  });
}
