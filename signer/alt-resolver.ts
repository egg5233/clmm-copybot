import {
  Connection,
  PublicKey,
  AddressLookupTableAccount,
  VersionedTransaction,
} from '@solana/web3.js';

/**
 * Resolve Address Lookup Tables in a VersionedTransaction.
 * Returns the full list of account keys after ALT expansion.
 */
export async function resolveALTs(
  connection: Connection,
  tx: VersionedTransaction,
): Promise<PublicKey[]> {
  const message = tx.message;
  const lookups = message.addressTableLookups;

  // No ALTs — just return static keys
  if (!lookups || lookups.length === 0) {
    return message.staticAccountKeys;
  }

  // Fetch all ALT accounts
  const altKeys = lookups.map((l) => l.accountKey);
  const altAccounts = await connection.getMultipleAccountsInfo(altKeys);

  const resolvedLookupTables: AddressLookupTableAccount[] = [];
  for (let i = 0; i < altKeys.length; i++) {
    const account = altAccounts[i];
    if (!account) {
      throw new Error(`ALT account not found: ${altKeys[i].toBase58()}`);
    }
    const lookupTable = new AddressLookupTableAccount({
      key: altKeys[i],
      state: AddressLookupTableAccount.deserialize(account.data),
    });
    resolvedLookupTables.push(lookupTable);
  }

  // Use getAccountKeys() with resolved lookup tables for full expansion
  const accountKeys = message.getAccountKeys({
    addressLookupTableAccounts: resolvedLookupTables,
  });

  const result: PublicKey[] = [];
  for (let i = 0; i < accountKeys.length; i++) {
    result.push(accountKeys.get(i)!);
  }

  return result;
}

/**
 * Extract program IDs from a transaction's instructions.
 * Must be called AFTER ALT resolution to get correct program IDs for v0 TXs.
 */
export function extractProgramIds(allKeys: PublicKey[], tx: VersionedTransaction): PublicKey[] {
  const message = tx.message;
  const programIds = new Set<string>();

  for (const ix of message.compiledInstructions) {
    const programId = allKeys[ix.programIdIndex];
    if (programId) programIds.add(programId.toBase58());
  }

  return Array.from(programIds).map((id) => new PublicKey(id));
}
