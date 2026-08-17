/**
 * End-to-end checks for milestone M3 of the Rust signer: the socket protocol.
 *
 * Builds a real encrypted keyfile with the TypeScript `encryptKey`, starts the
 * Rust daemon against it, and drives it over the Unix socket with the bot's own
 * client code (`client.ts`). The two signing checks compare the bytes that come
 * back against `ts_signed_b64` from the golden vectors — the exact output of
 * `@solana/web3.js` — so a pass means the Rust daemon is byte-for-byte
 * substitutable for `signer/index.ts` on those transactions, not merely that it
 * returned something plausible.
 *
 * Everything is offline and deterministic. `SIGNER_RPC_URL` points at a port
 * nothing listens on, which since M5 proves something stronger than "no RPC is
 * needed": the policy engine now runs on every request, and an unreachable
 * endpoint has to leave the signature unaffected. A connection refused during
 * simulation is non-fatal by design (`signer/policy.ts:186-188`), so these
 * transactions still sign, and still sign to the same bytes.
 *
 * The two fixtures move SPL tokens to a fixed destination ATA with no DEX
 * instruction beside them, which is exactly the shape the transfer rule refuses
 * for an unknown address. `SIGNER_DEST_WHITELIST` names that destination, the
 * same way an operator whitelists the daily auto-convert target — the cheapest
 * of the destination exemptions and the only one that needs no network, which is
 * what keeps this run offline. `run-m5.ts` covers the version of this that lets
 * the chain vouch for the destination instead.
 *
 * Run from `signer-rs/`:  npx ts-node --project e2e/tsconfig.json e2e/run-m3.ts
 * Or from `signer-rs/e2e/`:  npm run e2e:m3
 */
import fs from 'fs';
import path from 'path';
import { sendFrameExpectingClose, sendRawJson, signRequest } from './client';
import {
  buildDaemon,
  check,
  expectRejected,
  expectSigned,
  FIXTURES,
  prepareWorkspace,
  report,
  startDaemon,
  stopDaemon,
} from './harness';

const VECTORS = path.join(FIXTURES, 'tx_vectors.json');

/** Nothing listens here. An unreachable RPC must not change the outcome. */
const DEAD_RPC = 'http://127.0.0.1:1';

interface TxVector {
  name: string;
  kind: 'legacy' | 'versioned';
  unsigned_b64: string;
  ts_signed_b64: string;
  description: string;
}

interface VectorFile {
  _fixed_material: { signer_pubkey: string; dest_ata: string };
  vectors: TxVector[];
}

async function main(): Promise<void> {
  buildDaemon();

  const fixture = JSON.parse(fs.readFileSync(VECTORS, 'utf-8')) as VectorFile;
  const vector = (name: string): TxVector => {
    const found = fixture.vectors.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`fixture vector ${name} is missing from ${VECTORS}`);
    return found;
  };

  const workspace = prepareWorkspace('byreal-signer-m3-', fixture._fixed_material.signer_pubkey);
  console.log('');

  const daemon = await startDaemon({
    workspace,
    rpcUrl: DEAD_RPC,
    env: { SIGNER_DEST_WHITELIST: fixture._fixed_material.dest_ata },
  });
  console.log('\nChecks:');

  try {
    for (const name of ['v0_no_alt', 'legacy_spl_transfer']) {
      const tx = vector(name);
      await check(`${name} signs to the byte-identical web3.js output`, async () => {
        const result = await signRequest(workspace.socketPath, {
          type: tx.kind,
          tx: tx.unsigned_b64,
        });
        return `${tx.kind}, ${expectSigned(result, tx.ts_signed_b64, 'signed transaction')}`;
      });
    }

    await check('a request with no type reports the TypeScript wording', async () =>
      expectRejected(
        await sendRawJson(workspace.socketPath, '{"tx":"AQID"}'),
        'Invalid request: missing type or tx',
      ),
    );

    await check('an unknown type is echoed back verbatim', async () =>
      expectRejected(
        await signRequest(workspace.socketPath, { type: 'bogus', tx: 'AQID' }),
        'Invalid type: bogus',
      ),
    );

    await check('a 70 KiB frame is refused and the server hangs up', async () => {
      const oversize = Buffer.alloc(70 * 1024, 0x78);
      const { result, serverClosed } = await sendFrameExpectingClose(
        workspace.socketPath,
        oversize,
      );
      if (!result) throw new Error('the server closed without answering');
      expectRejected(result, 'Frame too large: 71680 bytes exceeds the 65536-byte limit');
      if (!serverClosed) throw new Error('the server left the connection open');
      return 'refused, then closed';
    });
  } finally {
    const code = await stopDaemon(daemon);
    console.log(`\nDaemon exited with code ${code} on SIGTERM.`);

    await check('SIGTERM unlinks the socket', async () => {
      if (fs.existsSync(workspace.socketPath)) {
        throw new Error(`${workspace.socketPath} was left behind`);
      }
      return 'socket removed';
    });

    workspace.cleanup();
  }

  report();
}

main().catch((err) => {
  console.error(`\ne2e harness failed: ${err instanceof Error ? err.stack : err}`);
  process.exitCode = 1;
});
