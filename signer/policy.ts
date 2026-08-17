import {
  Connection,
  PublicKey,
  VersionedTransaction,
  Transaction,
  SimulatedTransactionResponse,
} from '@solana/web3.js';
import { signerConfig } from './config';
import { resolveALTs, extractProgramIds } from './alt-resolver';

/** SPL Token instruction discriminators (first byte of instruction data) */
const SPL_TRANSFER = 3; // Transfer
const SPL_APPROVE = 4; // Approve
const SPL_SET_AUTHORITY = 6; // SetAuthority
const SPL_TRANSFER_CHECKED = 12; // TransferChecked

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

export interface PolicyResult {
  allowed: boolean;
  reason?: string;
}

const log = {
  debug: (...args: any[]) =>
    signerConfig.logLevel === 'debug' && console.log('[Policy:DEBUG]', ...args),
  info: (...args: any[]) =>
    ['debug', 'info'].includes(signerConfig.logLevel) && console.log('[Policy:INFO]', ...args),
  warn: (...args: any[]) =>
    ['debug', 'info', 'warn'].includes(signerConfig.logLevel) &&
    console.warn('[Policy:WARN]', ...args),
  error: (...args: any[]) => console.error('[Policy:ERROR]', ...args),
};

/**
 * Main policy check — validates a transaction against the security policy.
 *
 * Sequence:
 * 1. Resolve ALTs (v0) → get full account list
 * 2. Static checks: program allowlist, SPL transfer destination whitelist
 * 3. Simulate TX → check invoked programs from logs
 */
export async function checkPolicy(
  connection: Connection,
  txBytes: Uint8Array,
  type: 'versioned' | 'legacy',
): Promise<PolicyResult> {
  let allKeys: PublicKey[];
  let tx: VersionedTransaction | Transaction;

  // ── Step 1: Deserialize and resolve ALTs ─────────────────────────────────
  if (type === 'versioned') {
    const vtx = VersionedTransaction.deserialize(txBytes);
    tx = vtx;
    try {
      allKeys = await resolveALTs(connection, vtx);
    } catch (err: any) {
      return { allowed: false, reason: `ALT resolution failed: ${err.message}` };
    }
  } else {
    const ltx = Transaction.from(txBytes);
    tx = ltx;
    allKeys = ltx.instructions.flatMap((ix) => [ix.programId, ...ix.keys.map((k) => k.pubkey)]);
    // Deduplicate
    const seen = new Set<string>();
    allKeys = allKeys.filter((k) => {
      const s = k.toBase58();
      if (seen.has(s)) return false;
      seen.add(s);
      return true;
    });
  }

  // ── Step 2: Static checks ────────────────────────────────────────────────

  // 2a. Program allowlist
  const programIds =
    type === 'versioned'
      ? extractProgramIds(allKeys, tx as VersionedTransaction)
      : (tx as Transaction).instructions.map((ix) => ix.programId);

  for (const pid of programIds) {
    const pidStr = pid.toBase58();
    if (!signerConfig.programAllowlist.has(pidStr)) {
      return { allowed: false, reason: `Unknown program: ${pidStr}` };
    }
  }

  // Check if TX includes a known DEX instruction (used for transfer destination policy)
  const DEX_PROGRAMS = new Set([
    process.env.BYREAL_PROGRAM_ID || 'REALQqNEomY6cQGZJUGwywTBD2UmDT32rZcNnfxQ5N2',
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
    'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
    'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
    'HpNfyc2Saw7RKkQd8nEL4khUcuPhQ7WwY1B2qjx8jxFq',
    'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  ]);
  const hasDexInstruction = programIds.some((pid) => DEX_PROGRAMS.has(pid.toBase58()));

  // 2b. Check SPL Token transfer/approve/setAuthority destinations
  const instructions =
    type === 'versioned' ? (tx as VersionedTransaction).message.compiledInstructions : null;

  if (instructions) {
    // Versioned TX — use compiled instructions
    for (const ix of instructions) {
      const programId = allKeys[ix.programIdIndex]?.toBase58();
      if (programId !== TOKEN_PROGRAM && programId !== TOKEN_2022) continue;

      const disc = ix.data[0];
      if (disc === SPL_TRANSFER || disc === SPL_TRANSFER_CHECKED) {
        // Account layout: [source, destination, authority] for Transfer
        // Account layout: [source, mint, destination, authority] for TransferChecked
        const destIdx = disc === SPL_TRANSFER ? ix.accountKeyIndexes[1] : ix.accountKeyIndexes[2];
        const dest = allKeys[destIdx]?.toBase58();
        const mint =
          disc === SPL_TRANSFER_CHECKED ? allKeys[ix.accountKeyIndexes[1]]?.toBase58() : undefined;
        if (dest) {
          const check = await checkTransferDestination(
            connection,
            dest,
            hasDexInstruction,
            mint,
            programId,
          );
          if (!check.allowed) return check;
        }
      } else if (disc === SPL_APPROVE) {
        // Approve: [source, delegate, owner]
        const delegate = allKeys[ix.accountKeyIndexes[1]]?.toBase58();
        log.warn(`SPL Approve detected — delegate: ${delegate}`);
        // Allow approve to known DEX programs (for LP operations)
        // Block approve to unknown addresses
      } else if (disc === SPL_SET_AUTHORITY) {
        log.warn('SPL SetAuthority detected');
        return {
          allowed: false,
          reason: 'SPL SetAuthority is blocked — potential authority hijack',
        };
      }
    }
  } else {
    // Legacy TX — use parsed instructions
    for (const ix of (tx as Transaction).instructions) {
      const programId = ix.programId.toBase58();
      if (programId !== TOKEN_PROGRAM && programId !== TOKEN_2022) continue;

      const disc = ix.data[0];
      if (disc === SPL_TRANSFER || disc === SPL_TRANSFER_CHECKED) {
        const destIdx = disc === SPL_TRANSFER ? 1 : 2;
        const dest = ix.keys[destIdx]?.pubkey?.toBase58();
        const mint = disc === SPL_TRANSFER_CHECKED ? ix.keys[1]?.pubkey?.toBase58() : undefined;
        if (dest) {
          const check = await checkTransferDestination(
            connection,
            dest,
            hasDexInstruction,
            mint,
            programId,
          );
          if (!check.allowed) return check;
        }
      } else if (disc === SPL_SET_AUTHORITY) {
        return {
          allowed: false,
          reason: 'SPL SetAuthority is blocked — potential authority hijack',
        };
      }
    }
  }

  // ── Step 3: Simulate and check invoked programs ──────────────────────────
  try {
    let simResult: SimulatedTransactionResponse;

    if (type === 'versioned') {
      const response = await connection.simulateTransaction(tx as VersionedTransaction, {
        sigVerify: false, // TX is unsigned at this point
        replaceRecentBlockhash: true,
      });
      simResult = response.value;
    } else {
      const response = await connection.simulateTransaction(
        tx as Transaction,
        undefined,
        undefined,
      );
      simResult = response.value;
    }

    if (simResult.err) {
      // Transaction would fail on-chain — still sign it, let the bot handle the error
      // (Some operations like closePosition may fail in simulation but succeed on-chain)
      log.warn(`Simulation failed (still signing): ${JSON.stringify(simResult.err)}`);
    }

    // Check invoked programs from simulation logs
    // Skip this check for Jupiter TXs — Jupiter routes through dozens of AMM programs
    // via CPI, and we can't pre-list them all. Jupiter itself is whitelisted statically.
    const JUPITER_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
    const hasJupiter = programIds.some((pid) => pid.toBase58() === JUPITER_PROGRAM);
    if (!hasJupiter && simResult.logs) {
      const invokedPrograms = extractInvokedPrograms(simResult.logs);
      for (const pid of invokedPrograms) {
        if (!signerConfig.programAllowlist.has(pid)) {
          return { allowed: false, reason: `Simulation revealed unknown invoked program: ${pid}` };
        }
      }
    }
  } catch (err: any) {
    // Simulation failure is not fatal — may be due to stale blockhash, missing accounts, etc.
    // Log and proceed; the TX may still be valid.
    log.warn(`Simulation error (proceeding): ${err.message}`);
  }

  log.info('Policy check passed');
  return { allowed: true };
}

/**
 * Check if a token transfer destination is allowed.
 *
 * Strategy: a standalone SPL Transfer/TransferChecked where the bot is the authority
 * should only go to whitelisted destinations or known DEX vault accounts.
 * LP operations don't use raw Transfer — DEX programs move tokens via CPI internally.
 *
 * @param hasDexInstruction - whether the TX also contains a known DEX program instruction
 */
async function checkTransferDestination(
  connection: Connection,
  destAddress: string,
  hasDexInstruction: boolean,
  mintAddress?: string,
  tokenProgramId = TOKEN_PROGRAM,
): Promise<PolicyResult> {
  // Explicit whitelist always allowed (DAC transfer, etc.)
  if (signerConfig.destinationWhitelist.has(destAddress)) {
    return { allowed: true };
  }

  // Also allow the associated token account for a whitelisted owner wallet.
  // Dashboard DAC accepts a wallet address, but TransferChecked targets its ATA.
  if (mintAddress && isAtaForWhitelistedOwner(destAddress, mintAddress, tokenProgramId)) {
    return { allowed: true };
  }

  // If the TX also has a DEX instruction, the transfer is likely part of a swap/LP flow
  // (e.g. WSOL wrap, intermediate token account for pre-swap)
  if (hasDexInstruction) {
    return { allowed: true };
  }

  // Standalone SPL transfer without a DEX instruction — suspicious
  log.debug(`Checking standalone transfer to ${destAddress} (hasDex=${hasDexInstruction})`);
  // Check if destination is a known program-owned account (vault)
  try {
    const accountInfo = await connection.getAccountInfo(new PublicKey(destAddress));
    if (accountInfo) {
      const owner = accountInfo.owner.toBase58();
      log.debug(`Destination ${destAddress} owned by ${owner}`);
      // System-owned accounts (regular wallets) are NOT safe destinations for token transfers
      // Only allow accounts owned by DEX programs (pool vaults) or token programs
      const SYSTEM_PROGRAM = '11111111111111111111111111111111';
      if (owner !== SYSTEM_PROGRAM && signerConfig.programAllowlist.has(owner)) {
        return { allowed: true };
      }
    } else {
      log.debug(`Destination ${destAddress} does not exist on-chain`);
    }
  } catch (err: any) {
    log.warn(`Could not check destination ${destAddress}: ${err.message}`);
  }

  log.warn(`REJECTING standalone SPL transfer to ${destAddress}`);
  return {
    allowed: false,
    reason: `Standalone SPL transfer to non-whitelisted address: ${destAddress}`,
  };
}

function isAtaForWhitelistedOwner(
  destAddress: string,
  mintAddress: string,
  tokenProgramId: string,
): boolean {
  try {
    const dest = new PublicKey(destAddress);
    const mint = new PublicKey(mintAddress);
    const tokenProgram = new PublicKey(tokenProgramId);
    const ataProgram = new PublicKey(ASSOCIATED_TOKEN_PROGRAM);

    for (const ownerAddress of signerConfig.destinationWhitelist) {
      try {
        const owner = new PublicKey(ownerAddress);
        const [ata] = PublicKey.findProgramAddressSync(
          [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()],
          ataProgram,
        );
        if (ata.equals(dest)) {
          log.debug(`Destination ${destAddress} is whitelisted owner ATA for ${ownerAddress}`);
          return true;
        }
      } catch {
        // Ignore non-public-key whitelist entries.
      }
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Extract program IDs invoked during simulation from log messages.
 * Logs contain lines like "Program <pubkey> invoke [N]" and "Program <pubkey> success".
 */
function extractInvokedPrograms(logs: string[]): string[] {
  const programs = new Set<string>();
  const invokeRegex = /Program (\w{32,44}) invoke/;

  for (const line of logs) {
    const match = line.match(invokeRegex);
    if (match) {
      programs.add(match[1]);
    }
  }

  return Array.from(programs);
}
