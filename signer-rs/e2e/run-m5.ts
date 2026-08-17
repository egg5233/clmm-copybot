/**
 * End-to-end checks for milestone M5 of the Rust signer: the policy engine.
 *
 * M3 proved the daemon speaks the socket protocol and signs the right bytes.
 * This proves it refuses the right transactions, through the whole stack —
 * socket, frame, parse, resolve, allowlist, SPL rules, RPC client, simulation —
 * with a mock JSON-RPC endpoint (`mock-rpc.ts`) standing in for the chain so the
 * answers that decide each verdict can be dictated per check.
 *
 * The four verdicts under test are the ones with no unit-test equivalent,
 * because each depends on the daemon's own RPC client rather than on
 * `signer-core`:
 *
 *   1. A clean transaction still signs byte-for-byte, and its destination is
 *      vouched for by the chain (owned by an allowlisted program) rather than by
 *      a whitelist — the exemption that costs a round trip.
 *   2. Simulation logs naming a program off the allowlist refuse it, with the
 *      wording `signer/policy.ts` would have used.
 *   3. Simulation being unavailable does *not* refuse it. This is the failure
 *      mode most likely to be "fixed" into a rejection by someone who has not
 *      read `policy.ts:186-188`.
 *   4. An SPL `SetAuthority` is refused before any of that — built here with
 *      `@solana/spl-token`, so what the policy sees is the byte layout the bot
 *      itself would produce.
 *
 * Two more cover the decisions that shape when simulation runs at all: a Jupiter
 * transaction is not simulated, and a transaction that would fail on chain is
 * signed anyway.
 *
 * Run from `signer-rs/`:  npx ts-node --project e2e/tsconfig.json e2e/run-m5.ts
 * Or from `signer-rs/e2e/`:  npm run e2e:m5
 */
import fs from 'fs';
import path from 'path';
import { Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { AuthorityType, createSetAuthorityInstruction } from '@solana/spl-token';
import { signRequest } from './client';
import {
  buildDaemon,
  check,
  expectEqual,
  expectRejected,
  expectSigned,
  FIXTURES,
  prepareWorkspace,
  report,
  startDaemon,
  stopDaemon,
} from './harness';
import { startMockRpc, MockRpc } from './mock-rpc';

const TX_VECTORS = path.join(FIXTURES, 'tx_vectors.json');
const SIM_VECTORS = path.join(FIXTURES, 'sim_log_vectors.json');

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const JUPITER_V6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

interface TxVector {
  name: string;
  kind: 'legacy' | 'versioned';
  unsigned_b64: string;
  ts_signed_b64: string;
}

interface TxVectorFile {
  _fixed_material: {
    signer_pubkey: string;
    dest_ata: string;
    signer_ata: string;
    blockhash: string;
  };
  vectors: TxVector[];
}

interface SimVector {
  name: string;
  logs: string[];
  off_allowlist_program_id?: string;
}

interface SimVectorFile {
  vectors: SimVector[];
}

function load<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
}

function find<T extends { name: string }>(vectors: T[], name: string, file: string): T {
  const found = vectors.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`fixture vector ${name} is missing from ${file}`);
  return found;
}

/** A legacy transaction carrying one instruction, unsigned. */
function unsignedLegacy(
  payer: Keypair,
  blockhash: string,
  instruction: TransactionInstruction,
): string {
  const tx = new Transaction();
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = blockhash;
  tx.add(instruction);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

async function main(): Promise<void> {
  buildDaemon();

  const txFixture = load<TxVectorFile>(TX_VECTORS);
  const simFixture = load<SimVectorFile>(SIM_VECTORS);
  const { signer_pubkey: signerPubkey, dest_ata: destAta, blockhash } = txFixture._fixed_material;

  const clean = find(simFixture.vectors, 'simple_two_programs', SIM_VECTORS);
  const hostile = find(simFixture.vectors, 'off_allowlist_cpi', SIM_VECTORS);
  const unknownProgram = hostile.off_allowlist_program_id;
  if (!unknownProgram) throw new Error('off_allowlist_cpi must name its off-allowlist program');

  const workspace = prepareWorkspace('byreal-signer-m5-', signerPubkey);
  const rpc: MockRpc = await startMockRpc();
  console.log(`RPC:     ${rpc.url} (mock)\n`);

  // The destination of the fixtures' SPL transfer is a token account. Nothing
  // whitelists it, so the only thing that can clear it is the chain saying it is
  // owned by an allowlisted program — the last exemption in the transfer chain,
  // and the one M3 sidesteps with `SIGNER_DEST_WHITELIST`.
  rpc.state.accounts.set(destAta, { owner: TOKEN_PROGRAM, data: Buffer.alloc(165) });

  const daemon = await startDaemon({ workspace, rpcUrl: rpc.url });
  const socket = workspace.socketPath;
  const v0 = find(txFixture.vectors, 'v0_no_alt', TX_VECTORS);
  console.log('\nChecks:');

  try {
    await check(
      'a clean transaction signs, with the chain vouching for the destination',
      async () => {
        rpc.reset();
        rpc.state.simulate = { err: null, logs: clean.logs };

        const result = await signRequest(socket, { type: v0.kind, tx: v0.unsigned_b64 });
        const detail = expectSigned(result, v0.ts_signed_b64, 'signed transaction');

        const methods = rpc.methods();
        if (!methods.includes('getAccountInfo')) {
          throw new Error(`the destination was never classified (methods: ${methods.join(', ')})`);
        }
        if (!methods.includes('simulateTransaction')) {
          throw new Error(`the transaction was never simulated (methods: ${methods.join(', ')})`);
        }
        return `${detail}; RPC saw ${methods.join(', ')}`;
      },
    );

    await check('simulation logs naming an unknown program refuse the transaction', async () => {
      rpc.reset();
      rpc.state.simulate = { err: null, logs: hostile.logs };

      return expectRejected(
        await signRequest(socket, { type: v0.kind, tx: v0.unsigned_b64 }),
        `Simulation revealed unknown invoked program: ${unknownProgram}`,
      );
    });

    await check('a transaction that would fail on chain is still signed', async () => {
      rpc.reset();
      rpc.state.simulate = {
        err: { InstructionError: [0, { Custom: 6003 }] },
        logs: clean.logs,
      };

      const result = await signRequest(socket, { type: v0.kind, tx: v0.unsigned_b64 });
      return expectSigned(result, v0.ts_signed_b64, 'signed transaction');
    });

    await check('an RPC that cannot simulate does not stop the signature', async () => {
      rpc.reset();
      rpc.state.simulateHttpStatus = 500;
      try {
        const result = await signRequest(socket, { type: v0.kind, tx: v0.unsigned_b64 });
        const detail = expectSigned(result, v0.ts_signed_b64, 'signed transaction');
        if (!rpc.methods().includes('simulateTransaction')) {
          throw new Error('simulation was skipped rather than attempted and forgiven');
        }
        return `${detail}, after HTTP 500 from simulateTransaction`;
      } finally {
        rpc.state.simulateHttpStatus = null;
      }
    });

    await check('a Jupiter transaction is signed without being simulated', async () => {
      rpc.reset();
      // The logs are the hostile ones; the point is that nobody asks for them.
      rpc.state.simulate = { err: null, logs: hostile.logs };

      const route = new TransactionInstruction({
        programId: new PublicKey(JUPITER_V6),
        keys: [{ pubkey: workspace.keypair.publicKey, isSigner: true, isWritable: true }],
        data: Buffer.from([0xe5, 0x17, 0xcb, 0x97, 0x7a, 0xe3, 0xad, 0x2a]),
      });

      const result = await signRequest(socket, {
        type: 'legacy',
        tx: unsignedLegacy(workspace.keypair, blockhash, route),
      });
      expectEqual(result.ok, true, `ok (error: ${result.error})`);

      const methods = rpc.methods();
      if (methods.includes('simulateTransaction')) {
        throw new Error('the Jupiter exemption should skip the round trip entirely');
      }
      return `signed after ${methods.length} RPC calls`;
    });

    await check('an SPL SetAuthority is refused', async () => {
      rpc.reset();
      const hijack = createSetAuthorityInstruction(
        new PublicKey(destAta),
        workspace.keypair.publicKey,
        AuthorityType.AccountOwner,
        new PublicKey(signerPubkey),
      );

      return expectRejected(
        await signRequest(socket, {
          type: 'legacy',
          tx: unsignedLegacy(workspace.keypair, blockhash, hijack),
        }),
        'SPL SetAuthority is blocked — potential authority hijack',
      );
    });
  } finally {
    const code = await stopDaemon(daemon);
    console.log(`\nDaemon exited with code ${code} on SIGTERM.`);
    await rpc.close();
    workspace.cleanup();
  }

  report();
}

main().catch((err) => {
  console.error(`\ne2e harness failed: ${err instanceof Error ? err.stack : err}`);
  process.exitCode = 1;
});
