import dotenv from 'dotenv';
import path from 'path';

// Load signer-specific .env if it exists (for non-secret config like RPC URL)
dotenv.config({ path: path.resolve(__dirname, '.env') });
dotenv.config(); // fallback to project root

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Signer: missing required env var: ${name}`);
  return value;
}

// Private key is set at runtime after password decryption — never plaintext on disk
let _privateKey = '';

/** Called by index.ts after decrypting with password */
export function setPrivateKey(key: string): void {
  _privateKey = key;
}

export const signerConfig = {
  // Private key (base58) — decrypted at runtime from keyfile.enc.json
  get privateKey(): string {
    return _privateKey;
  },

  // Unix socket path
  socketPath: process.env.SIGNER_SOCKET_PATH || '/tmp/byreal-signer.sock',

  // RPC URL for simulation (signer uses its own RPC, not shared with bot)
  rpcUrl: requireEnv('SIGNER_RPC_URL'),

  // Program allowlist — only these program IDs are allowed in transactions
  programAllowlist: new Set([
    // DEX programs
    process.env.BYREAL_PROGRAM_ID || 'REALQqNEomY6cQGZJUGwywTBD2UmDT32rZcNnfxQ5N2',
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpool
    'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // Meteora DLMM
    'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', // Meteora DAMM v2
    'HpNfyc2Saw7RKkQd8nEL4khUcuPhQ7WwY1B2qjx8jxFq', // PancakeSwap CLMM
    'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter v6

    // System programs
    '11111111111111111111111111111111', // System Program
    'ComputeBudget111111111111111111111111111111', // Compute Budget
    'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', // Memo
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token Account
    'AddressLookupTab1e1111111111111111111111111', // Address Lookup Table (v0 TXs)

    // Metaplex (used by Orca for position NFT metadata)
    'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s',

    // Jupiter route programs (common intermediaries)
    'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY', // Phoenix
    'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX', // Serum/OpenBook
    'opnb2LAfJYbRMAHHvqjCwQxanZn7ReEHp1k81EQMQvR', // OpenBook v2
    'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD', // Marinade
    'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
    'RVKd61ztZW9GUwhRbbLoYVRE5Xf1B2tVscKqwZqXgEr', // Raydium CPMM
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca (also in Jupiter routes)
    'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // Meteora (also in Jupiter routes)
    'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', // Meteora pools
    'DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt99MQ59qw1', // Orca v1 token swap
    'SSwpkEEcbUqx4vtoEByFjSkhKdCT862DNVb52nZg1UZ', // Saber
    'DecZY86MU5Gj7kppfUCEmd4LbXXuyZH1yHaP2NTqdiZB', // Saber Decimal Wrapper
    'MERLuDFBMmsHnsBPZw2sDQZHvXFMwp8EdjudcU2HKky', // Mercurial
    'SSwapUtytfBdBn1b9NUGG6foMVPtcWgpRU32HToDUZr', // Orca Token Swap v2
    'So1endDq2YkqhipRh3WViPa8hFMqshtxtZTV7LJHZ1K', // Solend
    'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ', // Pump.fun Fee (suspected) — CPI'd by pump AMM routes via Jupiter
  ]),

  // Destination whitelist — addresses that may receive token transfers
  // (e.g. DAC transfer destination, cold wallet)
  destinationWhitelist: new Set(
    (process.env.SIGNER_DEST_WHITELIST || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  ),

  // Unlock page — HTTP port for password entry via dashboard proxy (0 = disabled, stdin only)
  // Always binds to 127.0.0.1 — only accessible via dashboard proxy, never exposed externally
  unlockPort: parseInt(process.env.SIGNER_UNLOCK_PORT || '3848'),

  // Log level
  logLevel: (process.env.SIGNER_LOG_LEVEL || 'info') as 'debug' | 'info' | 'warn' | 'error',
};
