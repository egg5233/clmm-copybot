/**
 * The differential run for milestone M7: both signers, the same requests, compared.
 *
 * `run-m3.ts` and `run-m5.ts` check the Rust daemon against fixtures — bytes and
 * error strings captured from `@solana/web3.js` at fixture-generation time. This
 * runs the shipping TypeScript signer *live*, next to the Rust daemon, against
 * one encrypted keyfile and one mock chain, and puts the same corpus of requests
 * through both sockets. A pass means the two processes answered identically,
 * field by field, with signed transactions compared byte for byte — which is the
 * claim "drop-in replacement" actually makes.
 *
 * # Running the TypeScript signer without touching it
 *
 * `signer/index.ts:19` resolves its keyfile as `path.resolve(__dirname,
 * 'keyfile.enc.json')`, so the file has to sit beside the module — no working
 * directory or environment variable moves it. Rather than write anything into
 * `signer/`, this copies the directory's modules into the temp workspace and
 * runs the copy: `__dirname` is then the workspace, the keyfile is a symlink to
 * the *same* file the Rust daemon unlocks, and `signer/` is untouched. A
 * `node_modules` symlink beside the copy is what lets Node resolve
 * `@solana/web3.js` from a directory outside the repository.
 *
 * Isolation falls out of the same trick. `signer/config.ts:5-6` loads
 * `<module dir>/.env` and then the working directory's `.env`; both point into
 * the temp workspace, where neither exists, so the only configuration either
 * process sees is the environment this file hands it.
 *
 * # What "identical" is allowed to mean
 *
 * Three classes of request are answered differently, and each is declared here
 * rather than smoothed over:
 *
 *   1. **An oversize frame.** The Rust daemon caps frame length and closes; the
 *      TypeScript signer has no cap. Not sent to the TypeScript signer at all —
 *      see [`oversizeFrame`] for why that is the shape of the check rather than
 *      politeness.
 *   2. **A `versioned` request carrying legacy bytes.** The Rust daemon refuses
 *      it; web3.js accepts it and signs. A deliberate refusal, declared in
 *      `signer-core/src/tx.rs`.
 *   3. **The wording of a rejection both sides agree on.** Undecodable input —
 *      a `tx` field that is not base64, a transaction cut short — is refused by
 *      both, in each decoder's own words.
 *
 * Only the first two change what the bot can do; the third changes what an
 * operator reads in a log. A declared divergence that stops happening fails the
 * run just as an undeclared one does — either way this file would be describing
 * something that is no longer true.
 *
 * Run from `signer-rs/`:  npx ts-node --project e2e/tsconfig.json e2e/run-diff.ts
 * Or from `signer-rs/e2e/`:  npm run diff
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import {
  AuthorityType,
  createSetAuthorityInstruction,
  createTransferInstruction,
} from '@solana/spl-token';
import { sendFrameExpectingClose, sendRawJson, signRequest, SignerResult } from './client';
import {
  buildDaemon,
  check,
  Daemon,
  expectEqual,
  expectRejected,
  FIXTURES,
  PASSWORD,
  prepareWorkspace,
  report,
  startDaemon,
  stopDaemon,
  waitForSocket,
  WORKSPACE,
  Workspace,
} from './harness';
import { MockRpc, startMockRpc } from './mock-rpc';

const REPO = path.resolve(WORKSPACE, '..');
const TS_SIGNER_SRC = path.join(REPO, 'signer');
const TS_NODE = path.join(REPO, 'node_modules', '.bin', 'ts-node');

const TX_VECTORS = path.join(FIXTURES, 'tx_vectors.json');
const ALT_VECTORS = path.join(FIXTURES, 'alt_vectors.json');
const SIM_VECTORS = path.join(FIXTURES, 'sim_log_vectors.json');

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ALT_PROGRAM = 'AddressLookupTab1e1111111111111111111111111';

/** Fixed seeds, so the addresses in the rejection strings are the same every run. */
const seeded = (byte: number): Keypair =>
  Keypair.fromSeed(Uint8Array.from(new Array(32).fill(byte)));

/** A wallet the mock chain has never heard of: `getAccountInfo` answers null for it. */
const OUTSIDE_DEST = seeded(0x71).publicKey;
/** A program id on neither signer's allowlist. */
const OFF_ALLOWLIST_PROGRAM = seeded(0x72).publicKey;

// ── Fixtures ────────────────────────────────────────────────────────────────

interface TxVector {
  name: string;
  kind: 'legacy' | 'versioned';
  unsigned_b64: string;
  ts_signed_b64: string;
}

interface TxVectorFile {
  _fixed_material: {
    signer_pubkey: string;
    signer_ata: string;
    dest_ata: string;
    recipient_pubkey: string;
    blockhash: string;
  };
  vectors: TxVector[];
}

interface AltVectorFile {
  alt_account_key: string;
  raw_account_data_b64: string;
}

interface SimVector {
  name: string;
  logs: string[];
  off_allowlist_program_id?: string;
}

function load<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
}

// ── The TypeScript signer, run from a copy ──────────────────────────────────

interface TsSignerOptions {
  /** Where the copy lives; also its working directory. */
  dir: string;
  /** The keyfile both signers share. Symlinked to `<dir>/keyfile.enc.json`. */
  keyfilePath: string;
  socketPath: string;
  rpcUrl: string;
  env?: Record<string, string>;
}

/**
 * Copies `signer/` into the workspace and points a keyfile symlink at it.
 *
 * Every `.ts` file is copied rather than the four the entry point imports today,
 * so a module added to `signer/` cannot leave this copy silently short of one.
 * `tsconfig.json` comes along because `ts-node` reads the one in its working
 * directory, and the signer's is what `npm start` in `signer/` would use —
 * `strict: false` among other things, so the copy is compiled the way the
 * shipping code is.
 */
function installTsSigner(dir: string, keyfilePath: string): void {
  fs.mkdirSync(dir, { recursive: true });

  const sources = fs
    .readdirSync(TS_SIGNER_SRC)
    .filter((name) => name.endsWith('.ts') || name === 'tsconfig.json');
  for (const name of sources) {
    fs.copyFileSync(path.join(TS_SIGNER_SRC, name), path.join(dir, name));
  }

  // Node resolves dependencies by walking up from the importing file, and the
  // workspace is outside the repository, so without this the copy cannot find
  // `@solana/web3.js`. A symlink rather than a copy: it is the repository's own
  // installed tree, which is the point — the same web3.js the bot ships with.
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(dir, 'node_modules'));
  fs.symlinkSync(keyfilePath, path.join(dir, 'keyfile.enc.json'));
}

/** Echoes a child stream line by line, holding back partial lines. */
function tee(stream: NodeJS.ReadableStream, prefix: string): void {
  let pending = '';
  stream.on('data', (chunk: Buffer) => {
    const lines = (pending + chunk.toString()).split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) console.log(`  ${prefix} ${line}`);
    }
  });
}

/**
 * Starts the copied TypeScript signer and unlocks it over stdin.
 *
 * `SIGNER_UNLOCK_PORT=0` is what puts `signer/index.ts:188` on the stdin-only
 * branch, which is the same branch the Rust daemon takes under the same variable
 * — neither process opens an HTTP port, and the password arrives the same way
 * for both. The environment is built from nothing but these variables, matching
 * `spawnDaemon` in `harness.ts`, so the two signers are configured identically
 * apart from their socket paths.
 */
async function startTsSigner(options: TsSignerOptions): Promise<Daemon> {
  const child = spawn(TS_NODE, ['index.ts'], {
    cwd: options.dir,
    env: {
      PATH: process.env.PATH,
      SIGNER_SOCKET_PATH: options.socketPath,
      SIGNER_RPC_URL: options.rpcUrl,
      SIGNER_UNLOCK_PORT: '0',
      ...options.env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  tee(child.stdout, '[ts-signer]');
  tee(child.stderr, '[ts-signer]');

  let exited: number | null = null;
  child.on('exit', (code) => {
    exited = code ?? -1;
  });

  const signer: Daemon = { process: child, stderr: () => stderr, exited: () => exited };
  child.stdin.write(`${PASSWORD}\n`);
  child.stdin.end();
  await waitForSocket(signer, options.socketPath);
  return signer;
}

// ── Comparison ──────────────────────────────────────────────────────────────

/** Why the two implementations are allowed to answer a request differently. */
interface Divergence {
  /**
   * `behaviour` — one signs and the other refuses.
   * `wording` — both refuse, and only the text of the refusal differs.
   */
  kind: 'behaviour' | 'wording';
  /** The reason, printed under the table. */
  why: string;
  /** Must hold of the Rust reply, or the divergence is not the declared one. */
  rust: (result: SignerResult) => void;
}

interface Case {
  name: string;
  /** Dictates what the chain says for this case. Runs once, before either signer is asked. */
  arrange?: () => void;
  /** The exchange, against whichever socket it is handed. */
  ask: (socket: string) => Promise<SignerResult>;
  /** Extra assertion once the two agreed, e.g. against a golden vector. */
  agreed?: (result: SignerResult) => void;
  divergence?: Divergence;
}

type Verdict = 'match' | 'expected' | 'MISMATCH';

/** How much of a rejection reason the table shows before eliding it. */
const CELL_WIDTH = 38;

interface Row {
  name: string;
  ts: string;
  rust: string;
  verdict: Verdict;
}

interface Note {
  name: string;
  kind: Divergence['kind'] | 'not sent';
  why: string;
  ts: string;
  rust: string;
}

const rows: Row[] = [];
const notes: Note[] = [];

/** A reply in full, for the check line and the divergence notes. */
function render(result: SignerResult | null): string {
  if (result === null) return '(not sent)';
  if (result.ok) return `signed, ${Buffer.from(result.tx ?? '', 'base64').length} bytes`;
  return `refused: ${result.error ?? '(no reason given)'}`;
}

/**
 * The same reply as one table cell.
 *
 * Reasons are elided rather than wrapped: a rejection carrying a 44-character
 * address is wider than the rest of the table put together, and the text is
 * never lost — a matching pair has already been asserted against the exact
 * string it was expected to carry, and a diverging pair is printed in full under
 * the table.
 */
function cell(result: SignerResult | null): string {
  const full = render(result);
  return full.length <= CELL_WIDTH ? full : `${full.slice(0, CELL_WIDTH - 1)}…`;
}

/** Whether two replies are the same reply: every field the bot can observe. */
function identical(a: SignerResult, b: SignerResult): boolean {
  return a.ok === b.ok && a.tx === b.tx && a.error === b.error;
}

/**
 * Puts one case through both signers and records what came back.
 *
 * Order is TypeScript first, then Rust, against chain state arranged once for
 * the pair — so a case that depends on what the chain says asks the same
 * question of both.
 *
 * `restoreChain` runs before every case, so the one case that arranges a hostile
 * simulation cannot leak it into whatever runs next. Without it the corpus would
 * only be correct in the order it happens to be written in, and a case moved up
 * the list would fail for a reason that has nothing to do with the case.
 */
async function compare(
  kase: Case,
  sockets: { ts: string; rust: string },
  restoreChain: () => void,
): Promise<void> {
  await check(kase.name, async () => {
    restoreChain();
    kase.arrange?.();

    const ts = await kase.ask(sockets.ts);
    const rust = await kase.ask(sockets.rust);
    const row: Row = { name: kase.name, ts: cell(ts), rust: cell(rust), verdict: 'MISMATCH' };
    rows.push(row);

    if (identical(ts, rust)) {
      if (kase.divergence) {
        throw new Error(
          'the two signers agreed on a request this file declares they differ on.\n' +
            `Declared: ${kase.divergence.why}\n` +
            `Both answered: ${render(rust)}\n` +
            'Delete the declaration — leaving it in makes this run describe a divergence ' +
            'that no longer exists.',
        );
      }
      kase.agreed?.(rust);
      row.verdict = 'match';
      return render(rust);
    }

    if (!kase.divergence) {
      throw new Error(
        'the two signers answered differently and nothing here says they may.\n' +
          `  TypeScript: ${render(ts)}\n` +
          `  Rust:       ${render(rust)}`,
      );
    }

    kase.divergence.rust(rust);
    row.verdict = 'expected';
    notes.push({
      name: kase.name,
      kind: kase.divergence.kind,
      why: kase.divergence.why,
      ts: render(ts),
      rust: render(rust),
    });
    return `declared divergence — TypeScript ${render(ts)}, Rust ${render(rust)}`;
  });
}

// ── Transactions built for this run ─────────────────────────────────────────

/** A legacy transaction carrying one instruction, unsigned (as `run-m5.ts` builds them). */
function unsignedLegacy(payer: PublicKey, blockhash: string, ix: TransactionInstruction): string {
  const tx = new Transaction();
  tx.feePayer = payer;
  tx.recentBlockhash = blockhash;
  tx.add(ix);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

/** The first half of a vector's bytes: a frame that parses as far as its length. */
function halved(vector: TxVector): string {
  const full = Buffer.from(vector.unsigned_b64, 'base64');
  return full.subarray(0, Math.floor(full.length / 2)).toString('base64');
}

// ── The corpus ──────────────────────────────────────────────────────────────

interface Corpus {
  txFixture: TxVectorFile;
  simFixture: { vectors: SimVector[] };
  rpc: MockRpc;
  signer: PublicKey;
  /**
   * A bare token transfer to [`OUTSIDE_DEST`], with no DEX instruction to excuse
   * it. Built once because both phases send it and the whole point of the second
   * is that the transaction did not change — only the whitelist did.
   */
  standaloneTransfer: string;
  /** Puts the mock chain back in its default, benign state. See [`compare`]. */
  restoreChain: () => void;
}

/**
 * Everything driven with no destination whitelist configured.
 *
 * The golden vectors move SPL tokens to a fixed destination ATA, which the
 * transfer rule refuses for an address nothing vouches for. Here the *chain*
 * vouches for it — `main` seeds the mock with an account owned by the SPL Token
 * program — which is the exemption `run-m5.ts` exercises and the one that leaves
 * `SIGNER_DEST_WHITELIST` free to mean what it means in the second phase.
 */
function openPhase({ txFixture, simFixture, rpc, signer, standaloneTransfer }: Corpus): Case[] {
  const vector = (name: string): TxVector => {
    const found = txFixture.vectors.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`fixture vector ${name} is missing from ${TX_VECTORS}`);
    return found;
  };
  const simVector = (name: string): SimVector => {
    const found = simFixture.vectors.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`fixture vector ${name} is missing from ${SIM_VECTORS}`);
    return found;
  };

  const {
    dest_ata: destAta,
    recipient_pubkey: recipientPubkey,
    blockhash,
  } = txFixture._fixed_material;
  const hostile = simVector('off_allowlist_cpi');
  const unknownInvoked = hostile.off_allowlist_program_id;
  if (!unknownInvoked) throw new Error('off_allowlist_cpi must name its off-allowlist program');

  const legacy = vector('legacy_spl_transfer');
  const v0NoAlt = vector('v0_no_alt');
  const v0WithAlt = vector('v0_with_alt');

  const cases: Case[] = [];

  // ── The golden vectors that sign under both signers ───────────────────────
  //
  // `v0_no_alt` is deliberately absent: it bundles a bare SystemProgram.transfer
  // that the Rust daemon now refuses and the TypeScript signer still signs, so it
  // is pinned below as a declared divergence rather than a byte-identity check.
  for (const name of ['legacy_spl_transfer', 'legacy_two_signer_presigned', 'v0_with_alt']) {
    const tx = vector(name);
    cases.push({
      name: `${name} signs`,
      ask: (socket) => signRequest(socket, { type: tx.kind, tx: tx.unsigned_b64 }),
      // Agreeing with each other is not enough: both have to agree with the
      // bytes `@solana/web3.js` produced when the fixtures were generated, or
      // two implementations could drift together and still pass.
      agreed: (result) => expectEqual(result.tx, tx.ts_signed_b64, `${name} signed bytes`),
    });
  }

  cases.push({
    // A standalone SOL transfer, the one new native-SOL divergence. `v0_no_alt`
    // pairs a `SystemProgram.transfer` to an unwhitelisted recipient with an SPL
    // transfer and no DEX instruction. The TypeScript signer inspects only SPL
    // token instructions and leaves the System program — which is on the
    // allowlist — unchecked, so it signs the lamport move. The Rust daemon holds
    // a standalone SOL transfer to the same bar as a standalone SPL transfer and
    // refuses it (`signer-core/src/policy/system.rs`).
    name: 'a standalone SOL transfer (bundled in v0_no_alt)',
    ask: (socket) => signRequest(socket, { type: v0NoAlt.kind, tx: v0NoAlt.unsigned_b64 }),
    divergence: {
      kind: 'behaviour',
      why:
        '`v0_no_alt` carries a bare SystemProgram.transfer alongside an SPL transfer, with no DEX ' +
        'instruction to excuse it. `signer/policy.ts` inspects only the two SPL token programs and ' +
        'leaves the allowlisted System program unchecked, so the TypeScript signer signs a lamport ' +
        'move to an address nothing vouches for. `policy/system.rs` refuses it, mirroring the SPL ' +
        'transfer rule: a standalone SOL transfer needs a whitelisted recipient or a DEX ' +
        'instruction in the same transaction. The bot never emits one — SOL moves only inside DEX ' +
        'SDK transactions — so the refusal costs nothing the bot uses.',
      rust: (result) =>
        expectRejected(
          result,
          `Standalone SOL transfer to non-whitelisted address: ${recipientPubkey}`,
        ),
    },
  });

  cases.push({
    // `v0_with_alt` has already been through both signers once, above. Signing is
    // idempotent — no nonce, no replay window, no per-request state — and this
    // is where that gets checked, on both sides at once: the second answer has
    // to be the first answer, which the assertion against the golden bytes
    // pins down for each signer independently. (The ALT vector stands in for
    // `v0_no_alt` here, which no longer signs under the Rust daemon.)
    name: 'the same transaction sent twice',
    ask: (socket) => signRequest(socket, { type: v0WithAlt.kind, tx: v0WithAlt.unsigned_b64 }),
    agreed: (result) => expectEqual(result.tx, v0WithAlt.ts_signed_b64, 're-sent signed bytes'),
  });

  // ── Malformed requests ────────────────────────────────────────────────────
  cases.push({
    name: 'a request with no type',
    ask: (socket) => sendRawJson(socket, '{"tx":"AQID"}'),
    agreed: (result) => expectRejected(result, 'Invalid request: missing type or tx'),
  });

  cases.push({
    name: 'a request with no tx',
    ask: (socket) => sendRawJson(socket, '{"type":"legacy"}'),
    agreed: (result) => expectRejected(result, 'Invalid request: missing type or tx'),
  });

  cases.push({
    name: 'a type neither signer knows',
    ask: (socket) => signRequest(socket, { type: 'bogus', tx: 'AQID' }),
    agreed: (result) => expectRejected(result, 'Invalid type: bogus'),
  });

  cases.push({
    name: 'a tx field that is not base64',
    ask: (socket) => signRequest(socket, { type: 'legacy', tx: '@@@@ not base64 @@@@' }),
    divergence: {
      kind: 'wording',
      why:
        "Node's `Buffer.from(s, 'base64')` drops characters outside the alphabet and decodes " +
        'whatever is left, so the TypeScript signer reaches its transaction decoder holding ' +
        'bytes nobody sent and reports what that decoder made of them. `SignRequest::decode_tx` ' +
        'refuses the field instead (declared in `signer-core/src/protocol.rs`). Both refuse to ' +
        'sign; only the reason differs.',
      rust: (result) => expectRejected(result, 'Invalid request: tx is not valid base64'),
    },
  });

  for (const name of ['legacy_spl_transfer', 'v0_no_alt']) {
    const tx = vector(name);
    cases.push({
      name: `${name} cut in half`,
      ask: (socket) => signRequest(socket, { type: tx.kind, tx: halved(tx) }),
      divergence: {
        kind: 'wording',
        why:
          'Both refuse to sign a truncated transaction; the text is each decoder describing its ' +
          "own failure — web3.js reads the wire format by hand ('Reached end of buffer " +
          "unexpectedly'), `ParsedTx::parse` goes through bincode. Nothing the bot does " +
          'branches on the text (`src/utils/wallet.ts:113` re-throws it), and pinning a ' +
          'web3.js internal string into the Rust port would be copying a detail rather than a ' +
          'contract.',
        rust: (result) => {
          expectEqual(result.ok, false, 'ok');
          const prefix = `Failed to deserialize ${tx.kind} transaction:`;
          if (!result.error?.startsWith(prefix)) {
            throw new Error(
              `expected a reason starting ${JSON.stringify(prefix)}, got ${result.error}`,
            );
          }
        },
      },
    });
  }

  cases.push({
    name: 'legacy bytes sent as "versioned"',
    ask: (socket) => signRequest(socket, { type: 'versioned', tx: legacy.unsigned_b64 }),
    divergence: {
      kind: 'behaviour',
      why:
        'The version prefix is optional in web3.js, so `VersionedTransaction.deserialize` falls ' +
        'back to the legacy layout and the TypeScript signer signs a transaction whose declared ' +
        'shape and real shape disagree. `ParsedTx::parse` refuses that combination (declared in ' +
        '`signer-core/src/tx.rs`). The bot never produces it — `signVersioned` only ever ' +
        'serializes a v0 message — so refusing costs nothing the bot uses.',
      rust: (result) => {
        expectEqual(result.ok, false, 'ok');
        expectEqual(
          result.error,
          'Failed to deserialize versioned transaction: message has no version prefix — ' +
            'send a legacy transaction with type "legacy"',
          'error',
        );
      },
    },
  });

  // ── Policy ────────────────────────────────────────────────────────────────
  cases.push({
    name: 'an SPL SetAuthority',
    ask: (socket) =>
      signRequest(socket, {
        type: 'legacy',
        tx: unsignedLegacy(
          signer,
          blockhash,
          createSetAuthorityInstruction(
            new PublicKey(destAta),
            signer,
            AuthorityType.AccountOwner,
            signer,
          ),
        ),
      }),
    agreed: (result) =>
      expectRejected(result, 'SPL SetAuthority is blocked — potential authority hijack'),
  });

  cases.push({
    name: 'a bare SPL transfer to an unvouched address',
    ask: (socket) => signRequest(socket, { type: 'legacy', tx: standaloneTransfer }),
    agreed: (result) =>
      expectRejected(result, `Standalone SPL transfer to non-whitelisted address: ${OUTSIDE_DEST}`),
  });

  cases.push({
    name: 'a call to a program on neither allowlist',
    ask: (socket) =>
      signRequest(socket, {
        type: 'legacy',
        tx: unsignedLegacy(
          signer,
          blockhash,
          new TransactionInstruction({
            programId: OFF_ALLOWLIST_PROGRAM,
            keys: [{ pubkey: signer, isSigner: true, isWritable: true }],
            data: Buffer.from([1, 2, 3]),
          }),
        ),
      }),
    agreed: (result) => expectRejected(result, `Unknown program: ${OFF_ALLOWLIST_PROGRAM}`),
  });

  cases.push({
    // A v0 transaction on purpose. The TypeScript signer simulates a *legacy*
    // transaction through `Connection.simulateTransaction(Transaction)`, which
    // fetches a blockhash first and therefore never reaches this mock's
    // simulation at all; the v0 path posts the transaction as-is, so both
    // signers see the logs arranged here and both act on them. `v0_with_alt`
    // rather than `v0_no_alt` because the latter's bare SOL transfer is now
    // refused at the static pass, before either signer would simulate.
    name: 'simulation logs naming an off-allowlist program',
    arrange: () => {
      rpc.state.simulate = { err: null, logs: hostile.logs };
    },
    ask: (socket) => signRequest(socket, { type: v0WithAlt.kind, tx: v0WithAlt.unsigned_b64 }),
    agreed: (result) =>
      expectRejected(result, `Simulation revealed unknown invoked program: ${unknownInvoked}`),
  });

  return cases;
}

/**
 * The one case that needs both signers restarted with a destination whitelist.
 *
 * The transfer refused in the first phase is the same transfer, byte for byte;
 * the only thing that changed is `SIGNER_DEST_WHITELIST`. That both signers read
 * the variable the same way is the point — it is the knob an operator turns to
 * let the daily auto-convert reach its target.
 */
function whitelistedPhase({ standaloneTransfer }: Corpus): Case[] {
  return [
    {
      name: 'the same transfer, now whitelisted',
      ask: (socket) => signRequest(socket, { type: 'legacy', tx: standaloneTransfer }),
      agreed: (result) => {
        expectEqual(result.ok, true, `ok (refused with: ${result.error})`);
        // That the two agreed byte for byte is `compare`'s job. What is left to
        // establish is that they agreed on something real: a legacy transaction
        // whose signature verifies against its own message, rather than two
        // implementations producing the same nothing.
        const signed = Transaction.from(Buffer.from(result.tx ?? '', 'base64'));
        if (!signed.verifySignatures()) {
          throw new Error('the transaction came back without a valid signature');
        }
      },
    },
  ];
}

// ── Report ──────────────────────────────────────────────────────────────────

function printTable(): void {
  const headers = ['case', 'TypeScript signer', 'Rust daemon', 'verdict'];
  const cells = rows.map((row) => [row.name, row.ts, row.rust, row.verdict]);
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...cells.map((row) => row[column].length)),
  );
  const line = (values: string[]): string =>
    values
      .map((value, column) => value.padEnd(widths[column]))
      .join('  ')
      .trimEnd();

  console.log(`\n${line(headers)}`);
  console.log(widths.map((width) => '─'.repeat(width)).join('  '));
  for (const row of cells) console.log(line(row));
}

function printDivergences(): void {
  if (notes.length === 0) return;

  console.log('\nExpected divergences');
  console.log('─'.repeat(20));
  for (const note of notes) {
    console.log(`\n[${note.kind}] ${note.name}`);
    console.log(`  TypeScript: ${note.ts}`);
    console.log(`  Rust:       ${note.rust}`);
    for (const wrapped of wrap(note.why, 92)) console.log(`  ${wrapped}`);
  }
}

/** Greedy wrap, so a paragraph of reasoning does not run off the terminal. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/)) {
    if (current.length > 0 && current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = current.length > 0 ? `${current} ${word}` : word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

// ── Run ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  buildDaemon();

  const txFixture = load<TxVectorFile>(TX_VECTORS);
  const altFixture = load<AltVectorFile>(ALT_VECTORS);
  const simFixture = load<{ vectors: SimVector[] }>(SIM_VECTORS);
  const { signer_pubkey: signerPubkey, dest_ata: destAta } = txFixture._fixed_material;

  const workspace = prepareWorkspace('byreal-signer-diff-', signerPubkey);
  const tsDir = path.join(workspace.dir, 'ts-signer');
  installTsSigner(tsDir, workspace.keyfilePath);
  const tsSocket = path.join(workspace.dir, 'ts.sock');
  console.log(`TS copy: ${tsDir}`);
  console.log(`TS socket: ${tsSocket}`);

  const rpc = await startMockRpc();
  console.log(`RPC:     ${rpc.url} (mock, shared by both signers)\n`);

  // The chain both signers read. Token accounts owned by the SPL Token program
  // are what clears the transfer destinations in the golden vectors; the lookup
  // table is what lets `v0_with_alt` resolve. `OUTSIDE_DEST` is deliberately
  // absent, so `getAccountInfo` answers null for it exactly as a real node would
  // for an address that holds nothing.
  const tokenAccounts = [
    destAta,
    'CnEDk9HrMnmiHXEV1WFgbVCRteYnPqsJwrTdcZaNhFVW', // v0_with_alt Transfer destination
    'FR5pWwinRBn35GNhg7bsvw8Q13kRept2pm561DwZCQzT', // v0_with_alt TransferChecked destination
  ];
  for (const key of tokenAccounts) {
    rpc.state.accounts.set(key, { owner: TOKEN_PROGRAM.toBase58(), data: Buffer.alloc(165) });
  }
  rpc.state.accounts.set(altFixture.alt_account_key, {
    owner: ALT_PROGRAM,
    data: Buffer.from(altFixture.raw_account_data_b64, 'base64'),
  });

  // Logs from a transaction that only touched the System and SPL Token
  // programs: what a well-behaved transaction's simulation looks like, and the
  // state every case starts from.
  const benign = simFixture.vectors.find((candidate) => candidate.name === 'simple_two_programs');
  if (!benign) throw new Error(`fixture vector simple_two_programs is missing from ${SIM_VECTORS}`);

  const signer = new PublicKey(signerPubkey);
  const corpus: Corpus = {
    txFixture,
    simFixture,
    rpc,
    signer,
    restoreChain: () => {
      rpc.state.simulate = { err: null, logs: benign.logs };
    },
    standaloneTransfer: unsignedLegacy(
      signer,
      txFixture._fixed_material.blockhash,
      createTransferInstruction(
        new PublicKey(txFixture._fixed_material.signer_ata),
        OUTSIDE_DEST,
        signer,
        1_000,
      ),
    ),
  };

  interface Phase {
    label: string;
    env: Record<string, string>;
    cases: Case[];
    /** Checks that go to the Rust daemon alone; see [`oversizeFrame`]. */
    rustOnly?: (workspace: Workspace) => Promise<void>;
  }

  const phases: Phase[] = [
    {
      label: 'no destination whitelist',
      env: {},
      cases: openPhase(corpus),
      rustOnly: oversizeFrame,
    },
    {
      label: `SIGNER_DEST_WHITELIST=${OUTSIDE_DEST}`,
      env: { SIGNER_DEST_WHITELIST: OUTSIDE_DEST.toBase58() },
      cases: whitelistedPhase(corpus),
    },
  ];

  try {
    for (const phase of phases) {
      console.log(`\n── Both signers up: ${phase.label} ──`);
      const ts = await startTsSigner({
        dir: tsDir,
        keyfilePath: workspace.keyfilePath,
        socketPath: tsSocket,
        rpcUrl: rpc.url,
        env: phase.env,
      });
      const rust = await startDaemon({ workspace, rpcUrl: rpc.url, env: phase.env });

      console.log('\nChecks:');
      try {
        for (const kase of phase.cases) {
          await compare(kase, { ts: tsSocket, rust: workspace.socketPath }, corpus.restoreChain);
        }
        await phase.rustOnly?.(workspace);
      } finally {
        await stopDaemon(rust);
        await stopDaemon(ts);
      }
    }
  } finally {
    await rpc.close();
    workspace.cleanup();
  }

  printTable();
  printDivergences();
  report();
}

/**
 * The frame cap, against the Rust daemon alone.
 *
 * Not sent to the TypeScript signer, and the reason is the shape of the check
 * rather than politeness: `sendFrameExpectingClose` waits for the server to hang
 * up, and `signer/index.ts:279-308` never does. It has no cap at all — it takes
 * the declared length on faith and keeps concatenating chunks until it has that
 * many bytes — so the case would sit on the socket until the client's own
 * 30-second timeout fired, once per run, having proved only that a timeout
 * works. The unbounded buffering it would demonstrate is the thing
 * `MAX_FRAME_LEN` exists to prevent, and `signer-core/src/protocol.rs` records
 * it as a deliberate divergence.
 */
async function oversizeFrame(workspace: Workspace): Promise<void> {
  await check('a 70 KiB frame (Rust only — see the note under the table)', async () => {
    const { result, serverClosed } = await sendFrameExpectingClose(
      workspace.socketPath,
      Buffer.alloc(70 * 1024, 0x78),
    );
    if (!result) throw new Error('the server closed without answering');
    expectRejected(result, 'Frame too large: 71680 bytes exceeds the 65536-byte limit');
    if (!serverClosed) throw new Error('the server left the connection open');

    rows.push({
      name: 'a 70 KiB frame',
      ts: '(not sent)',
      rust: cell(result),
      verdict: 'expected',
    });
    notes.push({
      name: 'a 70 KiB frame',
      kind: 'not sent',
      why:
        'The TypeScript signer has no frame cap: it reads the declared length and buffers until ' +
        'that many bytes arrive, so a 4-byte write can pin as much memory as the header asks ' +
        'for. `read_frame` refuses anything past MAX_FRAME_LEN and closes, because the rest of ' +
        'the payload is still unread and there is no frame boundary left to resynchronise to. ' +
        'The case is not sent to the TypeScript signer because the client waits for a close ' +
        'that never comes — it would cost a 30-second timeout and prove nothing.',
      ts: '(not sent)',
      rust: render(result),
    });
    return 'refused, then closed';
  });
}

main().catch((err) => {
  console.error(`\ne2e harness failed: ${err instanceof Error ? err.stack : err}`);
  process.exitCode = 1;
});
