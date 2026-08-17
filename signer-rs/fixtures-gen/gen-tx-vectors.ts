/**
 * Generates `tx_vectors.json` and `alt_vectors.json` — golden vectors for the Rust
 * port of the signer's transaction handling (deserialize → inspect → sign → serialize).
 *
 * Every transaction is built by the REAL @solana/web3.js encoder from fixed seeds and a
 * fixed blockhash, so the output is byte-identical on every run. The `expected` blocks are
 * derived by re-parsing the serialized bytes with the same logic the signer uses
 * (`signer/alt-resolver.ts` `extractProgramIds` is imported directly; the account-key and
 * SPL-transfer extraction mirrors `signer/policy.ts`), so the fixtures encode the actual
 * production semantics rather than a hand-written guess.
 *
 * Offline: no RPC. The address lookup table is constructed and serialized locally, then
 * round-tripped through `AddressLookupTableAccount.deserialize` to prove the byte layout.
 *
 * Run: npm run generate:tx
 */
import fs from 'fs';
import path from 'path';
import {
  AddressLookupTableAccount,
  Keypair,
  MessageV0,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  createTransferCheckedInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { extractProgramIds } from '../../signer/alt-resolver';

const FIXTURES_DIR = path.resolve(__dirname, '../crates/signer-core/tests/fixtures');
const TX_OUT_PATH = path.join(FIXTURES_DIR, 'tx_vectors.json');
const ALT_OUT_PATH = path.join(FIXTURES_DIR, 'alt_vectors.json');

/** SPL Token instruction discriminators — mirrors signer/policy.ts. */
const SPL_TRANSFER = 3;
const SPL_TRANSFER_CHECKED = 12;

/** Serialized size of the on-chain address lookup table header, per web3.js. */
const LOOKUP_TABLE_META_SIZE = 56;
/** Account-type discriminator for a lookup table (`typeIndex` u32 LE at offset 0). */
const LOOKUP_TABLE_TYPE_INDEX = 1;
const U64_MAX = BigInt('0xffffffffffffffff');

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`fixture sanity check failed: ${message}`);
}

/** A fixed 32-byte seed of a single repeated byte — see README.md for the seed table. */
function seed(byte: number): Uint8Array {
  return Uint8Array.from(new Array(32).fill(byte));
}

function keypairFromSeed(byte: number): Keypair {
  return Keypair.fromSeed(seed(byte));
}

// ── Fixed key material (all throwaway, all offline-derivable) ────────────────
const SIGNER = keypairFromSeed(0x42); // same seed as crypto_vectors.json
const EXTRA = keypairFromSeed(0x43); // extra local signer (DAMMv2 position keypair shape)
const RECIPIENT = keypairFromSeed(0x44).publicKey;
const MINT = keypairFromSeed(0x45).publicKey;
const ALT_KEY = keypairFromSeed(0x50).publicKey;
const ALT_AUTHORITY = keypairFromSeed(0x51).publicKey;
const ALT_ADDRESS_SEEDS = [0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67];
const ALT_ADDRESSES = ALT_ADDRESS_SEEDS.map((b) => keypairFromSeed(b).publicKey);

/** Fixed blockhash so serialization is deterministic (32 × 0x01, base58). */
const BLOCKHASH = bs58.encode(Buffer.alloc(32, 0x01));

const SIGNER_ATA = getAssociatedTokenAddressSync(MINT, SIGNER.publicKey);
const DEST_ATA = getAssociatedTokenAddressSync(MINT, RECIPIENT);

// ── Extraction helpers (mirror the signer's own logic) ──────────────────────

interface TransferExpectation {
  ix_index: number;
  program_id: string;
  discriminator: number;
  kind: 'transfer' | 'transfer_checked';
  source: string;
  dest: string;
  mint?: string;
  authority: string;
  amount: string;
  decimals?: number;
}

interface SignatureSlot {
  index: number;
  pubkey: string;
  present: boolean;
}

/** Reads the little-endian u64 amount at data[1..9] of an SPL transfer instruction. */
function readAmount(data: Uint8Array): string {
  return Buffer.from(data.slice(1, 9)).readBigUInt64LE(0).toString();
}

/**
 * Full account key list for a legacy transaction, mirroring signer/policy.ts: the program id
 * and account metas of every instruction, flattened in instruction order and deduplicated.
 * Deliberately NOT the compiled message order — the Rust port must reproduce this ordering.
 */
function legacyAccountKeys(tx: Transaction): PublicKey[] {
  const flat = tx.instructions.flatMap((ix) => [ix.programId, ...ix.keys.map((k) => k.pubkey)]);
  const seen = new Set<string>();
  return flat.filter((k) => {
    const s = k.toBase58();
    if (seen.has(s)) return false;
    seen.add(s);
    return true;
  });
}

/** SPL transfer destinations in a legacy transaction, mirroring signer/policy.ts. */
function legacyTransfers(tx: Transaction): TransferExpectation[] {
  const out: TransferExpectation[] = [];
  tx.instructions.forEach((ix, ixIndex) => {
    const programId = ix.programId.toBase58();
    if (programId !== TOKEN_PROGRAM_ID.toBase58()) return;
    const disc = ix.data[0];
    if (disc !== SPL_TRANSFER && disc !== SPL_TRANSFER_CHECKED) return;
    const checked = disc === SPL_TRANSFER_CHECKED;
    out.push({
      ix_index: ixIndex,
      program_id: programId,
      discriminator: disc,
      kind: checked ? 'transfer_checked' : 'transfer',
      source: ix.keys[0].pubkey.toBase58(),
      dest: ix.keys[checked ? 2 : 1].pubkey.toBase58(),
      ...(checked ? { mint: ix.keys[1].pubkey.toBase58() } : {}),
      authority: ix.keys[checked ? 3 : 2].pubkey.toBase58(),
      amount: readAmount(ix.data),
      ...(checked ? { decimals: ix.data[9] } : {}),
    });
  });
  return out;
}

/**
 * Full account key list for a versioned transaction after ALT expansion:
 * static keys ++ writable lookups ++ readonly lookups. Mirrors signer/alt-resolver.ts
 * `resolveALTs`, minus the RPC fetch (the lookup table is supplied directly).
 */
function versionedAccountKeys(
  message: MessageV0,
  lookupTables: AddressLookupTableAccount[],
): PublicKey[] {
  const keys =
    message.addressTableLookups.length > 0
      ? message.getAccountKeys({ addressLookupTableAccounts: lookupTables })
      : message.getAccountKeys();
  const out: PublicKey[] = [];
  for (let i = 0; i < keys.length; i++) {
    out.push(keys.get(i)!);
  }
  return out;
}

/** SPL transfer destinations in a versioned transaction, mirroring signer/policy.ts. */
function versionedTransfers(message: MessageV0, allKeys: PublicKey[]): TransferExpectation[] {
  const out: TransferExpectation[] = [];
  message.compiledInstructions.forEach((ix, ixIndex) => {
    const programId = allKeys[ix.programIdIndex]?.toBase58();
    if (programId !== TOKEN_PROGRAM_ID.toBase58()) return;
    const disc = ix.data[0];
    if (disc !== SPL_TRANSFER && disc !== SPL_TRANSFER_CHECKED) return;
    const checked = disc === SPL_TRANSFER_CHECKED;
    const key = (n: number): string => allKeys[ix.accountKeyIndexes[n]].toBase58();
    out.push({
      ix_index: ixIndex,
      program_id: programId,
      discriminator: disc,
      kind: checked ? 'transfer_checked' : 'transfer',
      source: key(0),
      dest: key(checked ? 2 : 1),
      ...(checked ? { mint: key(1) } : {}),
      authority: key(checked ? 3 : 2),
      amount: readAmount(ix.data),
      ...(checked ? { decimals: ix.data[9] } : {}),
    });
  });
  return out;
}

function legacySignatureSlots(tx: Transaction): SignatureSlot[] {
  return tx.signatures.map((sig, index) => ({
    index,
    pubkey: sig.publicKey.toBase58(),
    present: sig.signature !== null,
  }));
}

function versionedSignatureSlots(tx: VersionedTransaction): SignatureSlot[] {
  const header = tx.message.header;
  return tx.signatures.map((sig, index) => ({
    index,
    pubkey:
      index < header.numRequiredSignatures
        ? tx.message.staticAccountKeys[index].toBase58()
        : '<unknown>',
    present: sig.some((b) => b !== 0),
  }));
}

// ── Address lookup table serialization ──────────────────────────────────────

/**
 * Serializes a lookup table into its on-chain account data layout.
 *
 * Layout (offsets in bytes):
 *   0..4    typeIndex                    u32 LE  (1 = LookupTable)
 *   4..12   deactivation_slot            u64 LE
 *   12..20  last_extended_slot           u64 LE
 *   20..21  last_extended_slot_start_idx u8
 *   21..22  authority Option tag         u8      (1 = Some)
 *   22..54  authority                    Pubkey  (present when tag = 1)
 *   54..56  padding                      u16
 *   56..    addresses                    Pubkey[] packed, 32 bytes each
 */
function serializeLookupTable(state: {
  deactivationSlot: bigint;
  lastExtendedSlot: number;
  lastExtendedSlotStartIndex: number;
  authority?: PublicKey;
  addresses: PublicKey[];
}): Buffer {
  const header = Buffer.alloc(LOOKUP_TABLE_META_SIZE);
  header.writeUInt32LE(LOOKUP_TABLE_TYPE_INDEX, 0);
  header.writeBigUInt64LE(state.deactivationSlot, 4);
  header.writeBigUInt64LE(BigInt(state.lastExtendedSlot), 12);
  header.writeUInt8(state.lastExtendedSlotStartIndex, 20);
  header.writeUInt8(state.authority ? 1 : 0, 21);
  if (state.authority) {
    Buffer.from(state.authority.toBytes()).copy(header, 22);
  }
  // bytes 54..56 stay zero — alignment padding before the address vector
  const addresses = Buffer.concat(state.addresses.map((a) => Buffer.from(a.toBytes())));
  return Buffer.concat([header, addresses]);
}

// ── Vector builders ─────────────────────────────────────────────────────────

interface TxVector {
  name: string;
  description: string;
  kind: 'legacy' | 'versioned';
  unsigned_b64: string;
  unsigned_len: number;
  ts_signed_b64: string;
  ts_signed_len: number;
  signed_by: string[];
  expected: Record<string, unknown>;
}

function legacyVector(
  name: string,
  description: string,
  tx: Transaction,
  preSigners: Keypair[],
  finalSigners: Keypair[],
): TxVector {
  for (const kp of preSigners) tx.partialSign(kp);
  const unsigned = tx.serialize({ requireAllSignatures: false });

  // Expectations are derived from the bytes the signer daemon actually receives.
  const parsed = Transaction.from(unsigned);
  const accountKeys = legacyAccountKeys(parsed);

  for (const kp of finalSigners) tx.partialSign(kp);
  const signed = tx.serialize();

  return {
    name,
    description,
    kind: 'legacy',
    unsigned_b64: Buffer.from(unsigned).toString('base64'),
    unsigned_len: unsigned.length,
    ts_signed_b64: Buffer.from(signed).toString('base64'),
    ts_signed_len: signed.length,
    signed_by: [...preSigners, ...finalSigners].map((k) => k.publicKey.toBase58()),
    expected: {
      fee_payer: parsed.feePayer!.toBase58(),
      recent_blockhash: parsed.recentBlockhash!,
      num_instructions: parsed.instructions.length,
      // policy.ts maps instructions directly, so duplicates are NOT collapsed here.
      program_ids: parsed.instructions.map((ix) => ix.programId.toBase58()),
      account_keys: accountKeys.map((k) => k.toBase58()),
      account_keys_source:
        'signer/policy.ts legacy branch: flatMap([programId, ...keys]) over instructions, deduped, instruction order',
      address_table_lookups: [],
      signature_slots: legacySignatureSlots(parsed),
      transfers: legacyTransfers(parsed),
    },
  };
}

function versionedVector(
  name: string,
  description: string,
  message: MessageV0,
  lookupTables: AddressLookupTableAccount[],
): TxVector {
  const tx = new VersionedTransaction(message);
  const unsigned = tx.serialize();

  const parsed = VersionedTransaction.deserialize(unsigned);
  const parsedMessage = parsed.message as MessageV0;
  const accountKeys = versionedAccountKeys(parsedMessage, lookupTables);
  const programIds = extractProgramIds(accountKeys, parsed);

  tx.sign([SIGNER]);
  const signed = tx.serialize();

  return {
    name,
    description,
    kind: 'versioned',
    unsigned_b64: Buffer.from(unsigned).toString('base64'),
    unsigned_len: unsigned.length,
    ts_signed_b64: Buffer.from(signed).toString('base64'),
    ts_signed_len: signed.length,
    signed_by: [SIGNER.publicKey.toBase58()],
    expected: {
      fee_payer: parsedMessage.staticAccountKeys[0].toBase58(),
      recent_blockhash: parsedMessage.recentBlockhash,
      num_instructions: parsedMessage.compiledInstructions.length,
      // extractProgramIds (signer/alt-resolver.ts) dedupes via a Set, first-seen order.
      program_ids: programIds.map((p) => p.toBase58()),
      static_account_keys: parsedMessage.staticAccountKeys.map((k) => k.toBase58()),
      account_keys: accountKeys.map((k) => k.toBase58()),
      account_keys_source:
        'signer/alt-resolver.ts resolveALTs: static keys ++ writable lookups ++ readonly lookups',
      address_table_lookups: parsedMessage.addressTableLookups.map((l) => ({
        account_key: l.accountKey.toBase58(),
        writable_indexes: Array.from(l.writableIndexes),
        readonly_indexes: Array.from(l.readonlyIndexes),
      })),
      signature_slots: versionedSignatureSlots(parsed),
      transfers: versionedTransfers(parsedMessage, accountKeys),
    },
  };
}

// ── Main ────────────────────────────────────────────────────────────────────

function buildAltAccount(): {
  account: AddressLookupTableAccount;
  raw: Buffer;
} {
  const state = {
    deactivationSlot: U64_MAX, // never deactivated → isActive() === true
    lastExtendedSlot: 0,
    lastExtendedSlotStartIndex: 0,
    authority: ALT_AUTHORITY,
    addresses: ALT_ADDRESSES,
  };
  const raw = serializeLookupTable(state);

  // Prove the hand-rolled layout matches what web3.js (and therefore the chain) expects.
  const decoded = AddressLookupTableAccount.deserialize(raw);
  assert(
    decoded.deactivationSlot === state.deactivationSlot,
    `ALT round trip: deactivationSlot ${decoded.deactivationSlot} != ${state.deactivationSlot}`,
  );
  assert(
    decoded.lastExtendedSlot === state.lastExtendedSlot,
    `ALT round trip: lastExtendedSlot ${decoded.lastExtendedSlot}`,
  );
  assert(
    decoded.lastExtendedSlotStartIndex === state.lastExtendedSlotStartIndex,
    `ALT round trip: lastExtendedSlotStartIndex ${decoded.lastExtendedSlotStartIndex}`,
  );
  assert(
    decoded.authority?.equals(ALT_AUTHORITY),
    `ALT round trip: authority ${decoded.authority?.toBase58()} != ${ALT_AUTHORITY.toBase58()}`,
  );
  const decodedAddresses = decoded.addresses.map((a) => a.toBase58());
  const expectedAddresses = ALT_ADDRESSES.map((a) => a.toBase58());
  assert(
    JSON.stringify(decodedAddresses) === JSON.stringify(expectedAddresses),
    `ALT round trip: addresses mismatch\n  got      ${decodedAddresses.join(',')}\n  expected ${expectedAddresses.join(',')}`,
  );

  return { account: new AddressLookupTableAccount({ key: ALT_KEY, state }), raw };
}

function main(): void {
  const { account: altAccount, raw: altRaw } = buildAltAccount();

  // (a) legacy_spl_transfer — the DAC / plain token-move shape.
  const txA = new Transaction({ feePayer: SIGNER.publicKey, recentBlockhash: BLOCKHASH });
  txA.add(createTransferInstruction(SIGNER_ATA, DEST_ATA, SIGNER.publicKey, 1_234_567n));
  const vectorA = legacyVector(
    'legacy_spl_transfer',
    'Legacy transaction with a single SPL Token Transfer (discriminator 3) from the signer ATA ' +
      'to a fixed destination ATA. Only the signer signs.',
    txA,
    [],
    [SIGNER],
  );

  // (b) legacy_two_signer_presigned — the signLegacyWithExtra shape
  //     (src/utils/wallet.ts:144-159): extra signers sign locally, the daemon adds the main key.
  const txB = new Transaction({ feePayer: SIGNER.publicKey, recentBlockhash: BLOCKHASH });
  txB.add(
    SystemProgram.createAccount({
      fromPubkey: SIGNER.publicKey,
      newAccountPubkey: EXTRA.publicKey,
      lamports: 2_039_280,
      space: 165,
      programId: TOKEN_PROGRAM_ID,
    }),
  );
  txB.add(createTransferInstruction(SIGNER_ATA, DEST_ATA, SIGNER.publicKey, 500n));
  const vectorB = legacyVector(
    'legacy_two_signer_presigned',
    'Legacy transaction requiring two signatures. The extra keypair has already signed, so the ' +
      'unsigned bytes carry one real signature and one zero-filled slot at the fee-payer index. ' +
      'The port must fill slot 0 without disturbing slot 1.',
    txB,
    [EXTRA],
    [SIGNER],
  );

  // (c) v0_no_alt — versioned message with no lookup tables.
  const messageC = new TransactionMessage({
    payerKey: SIGNER.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [
      SystemProgram.transfer({
        fromPubkey: SIGNER.publicKey,
        toPubkey: RECIPIENT,
        lamports: 1_000_000,
      }),
      createTransferInstruction(SIGNER_ATA, DEST_ATA, SIGNER.publicKey, 42n),
    ],
  }).compileToV0Message([]);
  const vectorC = versionedVector(
    'v0_no_alt',
    'VersionedTransaction (MessageV0) with a System transfer and an SPL transfer, compiled ' +
      'without lookup tables. Unsigned bytes carry a zero-filled signature slot.',
    messageC,
    [],
  );

  // (d) v0_with_alt — versioned message whose accounts resolve through a lookup table.
  const messageD = new TransactionMessage({
    payerKey: SIGNER.publicKey,
    recentBlockhash: BLOCKHASH,
    instructions: [
      // Writable lookups: source + destination token accounts.
      createTransferInstruction(ALT_ADDRESSES[0], ALT_ADDRESSES[1], SIGNER.publicKey, 12_345n),
      // Readonly lookup: the mint of a TransferChecked.
      createTransferCheckedInstruction(
        ALT_ADDRESSES[4],
        ALT_ADDRESSES[3],
        ALT_ADDRESSES[5],
        SIGNER.publicKey,
        6_789n,
        6,
      ),
    ],
  }).compileToV0Message([altAccount]);
  assert(
    messageD.addressTableLookups.length === 1,
    'v0_with_alt must compile with exactly one address table lookup',
  );
  const lookup = messageD.addressTableLookups[0];
  assert(lookup.writableIndexes.length > 0, 'v0_with_alt must have writable lookups');
  assert(lookup.readonlyIndexes.length > 0, 'v0_with_alt must have readonly lookups');
  const vectorD = versionedVector(
    'v0_with_alt',
    'VersionedTransaction whose token accounts resolve through one address lookup table, with ' +
      'both writable (transfer source/destination) and readonly (TransferChecked mint) lookups. ' +
      'Program ids and account keys in `expected` are post-expansion. The table itself is in ' +
      'alt_vectors.json.',
    messageD,
    [altAccount],
  );

  const vectors = [vectorA, vectorB, vectorC, vectorD];

  // Sanity: signing must not change the message, only the signature block.
  for (const v of vectors) {
    assert(
      v.unsigned_len === v.ts_signed_len,
      `${v.name}: signing changed the serialized length (${v.unsigned_len} → ${v.ts_signed_len})`,
    );
    assert(v.unsigned_b64 !== v.ts_signed_b64, `${v.name}: signing produced identical bytes`);
  }

  const txOutput = {
    _generator: 'signer-rs/fixtures-gen/gen-tx-vectors.ts',
    _source_of_truth:
      'signer/alt-resolver.ts (extractProgramIds, resolveALTs ordering) and signer/policy.ts ' +
      '(legacy account-key dedup, SPL transfer field offsets)',
    _deterministic: true,
    _fixed_material: {
      signer_pubkey: SIGNER.publicKey.toBase58(),
      signer_seed: '[0x42; 32]',
      extra_signer_pubkey: EXTRA.publicKey.toBase58(),
      extra_signer_seed: '[0x43; 32]',
      recipient_pubkey: RECIPIENT.toBase58(),
      recipient_seed: '[0x44; 32]',
      mint: MINT.toBase58(),
      mint_seed: '[0x45; 32]',
      signer_ata: SIGNER_ATA.toBase58(),
      dest_ata: DEST_ATA.toBase58(),
      blockhash: BLOCKHASH,
      blockhash_bytes: '[0x01; 32]',
      token_program: TOKEN_PROGRAM_ID.toBase58(),
      system_program: SystemProgram.programId.toBase58(),
    },
    _field_notes: {
      unsigned_b64:
        'What the bot sends to the signer: legacy uses serialize({requireAllSignatures:false}), ' +
        'versioned uses serialize() on an unsigned VersionedTransaction (zero-filled signatures).',
      ts_signed_b64: 'The same transaction after the TypeScript signer adds the signer key.',
      program_ids:
        'Legacy: one entry per instruction, duplicates kept (policy.ts maps instructions). ' +
        'Versioned: deduplicated first-seen order (extractProgramIds uses a Set).',
      account_keys:
        'See account_keys_source on each vector — the two paths order keys differently.',
      transfers:
        'Every SPL Transfer / TransferChecked the policy engine would inspect, with the ' +
        'destination it resolves. amount is a decimal u64 string.',
      signature_slots:
        'Signature block of the UNSIGNED bytes: which slots the port must fill and which are ' +
        'already occupied by a pre-signed extra signer.',
    },
    vectors,
  };

  const altOutput = {
    _generator: 'signer-rs/fixtures-gen/gen-tx-vectors.ts',
    _deterministic: true,
    _note:
      'The lookup table referenced by the v0_with_alt vector. raw_account_data_b64 is the ' +
      'on-chain account data the signer would fetch via getMultipleAccountsInfo, so the Rust ' +
      'ALT parser can be tested without RPC. Verified by round-tripping through ' +
      'AddressLookupTableAccount.deserialize().',
    alt_account_key: ALT_KEY.toBase58(),
    alt_account_key_seed: '[0x50; 32]',
    authority: ALT_AUTHORITY.toBase58(),
    authority_seed: '[0x51; 32]',
    deactivation_slot: U64_MAX.toString(),
    deactivation_slot_note: 'u64::MAX — the table is active (never deactivated).',
    last_extended_slot: 0,
    last_extended_slot_start_index: 0,
    address_seeds: ALT_ADDRESS_SEEDS.map((b) => `[0x${b.toString(16)}; 32]`),
    addresses: ALT_ADDRESSES.map((a) => a.toBase58()),
    raw_account_data_b64: altRaw.toString('base64'),
    raw_account_data_len: altRaw.length,
    round_trip_verified: true,
    layout: {
      meta_size: LOOKUP_TABLE_META_SIZE,
      fields: [
        '0..4    type_index                   u32 LE (1 = LookupTable)',
        '4..12   deactivation_slot            u64 LE',
        '12..20  last_extended_slot           u64 LE',
        '20..21  last_extended_slot_start_idx u8',
        '21..22  authority Option tag         u8 (1 = Some)',
        '22..54  authority                    Pubkey',
        '54..56  padding                      u16',
        '56..    addresses                    Pubkey[] packed, 32 bytes each',
      ],
    },
  };

  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  fs.writeFileSync(TX_OUT_PATH, `${JSON.stringify(txOutput, null, 2)}\n`);
  fs.writeFileSync(ALT_OUT_PATH, `${JSON.stringify(altOutput, null, 2)}\n`);

  console.log(`wrote ${TX_OUT_PATH}`);
  for (const v of vectors) {
    console.log(
      `  ${v.name.padEnd(28)} ${v.kind.padEnd(10)} unsigned ${v.unsigned_len}B  signed ${v.ts_signed_len}B`,
    );
  }
  console.log(`wrote ${ALT_OUT_PATH}`);
  console.log(
    `  ALT ${ALT_KEY.toBase58()} — ${ALT_ADDRESSES.length} addresses, ${altRaw.length}B account data, round trip ok`,
  );
}

main();
