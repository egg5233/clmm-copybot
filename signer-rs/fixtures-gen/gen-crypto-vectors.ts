/**
 * Generates `crypto_vectors.json` — golden vectors for the Rust port of the
 * keyfile encryption format used by the TypeScript signer.
 *
 * The vectors are produced by the REAL implementation (`signer/crypto.ts`), so a
 * Rust implementation that decrypts them byte-for-byte is provably compatible
 * with keyfiles already on disk in production.
 *
 * Offline and dependency-free: no RPC, no network, no reading of any real keyfile.
 * The encrypted secret is a throwaway keypair derived from a fixed seed.
 *
 * NOT deterministic across runs: `encryptKey` draws a fresh random salt and IV
 * each call, so re-running this generator produces a different (equally valid)
 * `crypto_vectors.json`. See README.md.
 *
 * Run: npm run generate:crypto
 */
import fs from 'fs';
import path from 'path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { encryptKey, decryptKey } from '../../signer/crypto';

/** The keyfile shape written by `signer/setup.ts` (hex-encoded fields). */
type Keyfile = ReturnType<typeof encryptKey>;

const OUT_PATH = path.resolve(
  __dirname,
  '../crates/signer-core/tests/fixtures/crypto_vectors.json',
);

/** Fixed seed for the throwaway keypair — see README.md. */
const KEY_SEED_BYTE = 0x42;
const PASSWORD = 'test-password-123';
const WRONG_PASSWORD = 'wrong';

/** Mirrors the constants in signer/crypto.ts so the Rust port can assert on them. */
const CRYPTO_PARAMS = {
  algorithm: 'aes-256-gcm',
  kdf: 'scrypt',
  scrypt_n: 16384,
  scrypt_r: 8,
  scrypt_p: 1,
  key_len: 32,
  salt_len: 32,
  iv_len: 16,
  tag_len: 16,
  encoding: 'hex',
  plaintext_encoding: 'utf-8',
} as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`fixture sanity check failed: ${message}`);
}

/** Returns the error message if decryption throws, or null if it unexpectedly succeeds. */
function decryptError(keyfile: Keyfile, password: string): string | null {
  try {
    decryptKey(keyfile, password);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

function main(): void {
  // ── Throwaway key material ────────────────────────────────────────────────
  const keypair = Keypair.fromSeed(Uint8Array.from(new Array(32).fill(KEY_SEED_BYTE)));
  // setup.ts encrypts the base58 of the full 64-byte secret key, so match that.
  const secretKeyBase58 = bs58.encode(keypair.secretKey);
  const pubkey = keypair.publicKey.toBase58();

  assert(keypair.secretKey.length === 64, 'ed25519 secret key must be 64 bytes');

  // ── Vector 1: valid keyfile + correct password ────────────────────────────
  const validKeyfile = encryptKey(secretKeyBase58, PASSWORD);

  const roundTrip = decryptKey(validKeyfile, PASSWORD);
  assert(
    roundTrip === secretKeyBase58,
    `round trip mismatch: decryptKey returned ${roundTrip.slice(0, 12)}… expected ${secretKeyBase58.slice(0, 12)}…`,
  );
  assert(Buffer.from(validKeyfile.salt, 'hex').length === CRYPTO_PARAMS.salt_len, 'salt length');
  assert(Buffer.from(validKeyfile.iv, 'hex').length === CRYPTO_PARAMS.iv_len, 'iv length');
  assert(Buffer.from(validKeyfile.tag, 'hex').length === CRYPTO_PARAMS.tag_len, 'tag length');

  // ── Vector 2: same keyfile, wrong password ────────────────────────────────
  const wrongPasswordError = decryptError(validKeyfile, WRONG_PASSWORD);
  assert(wrongPasswordError !== null, 'wrong password must not decrypt');

  // ── Vector 3: valid password, first auth-tag byte flipped ─────────────────
  const tamperedTag = Buffer.from(validKeyfile.tag, 'hex');
  tamperedTag[0] ^= 0xff;
  const tamperedKeyfile: Keyfile = { ...validKeyfile, tag: tamperedTag.toString('hex') };
  assert(tamperedKeyfile.tag !== validKeyfile.tag, 'tampering must change the tag');

  const tamperedError = decryptError(tamperedKeyfile, PASSWORD);
  assert(tamperedError !== null, 'tampered auth tag must fail GCM verification');

  const output = {
    _generator: 'signer-rs/fixtures-gen/gen-crypto-vectors.ts',
    _source_of_truth: 'signer/crypto.ts (encryptKey / decryptKey)',
    _deterministic: false,
    _determinism_note:
      'encryptKey draws a random 32-byte salt and 16-byte IV per call, so salt/iv/tag/data ' +
      'differ on every regeneration. The vectors stay valid because the Rust port is asserted ' +
      'against the values recorded here, not against a fixed ciphertext.',
    _key_material_note:
      `Throwaway ed25519 keypair from the fixed 32-byte seed [0x${KEY_SEED_BYTE.toString(16)}; 32]. ` +
      'Never used on-chain, holds no funds. The same seed backs the signer keypair in tx_vectors.json.',
    params: CRYPTO_PARAMS,
    vectors: [
      {
        name: 'valid',
        description: 'Correct password decrypts the keyfile to the original base58 secret key.',
        keyfile: validKeyfile,
        password: PASSWORD,
        expect: 'ok',
        expected_plaintext_base58: secretKeyBase58,
        expected_pubkey: pubkey,
      },
      {
        name: 'wrong_password',
        description:
          'Wrong password derives a different AES key, so GCM tag verification fails in final().',
        keyfile: validKeyfile,
        password: WRONG_PASSWORD,
        expect: 'error',
        expected_error_message: wrongPasswordError,
      },
      {
        name: 'tampered_tag',
        description:
          'Valid keyfile with the first auth-tag byte XORed by 0xFF; correct password, but GCM ' +
          'authentication must reject it. Guards against a port that ignores the tag.',
        keyfile: tamperedKeyfile,
        password: PASSWORD,
        expect: 'error',
        expected_error_message: tamperedError,
      },
    ],
  };

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, `${JSON.stringify(output, null, 2)}\n`);

  console.log(`wrote ${OUT_PATH}`);
  console.log(`  pubkey            ${pubkey}`);
  console.log(`  round trip        ok (decryptKey === original base58)`);
  console.log(`  wrong_password    rejected: ${wrongPasswordError}`);
  console.log(`  tampered_tag      rejected: ${tamperedError}`);
}

main();
