import net from 'net';
import { Keypair, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { config } from '../config';
import { observeSignerSign } from '../dashboard/metrics';
import { SignerCallback } from 'byreal-clmm-sdk-alpha';

// ── Mode detection ──────────────────────────────────────────────────────────
// Signer mode:  SIGNER_SOCKET_PATH is set → no private key in this process
// Legacy mode:  PRIVATE_KEY is present → sign in-process (backward compatible)
const useRemoteSigner = !!config.signerSocketPath;

// ── Legacy in-process keypair (only used when NOT in signer mode) ───────────
let _keypair: Keypair | null = null;

/**
 * @deprecated Use getUserAddress() for the public key.
 * In signer mode this throws — the private key is not in this process.
 */
export function getKeypair(): Keypair {
  if (useRemoteSigner) {
    throw new Error(
      'getKeypair() is disabled in signer mode — private key is held by the signer service',
    );
  }
  if (!_keypair) {
    if (!config.privateKey)
      throw new Error('PRIVATE_KEY not configured and SIGNER_SOCKET_PATH not set');
    const secretKey = bs58.decode(config.privateKey);
    _keypair = Keypair.fromSecretKey(secretKey);
  }
  return _keypair;
}

// ── Public key (works in both modes) ────────────────────────────────────────
let _publicKey: PublicKey | null = null;

export function getUserAddress(): PublicKey {
  if (!_publicKey) {
    if (useRemoteSigner) {
      if (!config.walletPublicKey) throw new Error('WALLET_PUBLIC_KEY required in signer mode');
      _publicKey = new PublicKey(config.walletPublicKey);
    } else {
      _publicKey = getKeypair().publicKey;
    }
  }
  return _publicKey;
}

// ── Remote signer client (Unix socket) ──────────────────────────────────────

/**
 * Send an unsigned transaction to the signer service and receive it back signed.
 * Protocol: 4-byte big-endian length prefix + JSON payload.
 * Request:  { type: "versioned"|"legacy", tx: "<base64 serialized unsigned TX>" }
 * Response: { ok: true, tx: "<base64 serialized signed TX>" }
 *       or  { ok: false, error: "reason" }
 */
function sendToSigner(payload: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(config.signerSocketPath, () => {
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

async function remoteSign(type: 'versioned' | 'legacy', txBytes: Uint8Array): Promise<Uint8Array> {
  const request = JSON.stringify({
    type,
    tx: Buffer.from(txBytes).toString('base64'),
  });

  // Timed around the socket round trip, and in the `finally` so a rejected or
  // timed-out signing still lands in the histogram — a signer that hangs and
  // then fails is exactly what the +Inf bucket is meant to surface.
  const startedAt = process.hrtime.bigint();
  try {
    const response = await sendToSigner(Buffer.from(request, 'utf-8'));
    const result = JSON.parse(response.toString('utf-8'));

    if (!result.ok) {
      throw new Error(`Signer rejected TX: ${result.error}`);
    }

    return Buffer.from(result.tx, 'base64');
  } finally {
    observeSignerSign(Number(process.hrtime.bigint() - startedAt) / 1e9);
  }
}

// ── Public signing API (works in both modes) ────────────────────────────────

/** Sign a VersionedTransaction (used by Jupiter, auto-claim, and SDK signerCallback). */
export async function signVersioned(tx: VersionedTransaction): Promise<VersionedTransaction> {
  if (useRemoteSigner) {
    const unsigned = tx.serialize();
    const signedBytes = await remoteSign('versioned', unsigned);
    return VersionedTransaction.deserialize(signedBytes);
  }
  tx.sign([getKeypair()]);
  return tx;
}

/** Sign a legacy Transaction (used by Meteora, DAMMv2, DAC). */
export async function signLegacy(tx: Transaction): Promise<Transaction> {
  if (useRemoteSigner) {
    const unsigned = tx.serialize({ requireAllSignatures: false });
    const signedBytes = await remoteSign('legacy', unsigned);
    return Transaction.from(signedBytes);
  }
  tx.sign(getKeypair());
  return tx;
}

/** Sign a legacy Transaction with additional signers (used by DAMMv2 createPosition). */
export async function signLegacyWithExtra(
  tx: Transaction,
  extraSigners: Keypair[],
): Promise<Transaction> {
  if (useRemoteSigner) {
    // Extra signers (e.g. position keypair) sign locally first, then the main key signs remotely
    for (const signer of extraSigners) {
      tx.partialSign(signer);
    }
    const partialBytes = tx.serialize({ requireAllSignatures: false });
    const signedBytes = await remoteSign('legacy', partialBytes);
    return Transaction.from(signedBytes);
  }
  tx.sign(getKeypair(), ...extraSigners);
  return tx;
}

// ── SDK signerCallback (used by byreal-clmm-sdk-alpha / PCS) ───────────────

export const signerCallback: SignerCallback = async (tx: VersionedTransaction) => {
  return signVersioned(tx);
};

// ── Anchor Wallet adapter (used by Orca WhirlpoolContext) ───────────────────

/**
 * Implements the Anchor Wallet interface by forwarding signTransaction
 * to the signer service. Works in both remote and legacy modes.
 */
export class RemoteSignerWallet {
  get publicKey(): PublicKey {
    return getUserAddress();
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    if (tx instanceof VersionedTransaction) {
      return signVersioned(tx) as Promise<T>;
    }
    return signLegacy(tx as Transaction) as Promise<T>;
  }

  async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
    return Promise.all(txs.map((tx) => this.signTransaction(tx)));
  }
}

/** Singleton wallet adapter instance for Orca/Anchor contexts. */
export function getWalletAdapter(): RemoteSignerWallet {
  return new RemoteSignerWallet();
}
